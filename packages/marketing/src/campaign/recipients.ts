import { randomUUID } from 'node:crypto';
import type { DeliveryOutcome } from '../channels/batch';
import { LEASE_MARGIN_MS, SEND_TIMEOUT_MS } from '../channels/timeouts';
import type { Queryable, Sql } from '../engine/engine';
import {
  countRecentSends,
  type EffectiveCap,
  ledgerRef,
  lockCaps,
} from '../engine/ledger';

export const RECIPIENT_STATUSES = [
  'pending',
  'leased',
  'sending',
  'sent',
  'uncertain',
  'failed',
  'skipped',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const MAX_SEND_ATTEMPTS = 5;
export const SENDING_LEASE_MS = 2 * SEND_TIMEOUT_MS + LEASE_MARGIN_MS;
// Grows with the attempt, so an outage spends the attempts over minutes, not seconds.
export const RETRY_BACKOFF_MS = 30_000;
export const CHANNEL_ERROR_BACKOFF_MS = 60_000;
// Bounds one reaper pass; the next pass, on any replica, continues.
export const REAP_BATCH = 1000;

const TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
const ALIVE_STATES = new Set(['running', 'paused']);
const MS = "interval '1 millisecond'";
const CAMPAIGN_REF = `'campaign:' || changed.campaign_id::text || ':' || changed.profile_id`;

// Appended to a statement whose changed CTE returns (campaign_id, status) of the rows it moved.
const bumpCounters = (now: string) => `bumped AS (
    INSERT INTO marketing.campaign_counters (campaign_id, sent, failed, skipped, uncertain, updated_at)
    SELECT campaign_id, count(*) FILTER (WHERE status = 'sent')::int, count(*) FILTER (WHERE status = 'failed')::int,
      count(*) FILTER (WHERE status = 'skipped')::int, count(*) FILTER (WHERE status = 'uncertain')::int, ${now}
    FROM changed WHERE status IN ('sent', 'failed', 'skipped', 'uncertain') GROUP BY campaign_id
    ON CONFLICT (campaign_id) DO UPDATE SET
      sent = marketing.campaign_counters.sent + EXCLUDED.sent,
      failed = marketing.campaign_counters.failed + EXCLUDED.failed,
      skipped = marketing.campaign_counters.skipped + EXCLUDED.skipped,
      uncertain = marketing.campaign_counters.uncertain + EXCLUDED.uncertain,
      updated_at = EXCLUDED.updated_at
    RETURNING 1
  )`;

// Same lock order as cancel and fail: the campaign row first, then its recipients.
const SHARE_CAMPAIGN =
  'SELECT state FROM marketing.campaigns WHERE id = $1::uuid FOR SHARE';

// Params: campaign, token, now, lease end, limit.
// The pick is a materialised CTE so the planner cannot rescan it and take more than the limit.
const CLAIM_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT q.profile_id FROM marketing.campaign_recipients q
    WHERE q.campaign_id = $1::uuid AND q.status = 'pending' AND q.due_at <= $3::timestamptz
      AND EXISTS (SELECT 1 FROM marketing.campaigns c
        WHERE c.id = $1::uuid AND c.state = 'running' AND c.materialize_state = 'done')
    ORDER BY q.due_at LIMIT $5::int
    FOR UPDATE OF q SKIP LOCKED
  )
  UPDATE marketing.campaign_recipients r
  SET status = 'leased', lease_token = $2::uuid, lease_until = $4::timestamptz, updated_at = $3::timestamptz
  FROM picked
  WHERE r.campaign_id = $1::uuid AND r.profile_id = picked.profile_id
  RETURNING r.profile_id`;

// Params: token, status, profiles, reasons.
const MARK_LEASED_FINAL_SQL = `
  WITH changed AS (
    UPDATE marketing.campaign_recipients r
    SET status = $2, reason = i.reason, lease_token = NULL, lease_until = NULL, updated_at = now()
    FROM unnest($3::text[], $4::text[]) AS i(profile_id, reason)
    WHERE r.lease_token = $1::uuid AND r.status = 'leased' AND r.profile_id = i.profile_id
    RETURNING r.campaign_id, r.status
  ), ${bumpCounters('now()')}
  SELECT count(*)::int AS n FROM changed`;

// Params: campaign, token, profiles, capped profiles, now, sending lease end, project, channel.
const MARK_SENDING_SQL = `
  WITH changed AS (
    UPDATE marketing.campaign_recipients r SET
      status = CASE WHEN r.profile_id = ANY($4::text[]) THEN 'skipped' ELSE 'sending' END,
      reason = CASE WHEN r.profile_id = ANY($4::text[]) THEN 'capped' END,
      attempt = CASE WHEN r.profile_id = ANY($4::text[]) THEN r.attempt ELSE r.attempt + 1 END,
      lease_until = CASE WHEN r.profile_id = ANY($4::text[]) THEN NULL ELSE $6::timestamptz END,
      lease_token = CASE WHEN r.profile_id = ANY($4::text[]) THEN NULL ELSE r.lease_token END,
      updated_at = $5::timestamptz
    WHERE r.campaign_id = $1::uuid AND r.lease_token = $2::uuid AND r.status = 'leased'
      AND r.profile_id = ANY($3::text[])
    RETURNING r.campaign_id, r.profile_id, r.status
  ), recorded AS (
    INSERT INTO marketing.send_ledger (source_ref, project_id, profile_id, channel, sent_at)
    SELECT ${CAMPAIGN_REF}, $7, changed.profile_id, $8, $5::timestamptz FROM changed WHERE changed.status = 'sending'
    ON CONFLICT (source_ref) DO UPDATE SET sent_at = EXCLUDED.sent_at
    RETURNING 1
  ), ${bumpCounters('$5::timestamptz')}
  SELECT profile_id, status FROM changed`;

// Params: campaign, token, profiles, outcomes, reasons, provider refs, retry-after ms, now,
// retryAt, campaign still alive, campaign state. The fence is re-checked by the UPDATE itself,
// so a row the reaper took first is left alone and not counted.
const MARK_OUTCOMES_SQL = `
  WITH decided AS (
    SELECT r.profile_id, i.outcome, NULLIF(i.reason, '') AS reason, NULLIF(i.provider_ref, '') AS provider_ref,
      CASE
        WHEN i.outcome IN ('sent', 'failed', 'uncertain') THEN i.outcome
        WHEN i.outcome = 'retry' AND r.attempt >= ${MAX_SEND_ATTEMPTS} THEN 'failed'
        WHEN NOT $10::boolean THEN 'skipped'
        ELSE 'pending'
      END AS status,
      CASE i.outcome
        WHEN 'retry' THEN ${RETRY_BACKOFF_MS}::bigint * r.attempt
        WHEN 'rate_limited' THEN i.retry_after_ms
        ELSE ${CHANNEL_ERROR_BACKOFF_MS}
      END AS backoff_ms
    FROM marketing.campaign_recipients r
    JOIN unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[])
      AS i(profile_id, outcome, reason, provider_ref, retry_after_ms) ON i.profile_id = r.profile_id
    WHERE r.campaign_id = $1::uuid AND r.lease_token = $2::uuid AND r.status = 'sending'
  ), changed AS (
    UPDATE marketing.campaign_recipients r SET
      status = d.status,
      reason = CASE
        WHEN d.status = 'sent' THEN NULL
        WHEN d.status = 'failed' AND d.outcome = 'retry' THEN 'max_attempts'
        WHEN d.status IN ('failed', 'uncertain') THEN d.reason
        WHEN d.status = 'skipped' THEN $11
        WHEN d.outcome IN ('rate_limited', 'channel_error') THEN d.outcome
      END,
      attempt = CASE WHEN d.status = 'pending' AND d.outcome IN ('rate_limited', 'channel_error')
        THEN GREATEST(r.attempt - 1, 0) ELSE r.attempt END,
      due_at = CASE WHEN d.status = 'pending'
        THEN GREATEST($9::timestamptz, $8::timestamptz + d.backoff_ms * ${MS}) ELSE r.due_at END,
      provider_ref = CASE WHEN d.status IN ('sent', 'uncertain') THEN COALESCE(d.provider_ref, r.provider_ref)
        ELSE r.provider_ref END,
      sent_at = CASE WHEN d.status = 'sent' THEN $8::timestamptz ELSE r.sent_at END,
      lease_token = NULL, lease_until = NULL, updated_at = $8::timestamptz
    FROM decided d
    WHERE r.campaign_id = $1::uuid AND r.profile_id = d.profile_id AND r.lease_token = $2::uuid AND r.status = 'sending'
    RETURNING r.campaign_id, r.profile_id, r.status
  ), kept AS (
    UPDATE marketing.send_ledger l SET sent_at = $8::timestamptz
    FROM changed WHERE l.source_ref = ${CAMPAIGN_REF} AND changed.status = 'sent'
    RETURNING 1
  ), dropped AS (
    DELETE FROM marketing.send_ledger l USING changed
    WHERE l.source_ref = ${CAMPAIGN_REF} AND changed.status IN ('failed', 'pending', 'skipped')
    RETURNING 1
  ), ${bumpCounters('$8::timestamptz')}
  SELECT count(*)::int AS applied FROM changed`;

// Params: token, due_at (null keeps it).
const RELEASE_SQL = `
  UPDATE marketing.campaign_recipients
  SET status = 'pending', lease_token = NULL, lease_until = NULL, due_at = COALESCE($2::timestamptz, due_at), updated_at = now()
  WHERE lease_token = $1::uuid AND status = 'leased'`;

// Params: now. A crashed send may have reached the provider, so it becomes uncertain and keeps its
// ledger row; a crashed claim never sent, so it is re-queued unless its campaign has ended.
const REAP_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT campaign_id, profile_id FROM marketing.campaign_recipients
    WHERE status IN ('leased', 'sending') AND lease_until < $1::timestamptz
    ORDER BY lease_until LIMIT ${REAP_BATCH}
    FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE marketing.campaign_recipients r SET
      status = CASE WHEN r.status = 'sending' THEN 'uncertain'
        WHEN c.state IN ('running', 'paused') THEN 'pending' ELSE 'skipped' END,
      reason = CASE WHEN r.status = 'sending' THEN 'lease_expired'
        WHEN c.state IN ('running', 'paused') THEN r.reason ELSE c.state END,
      lease_token = NULL, lease_until = NULL, updated_at = $1::timestamptz
    FROM picked p, marketing.campaigns c
    WHERE r.campaign_id = p.campaign_id AND r.profile_id = p.profile_id AND c.id = r.campaign_id
      AND r.status IN ('leased', 'sending') AND r.lease_until < $1::timestamptz
    RETURNING r.campaign_id, r.status
  ), ${bumpCounters('$1::timestamptz')}
  SELECT count(*) FILTER (WHERE status <> 'uncertain')::int AS released,
    count(*) FILTER (WHERE status = 'uncertain')::int AS uncertain
  FROM changed`;

// Two items for one person would update the row once with an arbitrary item; the first one wins.
function firstPerProfile<T extends { profileId: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    if (!seen.has(item.profileId)) {
      seen.set(item.profileId, item);
    }
  }
  return [...seen.values()];
}

export async function claimRecipients(
  sql: Sql,
  args: { campaignId: string; limit: number; now: Date; leaseMs: number }
): Promise<{ token: string; profileIds: string[]; leaseUntil: Date }> {
  const token = randomUUID();
  const leaseUntil = new Date(args.now.getTime() + args.leaseMs);
  const rows = await sql.$queryRawUnsafe<{ profile_id: string }[]>(
    CLAIM_SQL,
    args.campaignId,
    token,
    args.now.toISOString(),
    leaseUntil.toISOString(),
    args.limit
  );
  return { token, profileIds: rows.map((row) => row.profile_id), leaseUntil };
}

// For rows that never reach a provider: lookup skips and render failures.
export async function markLeasedFinal(
  sql: Sql,
  token: string,
  status: 'skipped' | 'failed',
  items: { profileId: string; reason: string }[]
): Promise<number> {
  const unique = firstPerProfile(items);
  if (unique.length === 0) {
    return 0;
  }
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    MARK_LEASED_FINAL_SQL,
    token,
    status,
    unique.map((item) => item.profileId),
    unique.map((item) => item.reason)
  );
  return row?.n ?? 0;
}

async function cappedProfiles(
  tx: Queryable,
  args: {
    campaignId: string;
    projectId: string;
    channel: string;
    profileIds: string[];
    now: Date;
    cap: EffectiveCap;
  }
): Promise<string[]> {
  const { campaignId, projectId, channel, profileIds, now, cap } = args;
  await lockCaps(
    tx,
    profileIds.map((profileId) => ({
      projectId,
      profileId,
      channel,
      scope: cap.scope,
    }))
  );
  const counts = await countRecentSends(tx, {
    projectId,
    profileIds,
    channel: cap.scope === 'all' ? null : channel,
    since: new Date(now.getTime() - cap.periodSeconds * 1000),
    // A retried recipient's own earlier ledger row is this same send, not another one.
    excludeRefs: profileIds.map((profileId) =>
      ledgerRef.campaign(campaignId, profileId)
    ),
  });
  return profileIds.filter(
    (profileId) => (counts.get(profileId) ?? 0) >= cap.max
  );
}

export async function markSending(
  sql: Sql,
  args: {
    campaignId: string;
    projectId: string;
    channel: string;
    token: string;
    profileIds: string[];
    now: Date;
    cap: EffectiveCap | null;
  }
): Promise<{ sending: string[]; capped: string[]; notRunning: boolean }> {
  const { campaignId, projectId, channel, token, now, cap } = args;
  const profileIds = [...new Set(args.profileIds)];
  return await sql.$transaction(async (tx) => {
    const [campaign] = await tx.$queryRawUnsafe<{ state: string }[]>(
      SHARE_CAMPAIGN,
      campaignId
    );
    if (campaign?.state !== 'running') {
      return { sending: [], capped: [], notRunning: true };
    }
    const capped = cap
      ? await cappedProfiles(tx, {
          campaignId,
          projectId,
          channel,
          profileIds,
          now,
          cap,
        })
      : [];
    const rows = await tx.$queryRawUnsafe<
      { profile_id: string; status: string }[]
    >(
      MARK_SENDING_SQL,
      campaignId,
      token,
      profileIds,
      capped,
      now.toISOString(),
      new Date(now.getTime() + SENDING_LEASE_MS).toISOString(),
      projectId,
      channel
    );
    const withStatus = (status: string) =>
      rows.filter((row) => row.status === status).map((row) => row.profile_id);
    return {
      sending: withStatus('sending'),
      capped: withStatus('skipped'),
      notRunning: false,
    };
  }, TRANSACTION);
}

export async function markOutcomes(
  sql: Sql,
  args: {
    campaignId: string;
    token: string;
    outcomes: DeliveryOutcome[];
    now: Date;
    retryAt: Date;
  }
): Promise<{ applied: number }> {
  const { campaignId, token, now, retryAt } = args;
  const outcomes = firstPerProfile(args.outcomes);
  if (outcomes.length === 0) {
    return { applied: 0 };
  }
  return await sql.$transaction(async (tx) => {
    const [campaign] = await tx.$queryRawUnsafe<{ state: string }[]>(
      SHARE_CAMPAIGN,
      campaignId
    );
    if (!campaign) {
      return { applied: 0 };
    }
    const [row] = await tx.$queryRawUnsafe<{ applied: number }[]>(
      MARK_OUTCOMES_SQL,
      campaignId,
      token,
      outcomes.map((item) => item.profileId),
      outcomes.map((item) => item.outcome),
      outcomes.map((item) => item.reason ?? ''),
      outcomes.map((item) => item.providerRef ?? ''),
      outcomes.map((item) => Math.max(0, Math.trunc(item.retryAfterMs ?? 0))),
      now.toISOString(),
      retryAt.toISOString(),
      ALIVE_STATES.has(campaign.state),
      campaign.state
    );
    return { applied: row?.applied ?? 0 };
  }, TRANSACTION);
}

export async function releaseLeased(
  sql: Sql,
  token: string,
  dueAt?: Date
): Promise<number> {
  return await sql.$executeRawUnsafe(
    RELEASE_SQL,
    token,
    dueAt?.toISOString() ?? null
  );
}

// Safe on every replica at once: SKIP LOCKED splits the expired rows between concurrent passes.
export async function reapExpiredLeases(
  sql: Sql,
  now: Date
): Promise<{ released: number; uncertain: number }> {
  const [row] = await sql.$queryRawUnsafe<
    { released: number; uncertain: number }[]
  >(REAP_SQL, now.toISOString());
  return { released: row?.released ?? 0, uncertain: row?.uncertain ?? 0 };
}
