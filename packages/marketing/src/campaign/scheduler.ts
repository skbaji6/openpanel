import type { Sql } from '../engine/engine';
import { isOneActiveViolation } from './service';
import { fromStates } from './state';

const DEFAULT_BATCH = 20;
const TRANSACTION = { timeout: 60_000, maxWait: 30_000 };

// Late once a whole minute past the ifLate window, so ifLate 0 still allows a claim within the due minute.
// A queued start (send_kind 'now') is never late.
const CLAIM_DUE = `SELECT c.id::text, l.late
  FROM marketing.campaigns c
  CROSS JOIN LATERAL (SELECT c.send_kind = 'scheduled'
    AND c.send_at + make_interval(mins => c.if_late_minutes + 1) <= $1 AS late) l
  WHERE c.state = 'scheduled' AND c.send_at <= $1
    AND (l.late OR NOT EXISTS (SELECT 1 FROM marketing.campaigns active
      WHERE active.project_id = c.project_id AND active.state IN ('running', 'paused')))
  ORDER BY c.send_at, c.id LIMIT $2::int
  FOR UPDATE OF c SKIP LOCKED`;
const MISS = `UPDATE marketing.campaigns SET state = 'missed', state_reason = 'late', finished_at = $2, updated_at = $2
  WHERE id = $1::uuid AND state = ANY($3::text[])`;
// The audience version is taken now: a queued start's confirmation counts as given when it was queued.
const START = `UPDATE marketing.campaigns c SET state = 'running', started_at = $2, updated_at = $2,
    materialize_state = 'not_started',
    audience_version = (SELECT a.version FROM marketing.audiences a WHERE a.id = c.audience_id)
  WHERE c.id = $1::uuid AND c.state = ANY($3::text[])`;
const CREATE_COUNTERS =
  'INSERT INTO marketing.campaign_counters (campaign_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING';

interface ScheduleDeps {
  sql: Sql;
  now: () => Date;
  batch?: number;
}

export async function runScheduleTick(
  deps: ScheduleDeps
): Promise<{ started: number; missed: number }> {
  const now = deps.now();
  return await deps.sql.$transaction(async (tx) => {
    const due = await tx.$queryRawUnsafe<{ id: string; late: boolean }[]>(
      CLAIM_DUE,
      now,
      deps.batch ?? DEFAULT_BATCH
    );
    let started = 0;
    let missed = 0;
    for (const campaign of due) {
      if (campaign.late) {
        missed += await tx.$executeRawUnsafe(
          MISS,
          campaign.id,
          now,
          fromStates('miss')
        );
        continue;
      }
      // Another campaign of the project started first (this batch or another replica): stay scheduled.
      await tx.$executeRawUnsafe('SAVEPOINT claim_due');
      try {
        const updated = await tx.$executeRawUnsafe(
          START,
          campaign.id,
          now,
          fromStates('claim_due')
        );
        if (updated === 1) {
          await tx.$executeRawUnsafe(CREATE_COUNTERS, campaign.id);
          started += 1;
        }
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT claim_due');
      } catch (error) {
        if (!isOneActiveViolation(error)) {
          throw error;
        }
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT claim_due');
      }
    }
    return { started, missed };
  }, TRANSACTION);
}
