import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { HttpError } from '../api/http';
import type { FilterTree, Schema } from '../audience/contract';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import { createAudienceStore } from '../audience/store';
import {
  DEFAULT_CHANNEL_SETTINGS,
  putChannelSettings,
} from '../channels/settings';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from '../templates/registry';
import { createChannelReady, pinTemplate } from './channel-ready';
import { createCampaignService, isOneActiveViolation } from './service';

const PROJECT = 'p1';
const CTX = { projectId: PROJECT, userId: 'u1' };
const START = new Date('2026-11-03T10:00:00.000Z');
const PRO: FilterTree = { dimension: 'plan', op: 'eq', values: ['pro'] };
const SCHEMA: Schema = {
  dimensions: [
    {
      key: 'plan',
      label: 'Plan',
      type: 'string',
      multiValued: false,
      valuesListable: true,
    },
  ],
};
const THRESHOLD = 5000;
const CFG = { confirmThreshold: THRESHOLD } as MarketingConfig;
const MINUTE_MS = 60_000;
const PREVIEW_TTL_MINUTES = 15;
const TEST_SENDS_PER_HOUR = 10;
const LOCK_POLL_MS = 20;
const PUSH_TEMPLATE = { subject: 'Hi', body: 'Hello {{profile.name}}' };

let now = START;
let members: FakeMember[] = [];

const pad = (n: number) => String(n).padStart(6, '0');
const proMembers = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `pro-${pad(i + 1)}`,
    values: { plan: 'pro' },
  }));

type ServiceDeps = Parameters<typeof createCampaignService>[0];

function makeDeps(
  channelReady?: ServiceDeps['channelReady'],
  pin?: ServiceDeps['pinTemplate']
) {
  const fake = createFakeSource({ members, schema: SCHEMA });
  const source = async (projectId: string) =>
    projectId === PROJECT ? fake : null;
  const audiences = createAudienceStore({ sql, source, now: () => now });
  const campaigns = createCampaignService({
    sql,
    cfg: CFG,
    audiences,
    source,
    now: () => now,
    channelReady,
    pinTemplate: pin,
  });
  return { audiences, campaigns };
}

const templates = createTemplateRegistry({ sql, now: () => now });
const SMS_TEMPLATE = {
  channel: 'sms' as const,
  displayName: 'Welcome',
  category: 'service' as const,
  providerRef: { flowId: 'abc123' },
  approvedText: 'Hi {#var#}',
  variables: [{ slot: 'var1', value: '{{profile.firstName}}' }],
};
const SMS_RATE = 5;

// A configured sms channel, an enabled template and a previewed sms campaign using it.
async function previewedSmsDraft() {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, 'sms', 'x')`,
    PROJECT
  );
  await putChannelSettings(
    sql,
    PROJECT,
    'sms',
    { ...DEFAULT_CHANNEL_SETTINGS.sms, ratePerSecond: SMS_RATE },
    0
  );
  const template = await templates.create(CTX, SMS_TEMPLATE);
  const { campaigns, audiences } = makeDeps(
    createChannelReady({ sql, registry: templates }),
    pinTemplate
  );
  const audience = await dynamicAudience(audiences);
  const draft = await campaigns.create(CTX, {
    name: 'Text',
    channel: 'sms',
    template: { templateId: template.templateId },
    audienceId: audience.id,
  });
  await campaigns.countPreview(CTX, draft.id);
  return { campaigns, template, draft };
}

async function caught(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  if (!(error instanceof HttpError)) {
    throw new Error(`expected an HttpError, got ${String(error)}`);
  }
  return error;
}

const codeOf = async (promise: Promise<unknown>) => {
  const error = await caught(promise);
  return [error.status, error.code];
};

async function dynamicAudience(audiences = makeDeps().audiences) {
  return await audiences.create(CTX, {
    name: 'Pro',
    mode: 'dynamic',
    filter: PRO,
    excludeFilter: null,
  });
}

async function pushDraft(audienceId: string | null, name = 'Launch') {
  return await makeDeps().campaigns.create(CTX, {
    name,
    channel: 'push',
    template: PUSH_TEMPLATE,
    audienceId,
  });
}

async function previewedDraft(name = 'Launch') {
  const { campaigns, audiences } = makeDeps();
  const audience = await dynamicAudience(audiences);
  const draft = await pushDraft(audience.id, name);
  await campaigns.countPreview(CTX, draft.id);
  return { campaigns, audiences, audience, draft };
}

async function insertRecipients(campaignId: string, statuses: string[]) {
  for (const [i, status] of statuses.entries()) {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status)
       VALUES ($1::uuid, $2, $3, $4)`,
      campaignId,
      `r${i}`,
      PROJECT,
      status
    );
  }
}

// Gives the leased rows a live lease, as a dispatcher holding them would.
async function leaseLeasedRows(campaignId: string) {
  await sql.$executeRawUnsafe(
    `UPDATE marketing.campaign_recipients SET lease_token = gen_random_uuid(), lease_until = now() + interval '1 minute'
     WHERE campaign_id = $1::uuid AND status = 'leased'`,
    campaignId
  );
}

async function leasedSkippedRows(campaignId: string): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid AND status = 'skipped' AND (lease_token IS NOT NULL OR lease_until IS NOT NULL)`,
    campaignId
  );
  return row?.n ?? 0;
}

async function recipients(campaignId: string) {
  return await sql.$queryRawUnsafe<
    { profile_id: string; status: string; reason: string | null }[]
  >(
    `SELECT profile_id, status, reason FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid ORDER BY profile_id`,
    campaignId
  );
}

// A materialiser's staging rows are keyed by the campaign id.
async function stageExclusion(campaignId: string) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.materialize_exclusions (job_id, profile_id) VALUES ($1::uuid, 'x1')`,
    campaignId
  );
}

async function stagedCount(jobId: string): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM marketing.materialize_exclusions WHERE job_id = $1::uuid',
    jobId
  );
  return row?.n ?? 0;
}

async function setState(campaignId: string, state: string, extra = '') {
  await sql.$executeRawUnsafe(
    `UPDATE marketing.campaigns SET state = $2 ${extra} WHERE id = $1::uuid`,
    campaignId,
    state
  );
}

async function waitingOnLock(): Promise<boolean> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'`
  );
  return (row?.n ?? 0) > 0;
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
  now = START;
  members = proMembers(30);
});

describe('campaign service', () => {
  it('create ignores a client-sent confirm_threshold', async () => {
    const { campaigns } = makeDeps();
    const row = await campaigns.create(CTX, {
      name: 'Launch',
      channel: 'push',
      template: PUSH_TEMPLATE,
      confirmThreshold: 1,
      confirm_threshold: 1,
    } as never);
    expect(row).toMatchObject({
      state: 'draft',
      confirmThreshold: THRESHOLD,
      timezone: 'Asia/Kolkata',
      ifLateMinutes: 60,
      version: 1,
      counters: { queued: 0, sent: 0, failed: 0, skipped: 0, uncertain: 0 },
    });
  });

  it('create checks the template against the channel', async () => {
    const { campaigns } = makeDeps();
    expect(
      await codeOf(
        campaigns.create(CTX, {
          name: 'Text',
          channel: 'sms',
          template: PUSH_TEMPLATE,
        } as never)
      )
    ).toEqual([400, 'invalid_campaign']);
    const sms = await campaigns.create(CTX, {
      name: 'Text',
      channel: 'sms',
      template: { templateId: 'otp' },
    });
    expect(sms.template).toEqual({ templateId: 'otp' });
  });

  it('update edits a draft, bumps its version and checks expectedVersion', async () => {
    const { campaigns } = makeDeps();
    const draft = await pushDraft(null);
    const updated = await campaigns.update(
      CTX,
      draft.id,
      { name: 'Renamed', ifLateMinutes: 30 },
      1
    );
    expect([updated.name, updated.ifLateMinutes, updated.version]).toEqual([
      'Renamed',
      30,
      2,
    ]);
    expect(
      await codeOf(campaigns.update(CTX, draft.id, { name: 'Again' }, 1))
    ).toEqual([409, 'version_conflict']);
    expect(
      await codeOf(campaigns.update(CTX, draft.id, { channel: 'sms' }, 2))
    ).toEqual([400, 'invalid_campaign']);
  });

  it('updating a scheduled campaign is not_draft', async () => {
    const { campaigns } = makeDeps();
    const draft = await pushDraft(null);
    await setState(draft.id, 'scheduled');
    expect(
      await codeOf(campaigns.update(CTX, draft.id, { name: 'x' }, 1))
    ).toEqual([409, 'not_draft']);
    expect(await codeOf(campaigns.remove(CTX, draft.id))).toEqual([
      409,
      'not_draft',
    ]);
  });

  it('remove deletes a draft; another project cannot see it', async () => {
    const { campaigns } = makeDeps();
    const draft = await pushDraft(null);
    const other = { projectId: 'p2', userId: 'u2' };
    expect(await codeOf(campaigns.get(other, draft.id))).toEqual([
      404,
      'not_found',
    ]);
    expect(await campaigns.list(other)).toEqual([]);
    expect((await campaigns.list(CTX)).map((row) => row.id)).toEqual([
      draft.id,
    ]);
    await campaigns.remove(CTX, draft.id);
    expect(await codeOf(campaigns.get(CTX, draft.id))).toEqual([
      404,
      'not_found',
    ]);
  });

  it('start without an audience is missing_audience', async () => {
    const { campaigns } = makeDeps();
    const draft = await pushDraft(null);
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'missing_audience',
    ]);
  });

  it('start without a preview is count_preview_required', async () => {
    const { campaigns } = makeDeps();
    const audience = await dynamicAudience();
    const draft = await pushDraft(audience.id);
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'count_preview_required',
    ]);
  });

  it('start after editing the campaign or the audience since the preview is count_preview_required', async () => {
    const { campaigns, audiences, audience, draft } = await previewedDraft();
    await campaigns.update(CTX, draft.id, { name: 'Edited' }, 1);
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'count_preview_required',
    ]);

    await campaigns.countPreview(CTX, draft.id);
    await audiences.update(
      CTX,
      audience.id,
      { name: 'Pro 2', mode: 'dynamic', filter: PRO, excludeFilter: null },
      1
    );
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'count_preview_required',
    ]);

    await campaigns.countPreview(CTX, draft.id);
    now = new Date(START.getTime() + (PREVIEW_TTL_MINUTES + 1) * MINUTE_MS);
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'count_preview_required',
    ]);
  });

  it('a preview of 5,000 starts without confirm', async () => {
    members = proMembers(THRESHOLD);
    const { campaigns, audience, draft } = await previewedDraft();
    expect((await campaigns.get(CTX, draft.id)).countPreview).toMatchObject({
      count: THRESHOLD,
      campaignVersion: 1,
      audienceVersion: 1,
    });
    const started = await campaigns.start(CTX, draft.id, {});
    expect(started).toMatchObject({
      state: 'running',
      sendKind: 'now',
      startedAt: START.toISOString(),
      audienceVersion: audience.version,
      materializeState: 'not_started',
    });
    const [counters] = await sql.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM marketing.campaign_counters WHERE campaign_id = $1::uuid',
      draft.id
    );
    expect(counters?.n).toBe(1);
  });

  it('a preview of 5,001 needs confirm {5001, push}; a wrong count or channel is confirmation_mismatch', async () => {
    members = proMembers(THRESHOLD + 1);
    const { campaigns, draft } = await previewedDraft();
    const required = await caught(campaigns.start(CTX, draft.id, {}));
    expect([required.status, required.code, required.details]).toEqual([
      409,
      'confirmation_required',
      { count: THRESHOLD + 1, channel: 'push' },
    ]);
    expect(
      await codeOf(
        campaigns.start(CTX, draft.id, {
          confirm: { count: THRESHOLD, channel: 'push' },
        })
      )
    ).toEqual([409, 'confirmation_mismatch']);
    expect(
      await codeOf(
        campaigns.start(CTX, draft.id, {
          confirm: { count: THRESHOLD + 1, channel: 'email' },
        })
      )
    ).toEqual([409, 'confirmation_mismatch']);
    const started = await campaigns.start(CTX, draft.id, {
      confirm: { count: THRESHOLD + 1, channel: 'push' },
    });
    expect(started.state).toBe('running');
  });

  it('sms start is channel_not_ready by default', async () => {
    const { campaigns } = makeDeps();
    const audience = await dynamicAudience();
    const sms = await campaigns.create(CTX, {
      name: 'Text',
      channel: 'sms',
      template: { templateId: 'otp' },
      audienceId: audience.id,
    });
    expect(await codeOf(campaigns.start(CTX, sms.id, {}))).toEqual([
      409,
      'channel_not_ready',
    ]);
    const hooked = makeDeps(async () => 'template_not_approved').campaigns;
    expect(await codeOf(hooked.start(CTX, sms.id, {}))).toEqual([
      409,
      'template_not_approved',
    ]);
  });

  it('a snapshot audience edited after freeze is audience_snapshot_stale', async () => {
    const { audiences, campaigns } = makeDeps();
    const snapshotInput = {
      name: 'Frozen',
      mode: 'snapshot' as const,
      filter: PRO,
      excludeFilter: null,
    };
    const audience = await audiences.create(CTX, snapshotInput);
    const draft = await pushDraft(audience.id);
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'audience_snapshot_stale',
    ]);
    await audiences.freeze(CTX, audience.id);
    expect(await campaigns.countPreview(CTX, draft.id)).toMatchObject({
      count: 30,
      approximate: false,
    });
    await audiences.update(CTX, audience.id, snapshotInput, 1);
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'audience_snapshot_stale',
    ]);
  });

  it('an audience whose filter no longer fits the live schema is invalid_filter', async () => {
    const { campaigns, draft } = await previewedDraft();
    const audience = (await campaigns.get(CTX, draft.id)).audienceId;
    await sql.$executeRawUnsafe(
      `UPDATE marketing.audiences SET filter = '{"dimension":"gone","op":"eq","values":["x"]}'::jsonb WHERE id = $1::uuid`,
      audience
    );
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'invalid_filter',
    ]);
  });

  it('start while another campaign of the project runs queues it as scheduled with send_kind now', async () => {
    const first = await previewedDraft('First');
    await first.campaigns.start(CTX, first.draft.id, {});
    const second = await pushDraft(first.audience.id, 'Second');
    await first.campaigns.countPreview(CTX, second.id);
    now = new Date(START.getTime() + MINUTE_MS);
    const queued = await first.campaigns.start(CTX, second.id, {});
    expect(queued).toMatchObject({
      state: 'scheduled',
      sendKind: 'now',
      sendAt: now.toISOString(),
      startedAt: null,
    });
  });

  it('pause then resume returns to running; a paused campaign keeps the project slot', async () => {
    const { campaigns, audience, draft } = await previewedDraft();
    await campaigns.start(CTX, draft.id, {});
    expect((await campaigns.pause(CTX, draft.id)).state).toBe('paused');
    const other = await pushDraft(audience.id, 'Other');
    await campaigns.countPreview(CTX, other.id);
    expect((await campaigns.start(CTX, other.id, {})).state).toBe('scheduled');
    expect((await campaigns.resume(CTX, draft.id)).state).toBe('running');
    expect(await codeOf(campaigns.resume(CTX, draft.id))).toEqual([
      409,
      'invalid_transition',
    ]);
  });

  it('resume clears a dispatch wait computed before the pause', async () => {
    const { campaigns, draft } = await previewedDraft();
    await campaigns.start(CTX, draft.id, {});
    await campaigns.pause(CTX, draft.id);
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET dispatch_retry_at = now() + interval '1 day', dispatch_error = 'quota_exhausted'
       WHERE id = $1::uuid`,
      draft.id
    );
    const resumed = await campaigns.resume(CTX, draft.id);
    expect(resumed.state).toBe('running');
    expect(resumed.dispatchError).toBeNull();
    const [row] = await sql.$queryRawUnsafe<
      { dispatch_retry_at: Date | null }[]
    >(
      'SELECT dispatch_retry_at FROM marketing.campaigns WHERE id = $1::uuid',
      draft.id
    );
    expect(row?.dispatch_retry_at).toBeNull();
  });

  it('unschedule returns a queued campaign to draft', async () => {
    const first = await previewedDraft('First');
    await first.campaigns.start(CTX, first.draft.id, {});
    const second = await pushDraft(first.audience.id, 'Second');
    await first.campaigns.countPreview(CTX, second.id);
    await first.campaigns.start(CTX, second.id, {});
    expect(await first.campaigns.unschedule(CTX, second.id)).toMatchObject({
      state: 'draft',
      sendKind: null,
      sendAt: null,
    });
  });

  it('cancel marks pending and leased recipients skipped with reason cancelled and leaves sending rows', async () => {
    const { campaigns, draft } = await previewedDraft();
    await campaigns.start(CTX, draft.id, {});
    await insertRecipients(draft.id, ['pending', 'leased', 'sending', 'sent']);
    await leaseLeasedRows(draft.id);
    await stageExclusion(draft.id);
    const cancelled = await campaigns.cancel(CTX, draft.id);
    expect(await leasedSkippedRows(draft.id)).toBe(0);
    expect(await stagedCount(draft.id)).toBe(0);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.finishedAt).toBe(START.toISOString());
    expect(cancelled.counters.skipped).toBe(2);
    expect(await recipients(draft.id)).toEqual([
      { profile_id: 'r0', status: 'skipped', reason: 'cancelled' },
      { profile_id: 'r1', status: 'skipped', reason: 'cancelled' },
      { profile_id: 'r2', status: 'sending', reason: null },
      { profile_id: 'r3', status: 'sent', reason: null },
    ]);
  });

  it('skipPreviousRecipients without a campaignKey is invalid_campaign on create and update', async () => {
    const { campaigns } = makeDeps();
    const fields = {
      name: 'Launch',
      channel: 'push' as const,
      template: PUSH_TEMPLATE,
    };
    expect(
      await codeOf(
        campaigns.create(CTX, { ...fields, skipPreviousRecipients: true })
      )
    ).toEqual([400, 'invalid_campaign']);

    const plain = await campaigns.create(CTX, fields);
    expect(
      await codeOf(
        campaigns.update(
          CTX,
          plain.id,
          { skipPreviousRecipients: true },
          plain.version
        )
      )
    ).toEqual([400, 'invalid_campaign']);

    const keyed = await campaigns.create(CTX, {
      ...fields,
      campaignKey: 'launch',
      skipPreviousRecipients: true,
    });
    expect(
      await codeOf(
        campaigns.update(CTX, keyed.id, { campaignKey: null }, keyed.version)
      )
    ).toEqual([400, 'invalid_campaign']);
  });

  it('cancel on completed is invalid_transition', async () => {
    const { campaigns } = makeDeps();
    const draft = await pushDraft(null);
    await setState(draft.id, 'completed');
    expect(await codeOf(campaigns.cancel(CTX, draft.id))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'invalid_transition',
    ]);
  });

  it('schedule 2026-11-10T09:00 Asia/Kolkata stores send_at 03:30Z', async () => {
    const { campaigns, draft } = await previewedDraft();
    const updated = await campaigns.update(
      CTX,
      draft.id,
      { sendAtLocal: '2026-11-10T09:00' },
      1
    );
    await campaigns.countPreview(CTX, updated.id);
    expect(await campaigns.schedule(CTX, draft.id, {})).toMatchObject({
      state: 'scheduled',
      sendKind: 'scheduled',
      sendAt: '2026-11-10T03:30:00.000Z',
      sendAtLocal: '2026-11-10T09:00',
    });
  });

  it('schedule without a send time is invalid_send_time, before the preview gate', async () => {
    const { campaigns } = makeDeps();
    const audience = await dynamicAudience();
    const draft = await pushDraft(audience.id);
    expect(await codeOf(campaigns.schedule(CTX, draft.id, {}))).toEqual([
      400,
      'invalid_send_time',
    ]);
  });

  it('schedule in the past is schedule_in_past, before the preview gate', async () => {
    const { campaigns } = makeDeps();
    const audience = await dynamicAudience();
    const draft = await pushDraft(audience.id);
    await campaigns.update(
      CTX,
      draft.id,
      { sendAtLocal: '2026-11-03T15:29' },
      1
    );
    expect(await codeOf(campaigns.schedule(CTX, draft.id, {}))).toEqual([
      409,
      'schedule_in_past',
    ]);
  });

  it('the 11th test send in an hour is test_send_limit', async () => {
    const { campaigns } = makeDeps();
    const draft = await pushDraft(null);
    expect(await codeOf(campaigns.requestTestSend(CTX, draft.id, ''))).toEqual([
      400,
      'invalid_profile_id',
    ]);
    for (let i = 0; i < TEST_SENDS_PER_HOUR; i++) {
      const { id } = await campaigns.requestTestSend(CTX, draft.id, 'me');
      expect(id).toBeString();
    }
    expect(
      await codeOf(campaigns.requestTestSend(CTX, draft.id, 'me'))
    ).toEqual([429, 'test_send_limit']);
    now = new Date(START.getTime() + 61 * MINUTE_MS);
    await campaigns.requestTestSend(CTX, draft.id, 'me');
    const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM marketing.campaign_test_sends
       WHERE campaign_id = $1::uuid AND status = 'pending' AND project_id = $2 AND requested_by = 'u1'`,
      draft.id,
      PROJECT
    );
    expect(row?.n).toBe(TEST_SENDS_PER_HOUR + 1);
  });

  it('completeIfDone completes only when nothing is pending, leased or sending', async () => {
    const { campaigns, draft } = await previewedDraft();
    await campaigns.start(CTX, draft.id, {});
    await insertRecipients(draft.id, ['sent', 'failed']);
    expect(await campaigns.completeIfDone(draft.id)).toBe(false);
    await setState(draft.id, 'running', ", materialize_state = 'done'");
    for (const status of ['pending', 'leased', 'sending']) {
      await sql.$executeRawUnsafe(
        `UPDATE marketing.campaign_recipients SET status = $2 WHERE campaign_id = $1::uuid AND profile_id = 'r1'`,
        draft.id,
        status
      );
      expect(await campaigns.completeIfDone(draft.id)).toBe(false);
    }
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaign_recipients SET status = 'failed' WHERE campaign_id = $1::uuid`,
      draft.id
    );
    expect(await campaigns.completeIfDone(draft.id)).toBe(true);
    expect(await campaigns.get(CTX, draft.id)).toMatchObject({
      state: 'completed',
      finishedAt: START.toISOString(),
    });
    expect(await campaigns.completeIfDone(draft.id)).toBe(false);
  });

  it('failCampaign fails a running campaign and skips its pending and leased recipients with reason failed', async () => {
    const { campaigns, draft } = await previewedDraft();
    await campaigns.start(CTX, draft.id, {});
    await insertRecipients(draft.id, ['pending', 'leased', 'sending']);
    await leaseLeasedRows(draft.id);
    await stageExclusion(draft.id);
    await campaigns.failCampaign(draft.id, 'materialize_failed');
    expect(await leasedSkippedRows(draft.id)).toBe(0);
    expect(await stagedCount(draft.id)).toBe(0);
    const failed = await campaigns.get(CTX, draft.id);
    expect(failed).toMatchObject({
      state: 'failed',
      stateReason: 'materialize_failed',
    });
    expect(failed.counters.skipped).toBe(2);
    expect(await recipients(draft.id)).toEqual([
      { profile_id: 'r0', status: 'skipped', reason: 'failed' },
      { profile_id: 'r1', status: 'skipped', reason: 'failed' },
      { profile_id: 'r2', status: 'sending', reason: null },
    ]);
  });

  it('failCampaign on a terminal campaign leaves its recipients alone', async () => {
    const { campaigns, draft } = await previewedDraft();
    await insertRecipients(draft.id, ['pending']);
    await setState(draft.id, 'completed');
    await campaigns.failCampaign(draft.id, 'materialize_failed');
    expect((await campaigns.get(CTX, draft.id)).state).toBe('completed');
    expect((await recipients(draft.id))[0]?.status).toBe('pending');
  });

  it('countPreview is refused once a campaign runs and keeps the stored preview', async () => {
    const { campaigns, draft } = await previewedDraft();
    await campaigns.start(CTX, draft.id, {});
    const before = (await campaigns.get(CTX, draft.id)).countPreview;
    now = new Date(START.getTime() + MINUTE_MS);
    expect(await codeOf(campaigns.countPreview(CTX, draft.id))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect((await campaigns.get(CTX, draft.id)).countPreview).toEqual(before);
  });

  it('requestTestSend on a terminal campaign is invalid_transition', async () => {
    const { campaigns } = makeDeps();
    const draft = await pushDraft(null);
    await campaigns.requestTestSend(CTX, draft.id, 'me');
    await setState(draft.id, 'cancelled');
    expect(
      await codeOf(campaigns.requestTestSend(CTX, draft.id, 'me'))
    ).toEqual([409, 'invalid_transition']);
  });

  it('an audience of another project is missing_audience at start', async () => {
    const { campaigns, draft } = await previewedDraft();
    await sql.$executeRawUnsafe(
      `UPDATE marketing.audiences SET project_id = 'p2' WHERE id = (SELECT audience_id FROM marketing.campaigns WHERE id = $1::uuid)`,
      draft.id
    );
    expect(await codeOf(campaigns.start(CTX, draft.id, {}))).toEqual([
      409,
      'missing_audience',
    ]);
  });

  it('only a one-active-index violation counts as the project being busy', () => {
    const violation = (code: string, message: string) => ({
      meta: { code, message },
    });
    expect(
      isOneActiveViolation(
        violation('23505', 'Key (project_id)=(p1) already exists.')
      )
    ).toBe(true);
    expect(
      isOneActiveViolation(violation('23505', 'Key (id)=(x) already exists.'))
    ).toBe(false);
    expect(
      isOneActiveViolation(
        violation('23514', 'Key (project_id)=(p1) already exists.')
      )
    ).toBe(false);
    expect(isOneActiveViolation(new Error('boom'))).toBe(false);
  });

  it('an audience edit committed while start waits for the audience lock makes start count_preview_required', async () => {
    const { campaigns, audience, draft } = await previewedDraft();
    let start: Promise<HttpError> | undefined;
    await sql.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT 1 FROM marketing.audiences WHERE id = $1::uuid FOR UPDATE',
        audience.id
      );
      await tx.$executeRawUnsafe(
        'UPDATE marketing.audiences SET version = version + 1 WHERE id = $1::uuid',
        audience.id
      );
      start = caught(campaigns.start(CTX, draft.id, {}));
      while (!(await waitingOnLock())) {
        await Bun.sleep(LOCK_POLL_MS);
      }
    });
    const error = await (start as Promise<HttpError>);
    expect([error.status, error.code]).toEqual([409, 'count_preview_required']);
    expect((await campaigns.get(CTX, draft.id)).state).toBe('draft');
  });

  it('start pins template_version to the current version', async () => {
    const { campaigns, template, draft } = await previewedSmsDraft();
    expect(draft.templateVersion).toBeNull();
    await templates.update(CTX, template.templateId, SMS_TEMPLATE, 1);
    const started = await campaigns.start(CTX, draft.id, {});
    expect(started).toMatchObject({ state: 'running', templateVersion: 2 });
  });

  it('a template disabled between the gate and the pin answers its readiness code', async () => {
    const { draft, template } = await previewedSmsDraft();
    const racing = makeDeps(async () => null, pinTemplate).campaigns;
    await templates.setEnabled(CTX, template.templateId, false);
    expect(await codeOf(racing.start(CTX, draft.id, {}))).toEqual([
      409,
      'template_unavailable',
    ]);
    const hooked = makeDeps(
      createChannelReady({ sql, registry: templates }),
      pinTemplate
    ).campaigns;
    expect(await codeOf(hooked.start(CTX, draft.id, {}))).toEqual([
      409,
      'template_disabled',
    ]);
    expect((await hooked.get(CTX, draft.id)).state).toBe('draft');
  });

  it('editing the template after start leaves the campaign on its pinned version', async () => {
    const { campaigns, template, draft } = await previewedSmsDraft();
    await campaigns.start(CTX, draft.id, {});
    await templates.update(
      CTX,
      template.templateId,
      { ...SMS_TEMPLATE, approvedText: 'Hello {#var#}' },
      1
    );
    expect((await campaigns.get(CTX, draft.id)).templateVersion).toBe(1);
  });

  it('disabling the template after start does not stop the campaign', async () => {
    const { campaigns, template, draft } = await previewedSmsDraft();
    await campaigns.start(CTX, draft.id, {});
    await templates.setEnabled(CTX, template.templateId, false);
    expect(await campaigns.get(CTX, draft.id)).toMatchObject({
      state: 'running',
      templateVersion: 1,
    });
  });

  it('a queued start leaves template_version for the scheduler to pin', async () => {
    const first = await previewedDraft('First');
    await first.campaigns.start(CTX, first.draft.id, {});
    const { campaigns, draft } = await previewedSmsDraft();
    const queued = await campaigns.start(CTX, draft.id, {});
    expect(queued).toMatchObject({ state: 'scheduled', templateVersion: null });
  });
});

describe('email quota gate', () => {
  const QUOTA = 10;
  const MEMBERS = 30;
  const EXPECTED_DAYS = 3;

  async function emailDraft(dailyQuota: number) {
    await putChannelSettings(
      sql,
      PROJECT,
      'email',
      {
        ...DEFAULT_CHANNEL_SETTINGS.email,
        ratePerSecond: 5,
        dailyQuota,
        quotaTimezone: 'UTC',
      },
      0
    );
    const { campaigns, audiences } = makeDeps();
    const audience = await dynamicAudience(audiences);
    const draft = await campaigns.create(CTX, {
      name: 'Mail',
      channel: 'email',
      template: PUSH_TEMPLATE,
      audienceId: audience.id,
    });
    await campaigns.countPreview(CTX, draft.id);
    return { campaigns, draft };
  }

  it('a start over the remaining quota without spreadOverDays is quota_spread_required; with it, it starts', async () => {
    const { campaigns, draft } = await emailDraft(QUOTA);
    const error = await caught(campaigns.start(CTX, draft.id, {}));
    expect([error.status, error.code, error.details]).toEqual([
      409,
      'quota_spread_required',
      { count: MEMBERS, remainingToday: QUOTA, daysNeeded: EXPECTED_DAYS },
    ]);
    const started = await campaigns.start(CTX, draft.id, {
      confirm: { count: MEMBERS, channel: 'email', spreadOverDays: true },
    });
    expect(started.state).toBe('running');
  });

  it('a schedule with a valid future send time over the remaining quota is quota_spread_required', async () => {
    const { campaigns, draft } = await emailDraft(QUOTA);
    await campaigns.update(
      CTX,
      draft.id,
      { sendAtLocal: '2026-11-10T09:00' },
      1
    );
    await campaigns.countPreview(CTX, draft.id);
    const error = await caught(campaigns.schedule(CTX, draft.id, {}));
    expect([error.status, error.code, error.details]).toEqual([
      409,
      'quota_spread_required',
      { count: MEMBERS, remainingToday: QUOTA, daysNeeded: EXPECTED_DAYS },
    ]);
    const scheduled = await campaigns.schedule(CTX, draft.id, {
      confirm: { count: MEMBERS, channel: 'email', spreadOverDays: true },
    });
    expect(scheduled.state).toBe('scheduled');
  });

  it('a start within the remaining quota needs no spreadOverDays', async () => {
    const { campaigns, draft } = await emailDraft(MEMBERS);
    expect((await campaigns.start(CTX, draft.id, {})).state).toBe('running');
  });

  it('exposes dispatchRetryAt only while dispatchError is set', async () => {
    const { campaigns, draft } = await previewedDraft();
    const stamp = '2026-11-03 11:00:00+00';
    await sql.$executeRawUnsafe(
      'UPDATE marketing.campaigns SET dispatch_retry_at = $2::timestamptz WHERE id = $1::uuid',
      draft.id,
      stamp
    );
    expect(await campaigns.get(CTX, draft.id)).toMatchObject({
      dispatchError: null,
      dispatchRetryAt: null,
    });
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET dispatch_error = 'quota_exhausted' WHERE id = $1::uuid`,
      draft.id
    );
    expect(await campaigns.get(CTX, draft.id)).toMatchObject({
      dispatchError: 'quota_exhausted',
      dispatchRetryAt: '2026-11-03T11:00:00.000Z',
    });
  });
});
