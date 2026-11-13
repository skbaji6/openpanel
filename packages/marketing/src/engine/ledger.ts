import {
  deleteInChunks,
  MS_PER_DAY,
  PURGE_DEFAULTS,
  type PurgeOptions,
  type Queryable,
  type Sql,
} from './engine';

export const LEDGER_RETENTION_DAYS = 400;

export type CapScope = 'channel' | 'all';

export interface EffectiveCap {
  max: number;
  periodSeconds: number;
  scope: CapScope;
}

interface CapWindow {
  max: number;
  periodSeconds: number;
}

export interface LedgerRow {
  sourceRef: string;
  projectId: string;
  profileId: string;
  channel: string;
  sentAt: Date;
}

const RECORD_SQL = `
  INSERT INTO marketing.send_ledger (source_ref, project_id, profile_id, channel, sent_at)
  SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]::timestamptz[])
  ON CONFLICT (source_ref) DO UPDATE SET sent_at = EXCLUDED.sent_at`;

const DELETE_SQL =
  'DELETE FROM marketing.send_ledger WHERE source_ref = ANY($1::text[])';

// Params: project, profiles, window start, channel (null for every channel), refs to leave out.
const COUNT_RECENT_SQL = `
  SELECT profile_id, count(*)::int AS n FROM marketing.send_ledger
  WHERE project_id = $1 AND profile_id = ANY($2::text[]) AND sent_at > $3::timestamptz
    AND ($4::text IS NULL OR channel = $4::text) AND NOT (source_ref = ANY($5::text[]))
  GROUP BY profile_id`;

const COUNT_CHANNEL_SQL = `
  SELECT count(*)::int AS n FROM marketing.send_ledger
  WHERE project_id = $1 AND channel = $2 AND sent_at >= $3::timestamptz`;

const CAP_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const CAP_LOCKS_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM unnest($1::text[]) AS key';

const PURGE_LEDGER_CHUNK_SQL = `
  DELETE FROM marketing.send_ledger WHERE ctid IN (
    SELECT ctid FROM marketing.send_ledger WHERE sent_at < $1::timestamptz LIMIT $2::int)`;

// Safe for completed (reopenable) too: a campaign untouched for 400 days has nothing left to send to these recipients.
const PURGE_RECIPIENTS_CHUNK_SQL = `
  DELETE FROM marketing.campaign_recipients WHERE ctid IN (
    SELECT r.ctid FROM marketing.campaigns c
    JOIN marketing.campaign_recipients r ON r.campaign_id = c.id
    WHERE c.state IN ('completed', 'cancelled', 'failed', 'missed') AND c.finished_at < $1::timestamptz
    LIMIT $2::int)`;

export function effectiveCap(
  campaignCap: CapWindow | null,
  projectCaps: (CapWindow & { scope?: CapScope }) | null
): EffectiveCap | null {
  const window = campaignCap ?? projectCaps;
  if (!window) {
    return null;
  }
  return {
    max: window.max,
    periodSeconds: window.periodSeconds,
    scope: projectCaps?.scope ?? 'channel',
  };
}

export const ledgerRef = {
  campaign: (campaignId: string, profileId: string) =>
    `campaign:${campaignId}:${profileId}`,
  step: (enrollmentId: string, stepIndex: number) =>
    `step:${enrollmentId}:${stepIndex}`,
};

interface CapLockArgs {
  projectId: string;
  profileId: string;
  channel: string;
  scope: CapScope;
}

// The 'cap' prefix keeps this key apart from the engine's profile lock, which consumer batches hold for long.
export function capLockKey(args: CapLockArgs): string {
  const { projectId, profileId, channel, scope } = args;
  const key =
    scope === 'all'
      ? ['cap', projectId, profileId]
      : ['cap', projectId, profileId, channel];
  return JSON.stringify(key);
}

// Every sender takes this before counting and holds it only until its ledger row is written in the
// same transaction, never across a provider call, so a journey waits at most one short write on it.
// Taken after the engine's profile lock when both are needed, never before it, so the two cannot deadlock.
export async function lockCap(tx: Queryable, args: CapLockArgs): Promise<void> {
  await tx.$executeRawUnsafe(CAP_LOCK_SQL, capLockKey(args));
}

// A batch sender's locks in one statement, in sorted key order so two batches sharing people cannot deadlock.
export async function lockCaps(
  tx: Queryable,
  args: CapLockArgs[]
): Promise<void> {
  const keys = [...new Set(args.map(capLockKey))].sort();
  if (keys.length === 0) {
    return;
  }
  await tx.$executeRawUnsafe(CAP_LOCKS_SQL, keys);
}

export async function recordLedger(
  tx: Queryable,
  rows: LedgerRow[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await tx.$executeRawUnsafe(
    RECORD_SQL,
    rows.map((row) => row.sourceRef),
    rows.map((row) => row.projectId),
    rows.map((row) => row.profileId),
    rows.map((row) => row.channel),
    rows.map((row) => row.sentAt.toISOString())
  );
}

export async function deleteLedger(
  tx: Queryable,
  sourceRefs: string[]
): Promise<void> {
  if (sourceRefs.length === 0) {
    return;
  }
  await tx.$executeRawUnsafe(DELETE_SQL, sourceRefs);
}

export async function countRecentSends(
  tx: Queryable,
  args: {
    projectId: string;
    profileIds: string[];
    channel: string | null;
    since: Date;
    excludeRefs?: string[];
  }
): Promise<Map<string, number>> {
  const rows = await tx.$queryRawUnsafe<{ profile_id: string; n: number }[]>(
    COUNT_RECENT_SQL,
    args.projectId,
    args.profileIds,
    args.since.toISOString(),
    args.channel,
    args.excludeRefs ?? []
  );
  return new Map(rows.map((row) => [row.profile_id, row.n]));
}

export async function countChannelSendsSince(
  tx: Queryable,
  projectId: string,
  channel: string,
  since: Date
): Promise<number> {
  const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(
    COUNT_CHANNEL_SQL,
    projectId,
    channel,
    since.toISOString()
  );
  return row?.n ?? 0;
}

export async function purgeSendHistory(
  sql: Sql,
  retentionDays: number = LEDGER_RETENTION_DAYS,
  options: Partial<PurgeOptions> = {}
): Promise<{ ledger: number; recipients: number }> {
  const started = Date.now();
  const cutoff = new Date(started - retentionDays * MS_PER_DAY);
  const budgetMs = options.budgetMs ?? PURGE_DEFAULTS.budgetMs;
  const ledger = await deleteInChunks(
    sql,
    PURGE_LEDGER_CHUNK_SQL,
    cutoff,
    options
  );
  // One budget for the whole run; the next hourly run continues where this one stopped.
  const remainingMs = budgetMs - (Date.now() - started);
  if (remainingMs <= 0) {
    return { ledger, recipients: 0 };
  }
  const recipients = await deleteInChunks(
    sql,
    PURGE_RECIPIENTS_CHUNK_SQL,
    cutoff,
    { ...options, budgetMs: remainingMs }
  );
  return { ledger, recipients };
}
