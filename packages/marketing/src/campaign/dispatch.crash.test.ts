import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createFakeSource } from '../audience/fake-source';
import type { AudienceSource } from '../audience/source';
import type { BatchItem } from '../channels/batch';
import { unregisterBatchAdapter } from '../channels/registry';
import { CAMPAIGN_CHANNELS } from '../channels/settings';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { runDispatchCycle } from './dispatch';
import {
  CFG,
  CLAIM_LEASE_MS,
  type Clock,
  CrashError,
  campaignService,
  campaignSnapshot,
  createClock,
  type Delivery,
  deliveryCounts,
  dispatchDeps,
  drain,
  hookedSql,
  insertRunningCampaign,
  isMarkOutcomes,
  isMarkOutcomesResult,
  NO_VIOLATIONS,
  nextSequence,
  pushMembers,
  reapAt,
  recordingAdapter,
  type SqlHooks,
  settlement,
  statuses,
  USER,
  waitUntil,
} from './dispatch-harness';
import { startDispatchLane } from './dispatch-lane';
import { retryUncertain } from './operator';
import { SENDING_LEASE_MS } from './recipients';

const BIG = process.env.MARKETING_BIG_TESTS === '1';
// Ruling: the full sizes need MARKETING_BIG_TESTS=1; by default the same scenarios run smaller on this machine.
const REPLICA_RECIPIENTS = BIG ? 20_000 : 3000;
const CANCEL_RECIPIENTS = BIG ? 5000 : 1000;
const PAUSE_RECIPIENTS = 300;
const SMALL = 5;
const REPLICAS = 3;
const LOOPS_PER_REPLICA = 2;
const CRASH_EVERY_CYCLES = 100;
const CRASH_AT_CYCLE = 50;
// Claim size is ten seconds of tokens, so these rates make many small cycles.
const REPLICA_RATE_PER_SECOND = 0.5;
const LANE_RATE_PER_SECOND = 10;
const BATCHES_BEFORE_STOP = 3;
const IDLE_MS = 10;
const PAUSED_POLLS = 20;
const SECOND_MS = 1000;
const LONG_TEST_MS = BIG ? 900_000 : 300_000;
const CRASH_KINDS = ['lease', 'before', 'after', 'outcomes'] as const;
type CrashKind = (typeof CRASH_KINDS)[number];

let project = '';
let clock: Clock;
// Abandoned cycles wait on these; settled after each test so nothing outlives it.
let abandoned: (() => void)[] = [];

const ctx = () => ({ projectId: project, userId: USER });
const silenceErrors = () =>
  spyOn(console, 'error').mockImplementation(() => undefined);

function settleAbandoned() {
  for (const settle of abandoned) {
    settle();
  }
  abandoned = [];
}

function abandonedForever(): Promise<never> {
  return new Promise<never>((_, reject) => {
    abandoned.push(() => reject(new CrashError('while leased')));
  });
}

// A lookup that never returns on chosen calls: the cycle holding the lease is gone.
function hangingLookup(
  inner: AudienceSource,
  hangOn: (call: number, ids: string[]) => boolean
): AudienceSource {
  let calls = 0;
  return {
    ...inner,
    lookup: (ids, channel) => {
      calls += 1;
      return hangOn(calls, ids)
        ? abandonedForever()
        : inner.lookup(ids, channel);
    },
  };
}

// The dispatcher's pick is the only statement ordering campaigns by retry time.
const isPick = (text: string) => text.includes('NULLS FIRST');
const ids = (items: BatchItem[]) => items.map((item) => item.profileId);

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
  project = `crash-${randomUUID()}`;
  clock = createClock();
});

afterEach(() => {
  settleAbandoned();
  for (const channel of CAMPAIGN_CHANNELS) {
    unregisterBatchAdapter(channel);
  }
});

async function smallPushCampaign() {
  const members = pushMembers(SMALL);
  const id = await insertRunningCampaign({
    project,
    channel: 'push',
    recipients: members.map((member) => member.id),
    now: clock.now(),
  });
  return { members, id };
}

describe('crashes', () => {
  it('crash after markSending and before the call: rows become uncertain after the lease, nothing is resent, retry-uncertain then sends each once', async () => {
    let crash = true;
    const deliveries = recordingAdapter('push', {
      beforeSend: () => {
        if (crash) {
          throw new CrashError('before the provider call');
        }
      },
    });
    const { members, id } = await smallPushCampaign();
    const deps = dispatchDeps(createFakeSource({ members }), clock);
    const logged = silenceErrors();
    try {
      await runDispatchCycle(deps);
    } finally {
      logged.mockRestore();
    }
    crash = false;
    expect(await statuses(id)).toEqual({ sending: SMALL });

    // Nothing redelivers a sending row, before or after its lease ends.
    expect((await runDispatchCycle(deps)).claimed).toBe(0);
    clock.advance(SENDING_LEASE_MS + SECOND_MS);
    expect(await reapAt(deps)).toMatchObject({
      uncertain: SMALL,
      completed: 1,
    });
    await drain(deps, clock);
    expect(deliveries).toHaveLength(0);
    expect(await statuses(id)).toEqual({ uncertain: SMALL });
    expect((await campaignSnapshot(id)).state).toBe('completed');

    // The operator's retry is the one deliberate re-send: each profile once, in total.
    expect(
      await retryUncertain(sql, { projectId: project }, id, clock.now())
    ).toEqual({ retried: SMALL });
    await drain(deps, clock);
    expect(deliveries).toHaveLength(SMALL);
    expect((await settlement(id, SMALL, deliveries)).violations).toEqual(
      NO_VIOLATIONS
    );
    expect(await statuses(id)).toEqual({ sent: SMALL });
    expect((await campaignSnapshot(id)).state).toBe('completed');
  });

  it('crash after the provider accepted: rows uncertain, the provider counted 1, never 2', async () => {
    let crash = true;
    const deliveries = recordingAdapter('push', {
      afterAccept: () => {
        if (crash) {
          throw new CrashError('after the provider accepted');
        }
      },
    });
    const { members, id } = await smallPushCampaign();
    const deps = dispatchDeps(createFakeSource({ members }), clock);
    const logged = silenceErrors();
    try {
      await runDispatchCycle(deps);
    } finally {
      logged.mockRestore();
    }
    crash = false;
    expect(await statuses(id)).toEqual({ sending: SMALL });

    await drain(deps, clock);

    expect(await statuses(id)).toEqual({ uncertain: SMALL });
    expect([...deliveryCounts(deliveries).values()]).toEqual(
      Array.from({ length: SMALL }, () => 1)
    );
    expect((await settlement(id, SMALL, deliveries)).violations).toEqual(
      NO_VIOLATIONS
    );
    expect((await campaignSnapshot(id)).state).toBe('completed');
  });

  it('crash in the middle of markOutcomes: the outcome rolls back, rows end uncertain, the provider counted 1', async () => {
    let crash = true;
    const deliveries = recordingAdapter('push');
    const { members, id } = await smallPushCampaign();
    const deps = dispatchDeps(createFakeSource({ members }), clock, {
      sql: hookedSql({
        beforeQuery: (text) => {
          if (crash && isMarkOutcomes(text)) {
            crash = false;
            throw new CrashError('inside markOutcomes');
          }
        },
      }),
    });

    await expect(runDispatchCycle(deps)).rejects.toThrow('simulated crash');
    expect(await statuses(id)).toEqual({ sending: SMALL });
    await drain(deps, clock);

    expect(await statuses(id)).toEqual({ uncertain: SMALL });
    expect(deliveries).toHaveLength(SMALL);
    expect((await settlement(id, SMALL, deliveries)).violations).toEqual(
      NO_VIOLATIONS
    );
  });

  it('crash while leased (before markSending): rows return to pending and are sent once', async () => {
    const deliveries = recordingAdapter('push');
    const { members, id } = await smallPushCampaign();
    const source = hangingLookup(
      createFakeSource({ members }),
      (call) => call === 1
    );
    const deps = dispatchDeps(source, clock);

    // The first cycle is abandoned inside its lookup and never awaited.
    runDispatchCycle(deps).catch(() => undefined);
    await waitUntil(
      async () => (await statuses(id)).leased === SMALL,
      'the abandoned claim'
    );
    expect((await runDispatchCycle(deps)).claimed).toBe(0);
    clock.advance(CLAIM_LEASE_MS + SECOND_MS);
    expect(await reapAt(deps)).toMatchObject({ released: SMALL });
    expect(await statuses(id)).toEqual({ pending: SMALL });

    await drain(deps, clock);

    expect(deliveries).toHaveLength(SMALL);
    expect((await settlement(id, SMALL, deliveries)).violations).toEqual(
      NO_VIOLATIONS
    );
    expect(await statuses(id)).toEqual({ sent: SMALL });
    expect((await campaignSnapshot(id)).state).toBe('completed');
  });

  it(
    `three replicas (three lanes, two loops each) over ${REPLICA_RECIPIENTS.toLocaleString('en')} recipients with random crashes in 1% of cycles: no profile delivered twice, sent + uncertain + skipped + failed = ${REPLICA_RECIPIENTS.toLocaleString('en')}`,
    async () => {
      const members = pushMembers(REPLICA_RECIPIENTS);
      const crashing = new Map<string, CrashKind>();
      const crashed: CrashKind[] = [];
      let crashesOn = true;
      let cycles = 0;
      // A crash fires once: the batch's other rows may come back in a later, healthy batch.
      const crashOf = (items: BatchItem[], kind: CrashKind) => {
        const hit = ids(items).some(
          (profileId) => crashing.get(profileId) === kind
        );
        if (hit) {
          for (const profileId of ids(items)) {
            crashing.delete(profileId);
          }
        }
        return hit;
      };
      const deliveries = recordingAdapter('push', {
        beforeSend: (items) => {
          if (crashOf(items, 'before')) {
            throw new CrashError('before the provider call');
          }
        },
        afterAccept: (items) => {
          if (crashOf(items, 'after')) {
            throw new CrashError('after the provider accepted');
          }
        },
      });
      const inner = createFakeSource({ members });
      // Every claimed cycle looks up once: the decision there picks 1% of cycles, rotating through the crash points.
      const source = hangingLookup(inner, (_call, profileIds) => {
        cycles += 1;
        if (!crashesOn || cycles % CRASH_EVERY_CYCLES !== CRASH_AT_CYCLE) {
          return false;
        }
        const kind =
          CRASH_KINDS[crashed.length % CRASH_KINDS.length] ?? 'lease';
        crashed.push(kind);
        for (const profileId of profileIds) {
          crashing.set(profileId, kind);
        }
        return kind === 'lease';
      });
      const id = await insertRunningCampaign({
        project,
        channel: 'push',
        recipients: members.map((member) => member.id),
        now: clock.now(),
        settings: { ratePerSecond: REPLICA_RATE_PER_SECOND },
      });
      const deps = dispatchDeps(source, clock, {
        // Enough source slots that abandoned lookups never starve the live loops.
        cfg: { ...CFG, sourceConcurrency: 16 },
        sql: hookedSql({
          beforeQuery: (text, params) => {
            const batch = params[2];
            if (
              isMarkOutcomes(text) &&
              Array.isArray(batch) &&
              batch.some((profileId) => crashing.get(profileId) === 'outcomes')
            ) {
              for (const profileId of batch) {
                crashing.delete(profileId);
              }
              throw new CrashError('inside markOutcomes');
            }
          },
        }),
      });
      const logged = silenceErrors();
      const lanes = Array.from({ length: REPLICAS }, () =>
        startDispatchLane({
          ...deps,
          concurrency: LOOPS_PER_REPLICA,
          idleMs: IDLE_MS,
          secrets: [],
        })
      );
      try {
        const everyLoopHung = () =>
          abandoned.length >= REPLICAS * LOOPS_PER_REPLICA;
        const claimedOrStuck = async () =>
          everyLoopHung() || !(await statuses(id)).pending;
        // Crashed batches hold leased or sending rows until their leases end; the reaper alone settles them.
        // Only then may the dead cycles finish: the reaper cleared their tokens, so their own release matches nothing.
        while (true) {
          await waitUntil(
            claimedOrStuck,
            'rows claimed or every loop hung',
            LONG_TEST_MS
          );
          const open = await statuses(id);
          if (!(open.pending || open.leased || open.sending)) {
            break;
          }
          crashesOn = crashesOn && Boolean(open.pending);
          clock.advance(CLAIM_LEASE_MS + SECOND_MS);
          await reapAt(deps);
          settleAbandoned();
        }
      } finally {
        settleAbandoned();
        await Promise.all(lanes.map((lane) => lane.stop()));
        logged.mockRestore();
      }
      await reapAt(deps);

      expect(new Set(crashed)).toEqual(new Set(CRASH_KINDS));
      const { violations, rows } = await settlement(
        id,
        REPLICA_RECIPIENTS,
        deliveries
      );
      expect(violations).toEqual(NO_VIOLATIONS);
      const count = (status: string) =>
        rows.filter((row) => row.status === status).length;
      expect(count('uncertain')).toBeGreaterThan(0);
      expect(count('sent')).toBeGreaterThan(0);
      expect((await campaignSnapshot(id)).state).toBe('completed');
    },
    LONG_TEST_MS
  );
});

// Lanes on the real clock, so sent_at and delivery times can be compared with a commit time; pacing sleeps stay fake.
function realTimeLaneDeps(source: AudienceSource, hooks: SqlHooks) {
  return {
    ...dispatchDeps(source, clock, {
      now: () => new Date(),
      sql: hookedSql(hooks),
    }),
    concurrency: LOOPS_PER_REPLICA,
    idleMs: IDLE_MS,
    secrets: [],
  };
}

async function laneCampaign(count: number) {
  const members = pushMembers(count);
  const id = await insertRunningCampaign({
    project,
    channel: 'push',
    recipients: members.map((member) => member.id),
    now: new Date(),
    settings: { ratePerSecond: LANE_RATE_PER_SECOND },
  });
  return { members, id };
}

describe('operator stops', () => {
  it(
    `cancel during a running ${CANCEL_RECIPIENTS.toLocaleString('en')}-recipient send: no row is sent after the cancel's commit`,
    async () => {
      const deliveries: Delivery[] = recordingAdapter('push');
      const { members, id } = await laneCampaign(CANCEL_RECIPIENTS);
      const service = campaignService(null, () => new Date());
      let batches = 0;
      let commitAt = 0;
      let commitSeq = 0;
      // The cancel commits between two batches while the other loop holds a claimed, looked-up batch.
      const lane = startDispatchLane(
        realTimeLaneDeps(createFakeSource({ members }), {
          afterTransaction: async (result) => {
            if (!isMarkOutcomesResult(result)) {
              return;
            }
            batches += 1;
            if (batches === BATCHES_BEFORE_STOP) {
              await service.cancel(ctx(), id);
              commitAt = Date.now();
              commitSeq = nextSequence();
            }
          },
        })
      );
      try {
        await waitUntil(
          async () => (await campaignSnapshot(id)).state === 'cancelled',
          'the cancel'
        );
        await waitUntil(async () => {
          const open = await statuses(id);
          return !(open.pending || open.leased || open.sending);
        }, 'the in-flight cycles to settle');
      } finally {
        await lane.stop();
      }

      expect(deliveries.filter((d) => d.seq > commitSeq)).toEqual([]);
      expect(deliveries.filter((d) => d.at > commitAt)).toEqual([]);
      const { violations, rows } = await settlement(
        id,
        CANCEL_RECIPIENTS,
        deliveries
      );
      expect(violations).toEqual(NO_VIOLATIONS);
      const late = rows.filter(
        (row) => row.sent_at !== null && row.sent_at.getTime() > commitAt
      );
      expect(late).toEqual([]);
      const cancelled = rows.filter(
        (row) => row.status === 'skipped' && row.reason === 'cancelled'
      );
      expect(cancelled.length).toBeGreaterThan(0);
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries.length + cancelled.length).toBe(CANCEL_RECIPIENTS);
    },
    LONG_TEST_MS
  );

  it('pause and resume: nothing is delivered while paused and the rest is delivered once after resume', async () => {
    const deliveries = recordingAdapter('push');
    const { members, id } = await laneCampaign(PAUSE_RECIPIENTS);
    const service = campaignService(null, () => new Date());
    let batches = 0;
    let pausedDeliveries = -1;
    let picksWhilePaused = 0;
    const lane = startDispatchLane(
      realTimeLaneDeps(createFakeSource({ members }), {
        afterTransaction: async (result) => {
          if (!isMarkOutcomesResult(result)) {
            return;
          }
          batches += 1;
          if (batches === 1) {
            await service.pause(ctx(), id);
            pausedDeliveries = deliveries.length;
          }
        },
        // Counts the loops' picks, so "while paused" is measured in dispatch attempts rather than wall time.
        beforeQuery: (text) => {
          if (pausedDeliveries >= 0 && isPick(text)) {
            picksWhilePaused += 1;
          }
        },
      })
    );
    try {
      await waitUntil(
        () => picksWhilePaused >= PAUSED_POLLS,
        'the loops to poll while paused'
      );
      expect((await campaignSnapshot(id)).state).toBe('paused');
      expect(deliveries).toHaveLength(pausedDeliveries);
      await waitUntil(async () => {
        const open = await statuses(id);
        return !(open.leased || open.sending);
      }, 'the in-flight cycles to settle');
      expect(deliveries).toHaveLength(pausedDeliveries);
      const paused = await statuses(id);
      expect(paused.sent).toBe(pausedDeliveries);
      expect(paused.pending).toBe(PAUSE_RECIPIENTS - pausedDeliveries);

      await service.resume(ctx(), id);
      await waitUntil(
        async () => (await campaignSnapshot(id)).state === 'completed',
        'the campaign to complete'
      );
    } finally {
      await lane.stop();
    }

    expect(deliveries).toHaveLength(PAUSE_RECIPIENTS);
    expect(
      (await settlement(id, PAUSE_RECIPIENTS, deliveries)).violations
    ).toEqual(NO_VIOLATIONS);
    expect(await statuses(id)).toEqual({ sent: PAUSE_RECIPIENTS });
  });
});
