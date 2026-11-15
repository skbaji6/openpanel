import type { Queryable } from '../engine/engine';
import type { NormalizedEvent } from '../events/normalize';
import { DEFAULT_TRACKING_SETTINGS, zTrackingSettings } from './settings';

export const MAX_EVENT_CLOCK_SKEW_MS = 5 * 60_000;
const SETTINGS_TTL_MS = 60_000;

interface ConversionRule {
  event: string;
  windowDays: number;
}

// Each event credits the student's latest eligible message, even one that is already converted, so a
// second app open never reaches an older message. Rows lock in source_ref order against concurrent batches.
const CONVERT_SQL = `
  WITH incoming AS (
    SELECT e.project_id, e.profile_id, e.at, e.window_days
    FROM unnest($1::text[], $2::text[], $3::text[]::timestamptz[], $4::int[])
      AS e(project_id, profile_id, at, window_days)
  ), credited AS (
    SELECT m.source_ref, min(e.at) AS at
    FROM incoming e
    CROSS JOIN LATERAL (
      SELECT t.source_ref
      FROM marketing.message_tracking t
      WHERE t.project_id = e.project_id AND t.profile_id = e.profile_id
        AND t.accepted_at IS NOT NULL AND t.status <> 'failed'
        AND t.sent_at <= e.at AND e.at < t.sent_at + make_interval(days => e.window_days)
      ORDER BY t.sent_at DESC, t.source_ref DESC
      LIMIT 1
    ) m
    GROUP BY m.source_ref
  ), locked AS (
    SELECT t.source_ref FROM marketing.message_tracking t
    JOIN credited c ON c.source_ref = t.source_ref
    WHERE t.converted_at IS NULL
    ORDER BY t.source_ref FOR UPDATE OF t
  )
  UPDATE marketing.message_tracking t SET
    status = CASE WHEN marketing.message_status_rank('converted') > marketing.message_status_rank(t.status)
      THEN 'converted' ELSE t.status END,
    converted_at = COALESCE(t.converted_at, c.at)
  FROM credited c, locked l
  WHERE t.source_ref = c.source_ref AND l.source_ref = t.source_ref
    AND t.converted_at IS NULL`;

export function createConversionRecorder(deps: {
  sql: Queryable;
  now: () => Date;
  ttlMs?: number;
}) {
  const ttlMs = deps.ttlMs ?? SETTINGS_TTL_MS;
  let rules = new Map<string, ConversionRule>();
  let expiresAt = 0;

  async function loadRules(): Promise<Map<string, ConversionRule>> {
    if (deps.now().getTime() < expiresAt) {
      return rules;
    }
    const rows = await deps.sql.$queryRawUnsafe<
      { project_id: string; tracking: unknown }[]
    >(
      `SELECT project_id, tracking FROM marketing.project_settings
       WHERE tracking->>'conversionEvent' IS NOT NULL`
    );
    const loaded = new Map<string, ConversionRule>();
    for (const row of rows) {
      const parsed = zTrackingSettings.safeParse({
        ...DEFAULT_TRACKING_SETTINGS,
        ...(row.tracking as object),
      });
      if (parsed.success && parsed.data.conversionEvent) {
        loaded.set(row.project_id, {
          event: parsed.data.conversionEvent,
          windowDays: parsed.data.conversionWindowDays,
        });
      }
    }
    rules = loaded;
    expiresAt = deps.now().getTime() + ttlMs;
    return rules;
  }

  return {
    async record(events: NormalizedEvent[]): Promise<number> {
      if (events.length === 0) {
        return 0;
      }
      const current = await loadRules();
      const latest = deps.now().getTime() + MAX_EVENT_CLOCK_SKEW_MS;
      const matched: { event: NormalizedEvent; windowDays: number }[] = [];
      for (const event of events) {
        const rule = current.get(event.projectId);
        if (rule?.event === event.name && event.time.getTime() <= latest) {
          matched.push({ event, windowDays: rule.windowDays });
        }
      }
      if (matched.length === 0) {
        return 0;
      }
      return await deps.sql.$executeRawUnsafe(
        CONVERT_SQL,
        matched.map((m) => m.event.projectId),
        matched.map((m) => m.event.profileId),
        matched.map((m) => m.event.time.toISOString()),
        matched.map((m) => m.windowDays)
      );
    },
  };
}
export type ConversionRecorder = ReturnType<typeof createConversionRecorder>;
