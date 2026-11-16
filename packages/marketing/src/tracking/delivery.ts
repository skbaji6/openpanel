import type { Queryable } from '../engine/engine';
import { statusRank } from './status';

export type ReportStatus = 'delivered' | 'read' | 'failed';

export interface DeliveryUpdate {
  sourceRef: string;
  status: ReportStatus;
  at: Date;
  reason: string | null;
}

// One per source_ref: the furthest status, and for that status the earliest time.
export function reduceUpdates(updates: DeliveryUpdate[]): DeliveryUpdate[] {
  const best = new Map<string, DeliveryUpdate>();
  for (const update of updates) {
    const current = best.get(update.sourceRef);
    const isBetter =
      !current ||
      statusRank(update.status) > statusRank(current.status) ||
      (update.status === current.status && update.at < current.at);
    if (isBetter) {
      best.set(update.sourceRef, update);
    }
  }
  return [...best.values()];
}

// Rows lock in source_ref order so concurrent duplicate calls cannot deadlock.
// A read also carries delivered; failed only counts while the row is below failed.
const APPLY_SQL = `
  WITH incoming AS (
    SELECT u.source_ref, u.status, u.at, NULLIF(u.reason, '') AS reason
    FROM unnest($2::text[], $3::text[], $4::text[]::timestamptz[], $5::text[])
      AS u(source_ref, status, at, reason)
  ), locked AS (
    SELECT t.source_ref FROM marketing.message_tracking t
    JOIN incoming u ON u.source_ref = t.source_ref
    WHERE t.project_id = $1 AND t.status <> 'skipped'
    ORDER BY t.source_ref FOR UPDATE OF t
  )
  UPDATE marketing.message_tracking t SET
    status = CASE WHEN marketing.message_status_rank(u.status) > marketing.message_status_rank(t.status)
      THEN u.status ELSE t.status END,
    reason = CASE WHEN u.status = 'failed' AND marketing.message_status_rank(t.status) < marketing.message_status_rank('failed')
      THEN u.reason ELSE t.reason END,
    accepted_at = COALESCE(t.accepted_at, u.at),
    delivered_at = CASE WHEN u.status IN ('delivered', 'read') THEN COALESCE(t.delivered_at, u.at) ELSE t.delivered_at END,
    read_at = CASE WHEN u.status = 'read' THEN COALESCE(t.read_at, u.at) ELSE t.read_at END,
    failed_at = CASE WHEN u.status = 'failed' AND marketing.message_status_rank(t.status) < marketing.message_status_rank('failed')
      THEN COALESCE(t.failed_at, u.at) ELSE t.failed_at END
  FROM incoming u, locked l
  WHERE t.source_ref = u.source_ref AND l.source_ref = t.source_ref
    AND t.project_id = $1 AND t.status <> 'skipped'
    AND (
      marketing.message_status_rank(u.status) > marketing.message_status_rank(t.status)
      OR (u.status IN ('delivered', 'read') AND (t.delivered_at IS NULL OR t.accepted_at IS NULL))
      OR (u.status = 'read' AND t.read_at IS NULL)
    )`;

export async function applyDeliveryUpdates(
  sql: Queryable,
  projectId: string,
  updates: DeliveryUpdate[]
): Promise<number> {
  const reduced = reduceUpdates(updates);
  if (reduced.length === 0) {
    return 0;
  }
  return await sql.$executeRawUnsafe(
    APPLY_SQL,
    projectId,
    reduced.map((u) => u.sourceRef),
    reduced.map((u) => u.status),
    reduced.map((u) => u.at.toISOString()),
    reduced.map((u) => u.reason ?? '')
  );
}
