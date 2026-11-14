import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import { unregisterBatchAdapter } from '../channels/registry';
import { CAMPAIGN_CHANNELS } from '../channels/settings';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from '../templates/registry';
import { type DispatchDeps, runDispatchCycle } from './dispatch';
import {
  type Clock,
  campaignSnapshot,
  createClock,
  dispatchDeps,
  drain,
  insertRunningCampaign,
  NO_VIOLATIONS,
  pushMembers,
  reapAt,
  recordingAdapter,
  settlement,
  statuses,
  testClockBackoff,
  USER,
} from './dispatch.test-helpers';
import { CHANNEL_ERROR_BACKOFF_MS } from './recipients';

const SECOND_MS = 1000;
const OUTAGE_MS = 60_000;
const SOURCE_RETRY_MS = 30_000;
const SLOW_LOOKUP_MS = 2000;
const RETRY_AFTER_MS = 30_000;
const STORM_MS = 5 * 60_000;
const RECIPIENTS = 50;
// Ten seconds of tokens per claim: ten recipients a cycle, so the campaign spans several cycles.
const RATE_PER_SECOND = 1;
const MAX_CYCLES = 200;
const UNREACHABLE_RECIPIENTS = 10;
// More cycles than MAX_SEND_ATTEMPTS, so a spent attempt per cycle would fail every row.
const UNREACHABLE_CYCLES = 6;

let project = '';
let clock: Clock;

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
  project = `outage-${randomUUID()}`;
  clock = createClock();
});

afterEach(() => {
  for (const channel of CAMPAIGN_CHANNELS) {
    unregisterBatchAdapter(channel);
  }
});

async function pushCampaign(members: FakeMember[], projectId = project) {
  return await insertRunningCampaign({
    project: projectId,
    channel: 'push',
    recipients: members.map((member) => member.id),
    now: clock.now(),
    settings: { ratePerSecond: RATE_PER_SECOND },
  });
}

async function cycleUntilSent(deps: DispatchDeps, campaignId: string) {
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    await runDispatchCycle(deps);
    if (((await statuses(campaignId)).sent ?? 0) > 0) {
      return;
    }
  }
  throw new Error('nothing was ever sent');
}

describe('outages', () => {
  it('a provider refusing connections for six cycles spends no attempt and fails nobody; after recovery each profile is sent once', async () => {
    const members = pushMembers(UNREACHABLE_RECIPIENTS);
    let refusing = true;
    let refusedBatches = 0;
    const deliveries = recordingAdapter('push', {
      beforeSend: () => {
        refusedBatches += refusing ? 1 : 0;
      },
      outcome: (item) =>
        refusing
          ? { profileId: item.profileId, outcome: 'retry', reason: 'not_sent' }
          : { profileId: item.profileId, outcome: 'sent' },
    });
    const id = await insertRunningCampaign({
      project,
      channel: 'push',
      recipients: members.map((member) => member.id),
      now: clock.now(),
    });
    const deps = dispatchDeps(createFakeSource({ members }), clock);

    for (let cycle = 0; cycle < UNREACHABLE_CYCLES; cycle++) {
      await runDispatchCycle(deps);
      clock.advance(CHANNEL_ERROR_BACKOFF_MS);
    }

    expect(refusedBatches).toBe(UNREACHABLE_CYCLES);
    const rows = await sql.$queryRawUnsafe<
      { status: string; attempt: number }[]
    >(
      'SELECT status, attempt FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid',
      id
    );
    expect(
      rows.every((row) => row.status === 'pending' && row.attempt === 0)
    ).toBe(true);
    const held = await campaignSnapshot(id);
    expect(held.state).toBe('running');
    expect(held.dispatch_error).toBe('channel_unreachable');
    expect(held.dispatch_retry_at).not.toBeNull();
    expect(held.failed).toBe(0);

    refusing = false;
    await drain(deps, clock);

    const state = await campaignSnapshot(id);
    expect(state.state).toBe('completed');
    expect(state.dispatch_error).toBeNull();
    expect(
      (await settlement(id, UNREACHABLE_RECIPIENTS, deliveries)).violations
    ).toEqual(NO_VIOLATIONS);
    expect(await statuses(id)).toEqual({ sent: UNREACHABLE_RECIPIENTS });
  });

  it('the audience API failing for 60 s (fake clock) mid-campaign: dispatch_error source_unavailable, no failed mark, no duplicate, completes after recovery', async () => {
    const members = pushMembers(RECIPIENTS);
    const deliveries = recordingAdapter('push');
    let downFrom = Number.POSITIVE_INFINITY;
    let refusedLookups = 0;
    const isDown = () => {
      const down = clock.ms() >= downFrom && clock.ms() < downFrom + OUTAGE_MS;
      refusedLookups += down ? 1 : 0;
      return down;
    };
    const id = await pushCampaign(members);
    const deps = dispatchDeps(
      createFakeSource({ members, down: isDown }),
      clock
    );

    await cycleUntilSent(deps, id);
    const sentBefore = deliveries.length;
    expect(sentBefore).toBeLessThan(RECIPIENTS);
    downFrom = clock.ms();

    expect((await runDispatchCycle(deps)).claimed).toBeGreaterThan(0);
    let state = await campaignSnapshot(id);
    expect(state.dispatch_error).toBe('source_unavailable');
    expect(state.dispatch_retry_at?.getTime()).toBe(
      clock.ms() + SOURCE_RETRY_MS
    );
    expect(state.failed).toBe(0);
    expect(await statuses(id)).toEqual({
      sent: sentBefore,
      pending: RECIPIENTS - sentBefore,
    });
    expect(deliveries).toHaveLength(sentBefore);

    // Still down at the first retry, healthy at the second.
    clock.advance(SOURCE_RETRY_MS);
    const refusedBefore = refusedLookups;
    expect((await runDispatchCycle(deps)).claimed).toBeGreaterThan(0);
    expect(refusedLookups).toBe(refusedBefore + 1);
    expect(deliveries).toHaveLength(sentBefore);
    state = await campaignSnapshot(id);
    expect(state.dispatch_error).toBe('source_unavailable');
    expect(state.dispatch_retry_at?.getTime()).toBe(
      clock.ms() + SOURCE_RETRY_MS
    );

    await drain(deps, clock);

    state = await campaignSnapshot(id);
    expect(state.state).toBe('completed');
    expect(state.dispatch_error).toBeNull();
    expect(state.failed).toBe(0);
    expect(deliveries).toHaveLength(RECIPIENTS);
    expect((await settlement(id, RECIPIENTS, deliveries)).violations).toEqual(
      NO_VIOLATIONS
    );
    expect(await statuses(id)).toEqual({ sent: RECIPIENTS });
  });

  it('the API at 2 s per lookup: no lease expires, no timeout, completes', async () => {
    const members = pushMembers(RECIPIENTS);
    let late = 0;
    const deliveries = recordingAdapter('push', {
      beforeSend: (_items, opts) => {
        const pastDeadline =
          opts.deadlineAt !== undefined && clock.ms() >= opts.deadlineAt;
        if (pastDeadline || opts.signal?.aborted) {
          late += 1;
        }
      },
    });
    const id = await pushCampaign(members);
    const deps = dispatchDeps(
      createFakeSource({
        members,
        pageDelayMs: SLOW_LOOKUP_MS,
        sleep: clock.sleep,
        now: clock.ms,
      }),
      clock
    );

    let lookupsAt = clock.ms();
    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      const result = await runDispatchCycle(deps);
      // Reaping after every cycle on the same clock: any expired lease would show here.
      const reaped = await reapAt(deps);
      expect([reaped.released, reaped.uncertain]).toEqual([0, 0]);
      if (result.campaignId === null) {
        break;
      }
      if (result.claimed > 0) {
        expect(clock.ms() - lookupsAt).toBeGreaterThanOrEqual(SLOW_LOOKUP_MS);
        lookupsAt = clock.ms();
      }
    }

    expect(late).toBe(0);
    const state = await campaignSnapshot(id);
    expect(state.state).toBe('completed');
    expect(state.uncertain).toBe(0);
    expect((await settlement(id, RECIPIENTS, deliveries)).violations).toEqual(
      NO_VIOLATIONS
    );
    expect(await statuses(id)).toEqual({ sent: RECIPIENTS });
  });

  it('a 429 storm on whatsapp delays only whatsapp: a push campaign of another project keeps sending', async () => {
    const whatsappProject = project;
    const pushProject = `outage-push-${randomUUID()}`;
    const phones: FakeMember[] = Array.from({ length: RECIPIENTS }, (_, i) => ({
      id: `w-${i}`,
      values: {},
      contact: { phone: `+9198${String(i).padStart(8, '0')}` },
    }));
    const members = pushMembers(RECIPIENTS);
    const stormUntil = clock.ms() + STORM_MS;
    let rejected = 0;
    const whatsappDeliveries = recordingAdapter('whatsapp', {
      outcome: (item) => {
        if (clock.ms() < stormUntil) {
          rejected += 1;
          return {
            profileId: item.profileId,
            outcome: 'rate_limited',
            retryAfterMs: RETRY_AFTER_MS,
          };
        }
        return { profileId: item.profileId, outcome: 'sent' };
      },
    });
    const pushDeliveries = recordingAdapter('push');
    const template = await createTemplateRegistry({
      sql,
      now: clock.now,
    }).create(
      { projectId: whatsappProject, userId: USER },
      {
        channel: 'whatsapp',
        displayName: 'Offer',
        category: 'service',
        providerRef: { templateName: 'promo', namespace: 'ns', language: 'en' },
        approvedText: 'Hello there',
        variables: [],
      }
    );
    const whatsappId = await insertRunningCampaign({
      project: whatsappProject,
      channel: 'whatsapp',
      recipients: phones.map((member) => member.id),
      now: clock.now(),
      template: { templateId: template.templateId },
      templateVersion: 1,
    });
    const pushId = await pushCampaign(members, pushProject);
    const backoff = testClockBackoff(clock);
    const sources = {
      forProject: async (projectId: string) =>
        createFakeSource({
          members: projectId === pushProject ? members : phones,
        }),
      invalidate: () => undefined,
    };
    const deps = dispatchDeps(null, clock, { backoff, sources });

    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      if ((await campaignSnapshot(pushId)).state === 'completed') {
        break;
      }
      const result = await runDispatchCycle(deps);
      if (result.campaignId === null) {
        clock.advance(SECOND_MS);
      }
    }

    expect(clock.ms()).toBeLessThan(stormUntil);
    expect(pushDeliveries).toHaveLength(RECIPIENTS);
    expect(
      (await settlement(pushId, RECIPIENTS, pushDeliveries)).violations
    ).toEqual(NO_VIOLATIONS);
    expect(rejected).toBeGreaterThan(0);
    expect(whatsappDeliveries).toHaveLength(0);
    const held = await campaignSnapshot(whatsappId);
    expect(held.state).toBe('running');
    expect(held.failed).toBe(0);
    expect(await statuses(whatsappId)).toEqual({ pending: RECIPIENTS });
    // The wait is the provider's: the campaign says so instead of looking stalled.
    expect(held.dispatch_error).toBe('rate_limited');

    clock.moveTo(new Date(stormUntil));
    await drain(deps, clock);

    expect(whatsappDeliveries).toHaveLength(RECIPIENTS);
    expect(
      (await settlement(whatsappId, RECIPIENTS, whatsappDeliveries)).violations
    ).toEqual(NO_VIOLATIONS);
    expect((await campaignSnapshot(whatsappId)).state).toBe('completed');
  });
});
