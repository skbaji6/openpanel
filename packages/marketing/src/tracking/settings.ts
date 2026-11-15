import { z } from 'zod';
import type { Queryable } from '../engine/engine';

const MAX_URL_LENGTH = 200;
const MAX_EVENT_NAME_LENGTH = 200;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 7;
const CACHE_TTL_MS = 60_000;
const PLAIN_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);

// The value is only a link base. Requiring the text to be exactly an origin (optionally with a
// trailing slash) rules out credentials, paths, queries and fragments.
export const zBaseUrl = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .transform((raw, ctx) => {
    const invalid = (message: string) => {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    };
    const url = URL.canParse(raw) ? new URL(raw) : null;
    if (!url) {
      return invalid('must be an origin such as https://example.com');
    }
    const secure =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && PLAIN_HTTP_HOSTS.has(url.hostname));
    if (!secure) {
      return invalid('must use https');
    }
    const text = raw.toLowerCase();
    if (text !== url.origin && text !== `${url.origin}/`) {
      return invalid('must be an origin without a path, query or credentials');
    }
    return url.origin;
  });

export const zTrackingSettings = z.strictObject({
  publicUrl: zBaseUrl.nullable(),
  campaignUrl: zBaseUrl.nullable(),
  conversionEvent: z
    .string()
    .trim()
    .min(1)
    .max(MAX_EVENT_NAME_LENGTH)
    .nullable(),
  conversionWindowDays: z
    .number()
    .int()
    .min(MIN_WINDOW_DAYS)
    .max(MAX_WINDOW_DAYS),
});
export type TrackingSettings = z.infer<typeof zTrackingSettings>;

export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = {
  publicUrl: null,
  campaignUrl: null,
  conversionEvent: null,
  conversionWindowDays: DEFAULT_WINDOW_DAYS,
};

export async function getTrackingSettings(
  sql: Queryable,
  projectId: string
): Promise<TrackingSettings> {
  const [row] = await sql.$queryRawUnsafe<{ tracking: unknown }[]>(
    'SELECT tracking FROM marketing.project_settings WHERE project_id = $1',
    projectId
  );
  if (!row?.tracking) {
    return DEFAULT_TRACKING_SETTINGS;
  }
  // A row saved before a key was added reads back with that key defaulted.
  return zTrackingSettings.parse({
    ...DEFAULT_TRACKING_SETTINGS,
    ...(row.tracking as object),
  });
}

export async function putTrackingSettings(
  sql: Queryable,
  projectId: string,
  settings: TrackingSettings
): Promise<TrackingSettings> {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.project_settings (project_id, tracking)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (project_id) DO UPDATE SET tracking = EXCLUDED.tracking`,
    projectId,
    JSON.stringify(settings)
  );
  return settings;
}

// shortcut: unbounded by project count (entries are tiny); add eviction if one process serves thousands of projects.
export function createTrackingSettingsCache(deps: {
  sql: Queryable;
  ttlMs?: number;
  now?: () => number;
}) {
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  const entries = new Map<
    string,
    { settings: TrackingSettings; expiresAt: number }
  >();

  function set(projectId: string, settings: TrackingSettings) {
    entries.set(projectId, { settings, expiresAt: now() + ttlMs });
    return settings;
  }

  return {
    async get(projectId: string): Promise<TrackingSettings> {
      const hit = entries.get(projectId);
      if (hit && hit.expiresAt > now()) {
        return hit.settings;
      }
      return set(projectId, await getTrackingSettings(deps.sql, projectId));
    },
    // Stale on purpose: after the ttl a render still prefers the last known value over the default.
    peek(projectId: string): TrackingSettings | undefined {
      return entries.get(projectId)?.settings;
    },
    // A save in this process takes effect at once; other processes follow within the ttl.
    set,
  };
}
export type TrackingSettingsCache = ReturnType<
  typeof createTrackingSettingsCache
>;
