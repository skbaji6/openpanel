import {
  deleteInChunks,
  MS_PER_DAY,
  PURGE_DEFAULTS,
  type PurgeOptions,
  type Sql,
} from '../engine/engine';
import { LEDGER_RETENTION_DAYS } from '../engine/ledger';

const PURGE_MESSAGES_CHUNK_SQL = `
  DELETE FROM marketing.message_tracking WHERE ctid IN (
    SELECT ctid FROM marketing.message_tracking WHERE sent_at < $1::timestamptz LIMIT $2::int)`;

const PURGE_VARIANT_COUNTS_CHUNK_SQL = `
  DELETE FROM marketing.journey_variant_counts WHERE ctid IN (
    SELECT ctid FROM marketing.journey_variant_counts WHERE day < $1::timestamptz::date LIMIT $2::int)`;

// shortcut: tracked_links rows are kept, one per distinct url per project, so they stay small; purge them if a project registers unbounded urls.
export async function purgeTracking(
  sql: Sql,
  options: Partial<PurgeOptions> = {}
): Promise<{ messages: number; variantCounts: number }> {
  const started = Date.now();
  const cutoff = new Date(started - LEDGER_RETENTION_DAYS * MS_PER_DAY);
  const budgetMs = options.budgetMs ?? PURGE_DEFAULTS.budgetMs;
  const messages = await deleteInChunks(
    sql,
    PURGE_MESSAGES_CHUNK_SQL,
    cutoff,
    options
  );
  // One budget for the whole run; the next hourly run continues where this one stopped.
  const remainingMs = budgetMs - (Date.now() - started);
  if (remainingMs <= 0) {
    return { messages, variantCounts: 0 };
  }
  const variantCounts = await deleteInChunks(
    sql,
    PURGE_VARIANT_COUNTS_CHUNK_SQL,
    cutoff,
    { ...options, budgetMs: remainingMs }
  );
  return { messages, variantCounts };
}
