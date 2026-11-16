import { MS_PER_DAY, type Sql } from '../engine/engine';
import { LEDGER_RETENTION_DAYS } from '../engine/ledger';

const CHUNK_ROWS = 2000;
const PAUSE_MS = 50;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface BackfillOptions {
  chunkRows?: number;
  pauseMs?: number;
  stopping?: () => boolean;
  now?: () => Date;
  log?: (message: string) => void;
}

// Each statement reads one primary-key window, so none scans a whole table or holds a long transaction.
// Same mapping as the triggers; a row a trigger already wrote wins (ON CONFLICT DO NOTHING).
const RECIPIENT_CHUNK_SQL = `
  WITH win AS (
    SELECT * FROM marketing.campaign_recipients
    WHERE (campaign_id, profile_id) > ($1::uuid, $2)
    ORDER BY campaign_id, profile_id LIMIT $4::int
  ), ins AS (
    INSERT INTO marketing.message_tracking (
      source_ref, project_id, profile_id, channel, campaign_id, status, reason, provider_ref, sent_at, accepted_at, failed_at
    )
    SELECT 'campaign:' || r.campaign_id::text || ':' || r.profile_id, r.project_id, r.profile_id, c.channel, r.campaign_id,
      r.status, r.reason, r.provider_ref, COALESCE(r.sent_at, r.updated_at),
      CASE WHEN r.status = 'sent' THEN COALESCE(r.sent_at, r.updated_at) END,
      CASE WHEN r.status = 'failed' THEN COALESCE(r.sent_at, r.updated_at) END
    FROM win r JOIN marketing.campaigns c ON c.id = r.campaign_id
    WHERE r.status IN ('sent', 'uncertain', 'failed', 'skipped')
      AND COALESCE(r.sent_at, r.updated_at) > $3::timestamptz
    ON CONFLICT DO NOTHING
  )
  SELECT campaign_id::text AS a, profile_id AS b FROM win
  ORDER BY campaign_id DESC, profile_id DESC LIMIT 1`;

const STEP_CHUNK_SQL = `
  WITH win AS (
    SELECT * FROM marketing.steps
    WHERE (enrollment_id, step_index) > ($1::uuid, $2::int)
    ORDER BY enrollment_id, step_index LIMIT $4::int
  ), ins AS (
    INSERT INTO marketing.message_tracking (
      source_ref, project_id, profile_id, channel, rule_id, step_index, status, reason, sent_at, accepted_at, failed_at
    )
    SELECT 'step:' || s.enrollment_id::text || ':' || s.step_index, e.project_id, e.profile_id,
      e.rule_snapshot->'steps'->s.step_index->>'channel', e.rule_id, s.step_index,
      s.status, s.outcome->>'reason', COALESCE(s.sent_at, s.due_at),
      CASE WHEN s.status = 'sent' THEN COALESCE(s.sent_at, s.due_at) END,
      CASE WHEN s.status = 'failed' THEN COALESCE(s.sent_at, s.due_at) END
    FROM win s JOIN marketing.enrollments e ON e.id = s.enrollment_id
    WHERE s.status IN ('sent', 'failed', 'skipped')
      AND COALESCE(s.sent_at, s.due_at) > $3::timestamptz
    ON CONFLICT DO NOTHING
  )
  SELECT enrollment_id::text AS a, step_index::text AS b FROM win
  ORDER BY enrollment_id DESC, step_index DESC LIMIT 1`;

interface WalkOptions {
  chunkRows: number;
  pauseMs: number;
  stopping?: () => boolean;
}

// Returns false when stopped before the table was exhausted.
async function walk(
  sql: Sql,
  statement: string,
  startKey: string,
  cutoff: Date,
  options: WalkOptions
): Promise<boolean> {
  let key = { a: NIL_UUID, b: startKey };
  for (;;) {
    if (options.stopping?.()) {
      return false;
    }
    const rows = await sql.$queryRawUnsafe<{ a: string; b: string }[]>(
      statement,
      key.a,
      key.b,
      cutoff,
      options.chunkRows
    );
    const last = rows[0];
    if (!last) {
      return true;
    }
    key = last;
    await Bun.sleep(options.pauseMs);
  }
}

// Idempotent and resumable by rerun. Never throws: a failure is logged by class name and the next start retries.
export async function backfillTracking(
  sql: Sql,
  options: BackfillOptions = {}
): Promise<boolean> {
  const now = options.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - LEDGER_RETENTION_DAYS * MS_PER_DAY);
  const walkOptions = {
    chunkRows: options.chunkRows ?? CHUNK_ROWS,
    pauseMs: options.pauseMs ?? PAUSE_MS,
    stopping: options.stopping,
  };
  try {
    // The empty string sorts before every profile id, and -1 before every step index.
    const recipientsDone = await walk(
      sql,
      RECIPIENT_CHUNK_SQL,
      '',
      cutoff,
      walkOptions
    );
    return (
      recipientsDone &&
      (await walk(sql, STEP_CHUNK_SQL, '-1', cutoff, walkOptions))
    );
  } catch (error) {
    options.log?.(
      `tracking backfill failed ${error instanceof Error ? error.name : typeof error}`
    );
    return false;
  }
}
