import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../api/http';
import {
  DEFAULT_CHANNEL_SETTINGS,
  putChannelSettings,
} from '../channels/settings';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { ledgerRef, recordLedger } from '../engine/ledger';
import { createChannelReady } from './channel-ready';
import {
  estimateCampaign,
  listRecipients,
  listTestSends,
  retryUncertain,
  skipReasons,
} from './operator';
import { claimRecipients, markOutcomes, markSending } from './recipients';
import { createCampaignService } from './service';

const PROJECT = 'p1';
const CTX = { projectId: PROJECT };
const NOW = new Date('2026-11-03T10:00:00.000Z');
const LEASE_MS = 120_000;
const SMS_RATE = 100;
const SMS_PRICE = 0.25;
const SMS_COUNT = 20_000;
const EMAIL_QUOTA = 500;
const EMAIL_USED = 120;
const EMAIL_COUNT = 20_000;
const EXPECTED_SMS_SECONDS = 200;
const EXPECTED_SMS_COST = 5000;
const EXPECTED_EMAIL_DAYS = 41;
const PAGE = 2;

const campaigns = createCampaignService({
  sql,
  cfg: { confirmThreshold: 5000 } as MarketingConfig,
  audiences: {} as never,
  source: async () => null,
  now: () => NOW,
});
const deps = {
  sql,
  campaigns,
  now: () => NOW,
  channelReady: createChannelReady({ sql, registry: {} as never }),
};

async function insertCampaign(
  over: { state?: string; channel?: string; count?: number | null } = {}
): Promise<string> {
  const id = randomUUID();
  const preview =
    over.count === null
      ? null
      : JSON.stringify({ count: over.count ?? 0, campaignVersion: 1 });
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by, materialize_state, count_preview)
     VALUES ($1::uuid, $2, 'c', $3, $4, '{}'::jsonb, 5000, 'u', 'done', $5::jsonb)`,
    id,
    PROJECT,
    over.state ?? 'running',
    over.channel ?? 'push',
    preview
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.campaign_counters (campaign_id) VALUES ($1::uuid)',
    id
  );
  return id;
}

async function insertRecipients(
  campaignId: string,
  entries: { id: string; status: string; reason?: string }[]
) {
  for (const entry of entries) {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status, reason, attempt, due_at)
       VALUES ($1::uuid, $2, $3, $4, $5, 5, $6::timestamptz)`,
      campaignId,
      entry.id,
      PROJECT,
      entry.status,
      entry.reason ?? null,
      new Date(NOW.getTime() + 86_400_000).toISOString()
    );
  }
}

// What the dispatcher leaves behind for an unknown outcome: the row, its counter and its ledger entry.
async function insertUncertain(campaignId: string, profileIds: string[]) {
  await insertRecipients(
    campaignId,
    profileIds.map((id) => ({ id, status: 'uncertain', reason: 'timeout' }))
  );
  await sql.$executeRawUnsafe(
    'UPDATE marketing.campaign_counters SET uncertain = $2 WHERE campaign_id = $1::uuid',
    campaignId,
    profileIds.length
  );
  await recordLedger(
    sql,
    profileIds.map((profileId) => ({
      sourceRef: ledgerRef.campaign(campaignId, profileId),
      projectId: PROJECT,
      profileId,
      channel: 'push',
      sentAt: NOW,
    }))
  );
}

async function counter(campaignId: string, column: string): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    `SELECT ${column}::int AS n FROM marketing.campaign_counters WHERE campaign_id = $1::uuid`,
    campaignId
  );
  return row?.n ?? 0;
}

async function ledgerCount(): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM marketing.send_ledger'
  );
  return row?.n ?? 0;
}

async function stateOf(campaignId: string): Promise<string> {
  const [row] = await sql.$queryRawUnsafe<{ state: string }[]>(
    'SELECT state FROM marketing.campaigns WHERE id = $1::uuid',
    campaignId
  );
  return row?.state ?? '';
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

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetMarketingTables();
});

describe('retryUncertain', () => {
  it('on a completed campaign with 3 uncertain rows reopens it, sends those 3 once and completes again', async () => {
    const id = await insertCampaign({ state: 'completed' });
    await insertUncertain(id, ['a', 'b', 'c']);
    await insertRecipients(id, [{ id: 'd', status: 'sent' }]);

    expect(await retryUncertain(sql, CTX, id)).toEqual({ retried: 3 });

    expect(await stateOf(id)).toBe('running');
    expect(await ledgerCount()).toBe(0);
    expect(await counter(id, 'uncertain')).toBe(0);
    const rows = await sql.$queryRawUnsafe<
      { status: string; reason: string; attempt: number }[]
    >(
      `SELECT status, reason, attempt FROM marketing.campaign_recipients
       WHERE campaign_id = $1::uuid AND profile_id IN ('a', 'b', 'c')`,
      id
    );
    expect(rows).toEqual(
      Array.from({ length: 3 }, () => ({
        status: 'pending',
        reason: 'operator_retry',
        attempt: 0,
      }))
    );

    // The retry stamps due_at with the real clock.
    const later = new Date(Date.now() + LEASE_MS);
    const claimed = await claimRecipients(sql, {
      campaignId: id,
      limit: 500,
      now: later,
      leaseMs: LEASE_MS,
    });
    expect(claimed.profileIds.sort()).toEqual(['a', 'b', 'c']);
    await markSending(sql, {
      campaignId: id,
      projectId: PROJECT,
      channel: 'push',
      token: claimed.token,
      profileIds: claimed.profileIds,
      now: later,
      cap: null,
    });
    await markOutcomes(sql, {
      campaignId: id,
      token: claimed.token,
      outcomes: claimed.profileIds.map((profileId) => ({
        profileId,
        outcome: 'sent' as const,
        providerRef: 'ref',
      })),
      now: later,
      retryAt: later,
    });
    expect(await ledgerCount()).toBe(3);
    expect(await campaigns.completeIfDone(id)).toBe(true);
    expect(await stateOf(id)).toBe('completed');
    // A second retry finds nothing, so it neither resends nor reopens.
    expect(await retryUncertain(sql, CTX, id)).toEqual({ retried: 0 });
    expect(await stateOf(id)).toBe('completed');
  });

  it('while another campaign is active is another_campaign_active and changes nothing', async () => {
    const id = await insertCampaign({ state: 'completed' });
    await insertUncertain(id, ['a']);
    await insertCampaign({ state: 'running' });

    expect(await codeOf(retryUncertain(sql, CTX, id))).toEqual([
      409,
      'another_campaign_active',
    ]);
    expect(await stateOf(id)).toBe('completed');
    expect(await counter(id, 'uncertain')).toBe(1);
    expect(await ledgerCount()).toBe(1);
  });

  it('on a draft is invalid_transition', async () => {
    const id = await insertCampaign({ state: 'draft' });
    await insertUncertain(id, ['a']);
    expect(await codeOf(retryUncertain(sql, CTX, id))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect(await counter(id, 'uncertain')).toBe(1);
  });

  it('is not_found for another project or a malformed id', async () => {
    const id = await insertCampaign();
    expect(
      await codeOf(retryUncertain(sql, { projectId: 'other' }, id))
    ).toEqual([404, 'not_found']);
    expect(await codeOf(retryUncertain(sql, CTX, 'nope'))).toEqual([
      404,
      'not_found',
    ]);
  });

  it('on a running campaign leaves other statuses alone', async () => {
    const id = await insertCampaign({ state: 'running' });
    await insertUncertain(id, ['a']);
    await insertRecipients(id, [
      { id: 'f', status: 'failed', reason: 'rejected' },
    ]);
    expect(await retryUncertain(sql, CTX, id)).toEqual({ retried: 1 });
    expect(await stateOf(id)).toBe('running');
    const failed = await listRecipients(sql, CTX, id, {
      status: 'failed',
      limit: 10,
    });
    expect(failed.recipients.map((r) => r.profileId)).toEqual(['f']);
  });
});

describe('listRecipients', () => {
  it('pages by profile id with a status filter', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, [
      { id: 'a', status: 'sent' },
      { id: 'b', status: 'skipped', reason: 'suppressed' },
      { id: 'c', status: 'sent' },
      { id: 'd', status: 'sent' },
      { id: 'e', status: 'sent' },
    ]);
    const first = await listRecipients(sql, CTX, id, {
      status: 'sent',
      limit: PAGE,
    });
    expect(first.recipients.map((r) => r.profileId)).toEqual(['a', 'c']);
    expect(first.nextCursor).toBe('c');
    const second = await listRecipients(sql, CTX, id, {
      status: 'sent',
      cursor: first.nextCursor ?? undefined,
      limit: PAGE,
    });
    expect(second.recipients.map((r) => r.profileId)).toEqual(['d', 'e']);
    expect(second.nextCursor).toBeNull();
    const all = await listRecipients(sql, CTX, id, { limit: 10 });
    expect(all.recipients).toHaveLength(5);
    expect(Object.keys(all.recipients[0] ?? {}).sort()).toEqual([
      'attempt',
      'profileId',
      'providerRef',
      'reason',
      'sentAt',
      'status',
      'updatedAt',
    ]);
  });

  it('is not_found for another project', async () => {
    const id = await insertCampaign();
    expect(
      await codeOf(
        listRecipients(sql, { projectId: 'other' }, id, { limit: 10 })
      )
    ).toEqual([404, 'not_found']);
  });
});

describe('skipReasons', () => {
  it('groups counts by status and reason', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, [
      { id: 'a', status: 'skipped', reason: 'suppressed' },
      { id: 'b', status: 'skipped', reason: 'suppressed' },
      { id: 'c', status: 'skipped', reason: 'no_contact' },
      { id: 'd', status: 'failed', reason: 'rejected' },
      { id: 'e', status: 'uncertain', reason: 'timeout' },
      { id: 'f', status: 'sent' },
    ]);
    const { reasons } = await skipReasons(sql, CTX, id);
    expect(reasons).toEqual([
      { status: 'failed', reason: 'rejected', count: 1 },
      { status: 'skipped', reason: 'suppressed', count: 2 },
      { status: 'skipped', reason: 'no_contact', count: 1 },
      { status: 'uncertain', reason: 'timeout', count: 1 },
    ]);
  });
});

describe('estimateCampaign', () => {
  it('20,000 sms at 0.25 INR and 100 per second is 5,000 INR and 200 s', async () => {
    await putChannelSettings(
      sql,
      PROJECT,
      'sms',
      {
        ...DEFAULT_CHANNEL_SETTINGS.sms,
        ratePerSecond: SMS_RATE,
        pricePerMessage: { amount: SMS_PRICE, currency: 'INR' },
      },
      0
    );
    const id = await insertCampaign({
      state: 'draft',
      channel: 'sms',
      count: SMS_COUNT,
    });
    const estimate = await estimateCampaign(deps, CTX, id);
    expect(estimate).toMatchObject({
      count: SMS_COUNT,
      channel: 'sms',
      ratePerSecond: SMS_RATE,
      estimatedSeconds: EXPECTED_SMS_SECONDS,
      cost: { amount: EXPECTED_SMS_COST, currency: 'INR' },
      quota: null,
    });
  });

  it('for email with quota 500 and 120 used today needs 41 days for 20,000', async () => {
    await putChannelSettings(
      sql,
      PROJECT,
      'email',
      {
        ...DEFAULT_CHANNEL_SETTINGS.email,
        ratePerSecond: 10,
        dailyQuota: EMAIL_QUOTA,
        quotaTimezone: 'UTC',
      },
      0
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, 'email', 'x')`,
      PROJECT
    );
    await recordLedger(
      sql,
      Array.from({ length: EMAIL_USED }, (_, i) => ({
        sourceRef: `campaign:old:${i}`,
        projectId: PROJECT,
        profileId: `x${i}`,
        channel: 'email',
        sentAt: new Date(NOW.getTime() - 60_000),
      }))
    );
    const id = await insertCampaign({
      state: 'draft',
      channel: 'email',
      count: EMAIL_COUNT,
    });
    const { quota, cost, issues } = await estimateCampaign(deps, CTX, id);
    expect(quota).toEqual({
      dailyQuota: EMAIL_QUOTA,
      usedToday: EMAIL_USED,
      remainingToday: EMAIL_QUOTA - EMAIL_USED,
      daysNeeded: EXPECTED_EMAIL_DAYS,
    });
    expect(cost).toBeNull();
    expect(issues).toEqual([]);
  });

  it('reports unsettled channel settings as issues', async () => {
    const id = await insertCampaign({
      state: 'draft',
      channel: 'sms',
      count: 10,
    });
    const { issues, ratePerSecond, estimatedSeconds } = await estimateCampaign(
      deps,
      CTX,
      id
    );
    expect(issues).toContain('rate_required');
    expect(issues).toContain('channel_not_configured');
    expect([ratePerSecond, estimatedSeconds]).toEqual([null, null]);
  });

  it('without a preview is count_preview_required', async () => {
    const id = await insertCampaign({ state: 'draft', count: null });
    expect(await codeOf(estimateCampaign(deps, CTX, id))).toEqual([
      409,
      'count_preview_required',
    ]);
  });
});

describe('listTestSends', () => {
  it('returns the latest 50, newest first', async () => {
    const id = await insertCampaign();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaign_test_sends (id, campaign_id, project_id, profile_id, requested_by, created_at)
       SELECT gen_random_uuid(), $1::uuid, $2, 'p' || n, 'u', $3::timestamptz + n * interval '1 second'
       FROM generate_series(1, 55) AS n`,
      id,
      PROJECT,
      NOW.toISOString()
    );
    const { testSends } = await listTestSends(sql, CTX, id);
    expect(testSends).toHaveLength(50);
    expect(testSends[0]?.profileId).toBe('p55');
    expect(Object.keys(testSends[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'profileId',
      'reason',
      'sentAt',
      'status',
    ]);
  });
});
