import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { encryptCredential } from '@openpanel/shared/server';
import type { FakeMember } from '../audience/fake-source';
import { createFakeSource } from '../audience/fake-source';
import {
  createClock,
  dispatchDeps,
  drain,
  ENCRYPTION_KEY,
  insertRunningCampaign,
} from '../campaign/dispatch.test-helpers';
import { retryUncertain } from '../campaign/operator';
import {
  claimRecipients,
  markLeasedFinal,
  markOutcomes,
  markSending,
  reapExpiredLeases,
  SENDING_LEASE_MS,
} from '../campaign/recipients';
import { perRecipientBatch } from '../channels/batch';
import { createFakeFcm } from '../channels/fakes/fcm';
import { createPushAdapter } from '../channels/push';
import {
  registerBatchAdapter,
  unregisterBatchAdapter,
} from '../channels/registry';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { type EffectiveCap, ledgerRef, recordLedger } from '../engine/ledger';
import { MARK_SQL } from '../engine/ticker';

const PROJECT = 'p1';
const NOW = new Date('2026-11-03T10:00:00.000Z');
const HOUR_MS = 3_600_000;
const LEASE_MS = 120_000;
const RULE_ID = '00000000-0000-0000-0000-0000000000b1';
const CAP_ONE_PER_DAY: EffectiveCap = {
  max: 1,
  periodSeconds: 86_400,
  scope: 'channel',
};
const FAKE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'tracking-test',
  client_email: 'tracking@tracking-test.example.test',
  private_key: 'not-a-real-key',
});
const CANARY_EMAIL = 'tracking-canary@example.test';
const CANARY_PHONE = '919999900002';
const CANARY_NAME = 'Tracking Canary';
const CANARY_STATE = 'ZZ-tracking-state';
const CANARY_TOKEN = 'canary-tracking-token';
const CANARIES = [
  CANARY_EMAIL,
  CANARY_PHONE,
  CANARY_NAME,
  CANARY_STATE,
  CANARY_TOKEN,
];
// A value stored as bytes shows up hex or base64 encoded in row_to_json.
const CANARY_FORMS = CANARIES.flatMap((canary) => [
  canary.toLowerCase(),
  Buffer.from(canary).toString('hex'),
  Buffer.from(canary).toString('base64'),
]);
const BAD_TOKEN_SUFFIX = '-bad';
const REJECT_CODE = 'messaging/invalid-argument';

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

interface TrackingRow {
  source_ref: string;
  project_id: string;
  profile_id: string;
  channel: string | null;
  campaign_id: string | null;
  rule_id: string | null;
  step_index: number | null;
  status: string;
  reason: string | null;
  provider_ref: string | null;
  sent_at: Date;
  accepted_at: Date | null;
  failed_at: Date | null;
}

async function tracking(): Promise<Map<string, TrackingRow>> {
  const rows = await sql.$queryRawUnsafe<TrackingRow[]>(
    `SELECT source_ref, project_id, profile_id, channel, campaign_id::text, rule_id::text, step_index,
       status, reason, provider_ref, sent_at, accepted_at, failed_at
     FROM marketing.message_tracking`
  );
  return new Map(rows.map((row) => [row.source_ref, row]));
}

async function trackingOf(ref: string): Promise<TrackingRow> {
  const found = (await tracking()).get(ref);
  if (!found) {
    throw new Error(`no tracking row ${ref}`);
  }
  return found;
}

async function insertCampaign(channel = 'push'): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by, materialize_state)
     VALUES ($1::uuid, $2, 'c', 'running', $3, '{}'::jsonb, 5000, 'u', 'done')`,
    id,
    PROJECT,
    channel
  );
  return id;
}

async function insertRecipients(campaignId: string, profileIds: string[]) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, due_at)
     SELECT $1::uuid, p, $2, $3::timestamptz FROM unnest($4::text[]) AS p`,
    campaignId,
    PROJECT,
    NOW.toISOString(),
    profileIds
  );
}

function claim(campaignId: string, now = NOW) {
  return claimRecipients(sql, {
    campaignId,
    limit: 500,
    now,
    leaseMs: LEASE_MS,
  });
}

function send(
  campaignId: string,
  token: string,
  profileIds: string[],
  cap: EffectiveCap | null = null,
  now = NOW
) {
  return markSending(sql, {
    campaignId,
    projectId: PROJECT,
    channel: 'push',
    token,
    profileIds,
    now,
    cap,
  });
}

async function toSending(campaignId: string, now = NOW): Promise<string> {
  const claimed = await claim(campaignId, now);
  await send(campaignId, claimed.token, claimed.profileIds, null, now);
  return claimed.token;
}

function outcome(
  campaignId: string,
  token: string,
  profileId: string,
  kind: 'sent' | 'uncertain' | 'failed',
  now: Date,
  extra: { reason?: string; providerRef?: string } = {}
) {
  return markOutcomes(sql, {
    campaignId,
    token,
    outcomes: [{ profileId, outcome: kind, ...extra }],
    now,
    retryAt: now,
  });
}

async function insertStep(
  snapshot: unknown,
  stepIndex: number,
  enrollmentId: string = randomUUID()
): Promise<{ enrollmentId: string }> {
  if (stepIndex === 0) {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, match_value, status, trigger_time)
       VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, 'u1', '', 'active', $5::timestamptz)`,
      enrollmentId,
      PROJECT,
      RULE_ID,
      JSON.stringify(snapshot),
      NOW.toISOString()
    );
  }
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status, attempt, lease_until)
     VALUES ($1::uuid, $2, $3::timestamptz, 'sending', 1, $3::timestamptz)`,
    enrollmentId,
    stepIndex,
    NOW.toISOString()
  );
  return { enrollmentId };
}

function markStep(
  enrollmentId: string,
  stepIndex: number,
  status: 'sent' | 'failed' | 'skipped',
  reason: string | null,
  sentAt: Date | null
) {
  return sql.$queryRawUnsafe(
    MARK_SQL,
    enrollmentId,
    stepIndex,
    1,
    status,
    JSON.stringify(reason ? { reason } : {}),
    sentAt?.toISOString() ?? null
  );
}

describe('message tracking triggers', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);
  afterEach(() => unregisterBatchAdapter('push'));

  it('a sent recipient gets a tracking row with accepted_at and provider_ref', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const token = await toSending(id);
    expect((await tracking()).size).toBe(0);

    await outcome(id, token, 'a', 'sent', at(1000), { providerRef: 'req-1' });

    expect(await trackingOf(`campaign:${id}:a`)).toMatchObject({
      project_id: PROJECT,
      profile_id: 'a',
      channel: 'push',
      campaign_id: id,
      rule_id: null,
      step_index: null,
      status: 'sent',
      reason: null,
      provider_ref: 'req-1',
      sent_at: at(1000),
      accepted_at: at(1000),
      failed_at: null,
    });
  });

  it('a capped recipient is tracked as skipped', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b']);
    await recordLedger(sql, [
      {
        sourceRef: ledgerRef.step(randomUUID(), 0),
        projectId: PROJECT,
        profileId: 'b',
        channel: 'push',
        sentAt: at(-HOUR_MS),
      },
    ]);
    const claimed = await claim(id);
    await send(id, claimed.token, claimed.profileIds, CAP_ONE_PER_DAY);

    const rows = await tracking();
    expect([...rows.keys()]).toEqual([`campaign:${id}:b`]);
    expect(rows.get(`campaign:${id}:b`)).toMatchObject({
      status: 'skipped',
      reason: 'capped',
      accepted_at: null,
      sent_at: NOW,
    });
  });

  it('a lookup skip is tracked as skipped with its reason', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b']);
    const claimed = await claim(id);
    await markLeasedFinal(sql, claimed.token, 'skipped', [
      { profileId: 'a', reason: 'suppressed' },
    ]);
    await markLeasedFinal(sql, claimed.token, 'failed', [
      { profileId: 'b', reason: 'render_failed' },
    ]);

    expect(await trackingOf(`campaign:${id}:a`)).toMatchObject({
      status: 'skipped',
      reason: 'suppressed',
      accepted_at: null,
    });
    expect(await trackingOf(`campaign:${id}:b`)).toMatchObject({
      status: 'failed',
      reason: 'render_failed',
      accepted_at: null,
    });
  });

  it('a reaped sending recipient is tracked as uncertain', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    await toSending(id);
    await reapExpiredLeases(sql, at(SENDING_LEASE_MS + 1));

    expect(await trackingOf(`campaign:${id}:a`)).toMatchObject({
      status: 'uncertain',
      reason: 'lease_expired',
      accepted_at: null,
    });
  });

  it('an operator retry of an uncertain recipient that then sends moves the row to sent and moves sent_at', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const first = await toSending(id);
    await outcome(id, first, 'a', 'uncertain', at(1000), {
      reason: 'network',
      providerRef: 'req-old',
    });
    const ref = `campaign:${id}:a`;
    expect(await trackingOf(ref)).toMatchObject({
      status: 'uncertain',
      reason: 'network',
      accepted_at: null,
    });

    await retryUncertain(sql, { projectId: PROJECT }, id, at(HOUR_MS));
    const second = await toSending(id, at(HOUR_MS));
    await outcome(id, second, 'a', 'sent', at(HOUR_MS + 1000), {
      providerRef: 'req-new',
    });

    expect(await trackingOf(ref)).toMatchObject({
      status: 'sent',
      reason: null,
      provider_ref: 'req-new',
      sent_at: at(HOUR_MS + 1000),
      accepted_at: at(HOUR_MS + 1000),
    });
  });

  it('a later final status of lower rank never lowers a sent row', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const token = await toSending(id);
    await outcome(id, token, 'a', 'sent', at(1000));
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaign_recipients SET status = 'skipped', reason = 'late' WHERE campaign_id = $1::uuid`,
      id
    );

    expect(await trackingOf(`campaign:${id}:a`)).toMatchObject({
      status: 'sent',
      reason: null,
    });
  });

  it('a journey step marked sent, failed and skipped is tracked with rule_id and step_index', async () => {
    const snapshot = {
      steps: [
        { channel: 'email' },
        { channel: 'push' },
        { channel: 'webhook' },
      ],
    };
    const { enrollmentId } = await insertStep(snapshot, 0);
    await insertStep(snapshot, 1, enrollmentId);
    await insertStep(snapshot, 2, enrollmentId);
    await markStep(enrollmentId, 0, 'sent', null, at(500));
    await markStep(enrollmentId, 1, 'failed', 'smtp 550', null);
    await markStep(enrollmentId, 2, 'skipped', 'quiet_hours', null);

    const rows = await tracking();
    expect(rows.get(`step:${enrollmentId}:0`)).toMatchObject({
      project_id: PROJECT,
      profile_id: 'u1',
      rule_id: RULE_ID,
      step_index: 0,
      channel: 'email',
      campaign_id: null,
      status: 'sent',
      reason: null,
      sent_at: at(500),
      accepted_at: at(500),
    });
    expect(rows.get(`step:${enrollmentId}:1`)).toMatchObject({
      step_index: 1,
      channel: 'push',
      status: 'failed',
      reason: 'smtp 550',
      accepted_at: null,
    });
    expect(rows.get(`step:${enrollmentId}:1`)?.failed_at).not.toBeNull();
    expect(rows.get(`step:${enrollmentId}:2`)).toMatchObject({
      step_index: 2,
      channel: 'webhook',
      status: 'skipped',
      reason: 'quiet_hours',
      accepted_at: null,
    });
  });

  it('a step whose snapshot has no channel still marks and is tracked with channel null', async () => {
    const { enrollmentId } = await insertStep({}, 0);
    await markStep(enrollmentId, 0, 'sent', null, at(500));

    const [step] = await sql.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM marketing.steps WHERE enrollment_id = $1::uuid',
      enrollmentId
    );
    expect(step?.status).toBe('sent');
    expect(await trackingOf(`step:${enrollmentId}:0`)).toMatchObject({
      channel: null,
      status: 'sent',
      rule_id: RULE_ID,
    });
  });

  describe('through the dispatch engine with fake FCM', () => {
    const member = (id: string, token: string): FakeMember => ({
      id,
      values: {},
      displayName: CANARY_NAME,
      contact: { phone: CANARY_PHONE, email: CANARY_EMAIL },
      traits: { firstName: CANARY_NAME, state: CANARY_STATE },
      devices: [{ token, platform: 'android' }],
    });
    const rejectBad = (token: string) =>
      token.endsWith(BAD_TOKEN_SUFFIX) ? REJECT_CODE : null;

    async function runPush(members: FakeMember[]) {
      const clock = createClock();
      registerBatchAdapter(
        perRecipientBatch(
          createPushAdapter({
            sendMulticast: createFakeFcm({ failCode: rejectBad }),
          }),
          clock.ms
        )
      );
      const campaignId = await insertRunningCampaign({
        project: PROJECT,
        channel: 'push',
        recipients: members.map((entry) => entry.id),
        now: clock.now(),
        template: { subject: 'Hi', body: 'Hello {{profile.firstName}}' },
      });
      await sql.$executeRawUnsafe(
        'UPDATE marketing.channel_configs SET config_encrypted = $2 WHERE project_id = $1',
        PROJECT,
        encryptCredential(
          ENCRYPTION_KEY,
          JSON.stringify({ serviceAccountJson: FAKE_SERVICE_ACCOUNT })
        )
      );
      await drain(dispatchDeps(createFakeSource({ members }), clock), clock);
      return campaignId;
    }

    it('a push recipient rejected by fake FCM is tracked as failed with its reason code and accepted_at null', async () => {
      const campaignId = await runPush([
        member('good', 'token-good'),
        member('bad', `token${BAD_TOKEN_SUFFIX}`),
      ]);

      const bad = await trackingOf(`campaign:${campaignId}:bad`);
      expect(bad).toMatchObject({
        status: 'failed',
        accepted_at: null,
        channel: 'push',
      });
      expect(bad.reason).toContain('invalid-argument');
      expect(bad.failed_at).not.toBeNull();
      const good = await trackingOf(`campaign:${campaignId}:good`);
      expect(good).toMatchObject({ status: 'sent', reason: null });
      expect(good.accepted_at).not.toBeNull();
    });

    it('a tracking row never holds a phone, email or token', async () => {
      await runPush([
        member('good', CANARY_TOKEN),
        member('bad', `${CANARY_TOKEN}${BAD_TOKEN_SUFFIX}`),
      ]);
      const { enrollmentId } = await insertStep(
        { steps: [{ channel: 'email' }] },
        0
      );
      await markStep(enrollmentId, 0, 'failed', 'smtp 550', null);

      const rows = await sql.$queryRawUnsafe<{ doc: string }[]>(
        'SELECT lower(row_to_json(t)::text) AS doc FROM marketing.message_tracking t'
      );
      expect(rows.length).toBe(3);
      const leaked = rows.flatMap(({ doc }) =>
        CANARY_FORMS.filter((form) => doc.includes(form.toLowerCase()))
      );
      expect(leaked).toEqual([]);
    });
  });
});
