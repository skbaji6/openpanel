import { z } from 'zod';
import { HttpError } from '../api/http';
import { isTimeZone } from '../api/routes-dashboard';
import type { zQuietHoursOverride } from '../campaign/definition';
import type { Queryable } from '../engine/engine';
import { HH_MM, type QuietHours } from '../engine/gates';

export const CAMPAIGN_CHANNELS = [
  'push',
  'whatsapp',
  'sms',
  'email',
  'webhook',
] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

const MAX_CONCURRENCY = 200;
const MAX_RATE_PER_SECOND = 10_000;
const MAX_PRICE = 1000;
const MAX_DAILY_QUOTA = 10_000_000;
const MAX_TIMEZONE_LENGTH = 64;
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const NO_SETTINGS_VERSION = 0;

const zTimeZone = z
  .string()
  .max(MAX_TIMEZONE_LENGTH)
  .refine(isTimeZone, 'unknown timezone');

export const zChannelSettings = z.strictObject({
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY),
  ratePerSecond: z.number().positive().max(MAX_RATE_PER_SECOND).nullable(),
  quietHours: z
    .strictObject({
      enabled: z.boolean(),
      start: z.string().regex(HH_MM),
      end: z.string().regex(HH_MM),
      timezone: zTimeZone,
    })
    // start === end is read as never quiet by the send gate, so it is rejected rather than saved.
    .refine((q) => !(q.enabled && q.start === q.end), {
      message: 'start and end must differ',
      path: ['end'],
    }),
  requireConsent: z.boolean(),
  pricePerMessage: z
    .strictObject({
      amount: z.number().min(0).max(MAX_PRICE),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .nullable(),
  dailyQuota: z.number().int().min(1).max(MAX_DAILY_QUOTA).nullable(),
  quotaTimezone: zTimeZone,
});
export type ChannelSettings = z.infer<typeof zChannelSettings>;

export type ChannelSettingsIssue =
  | 'rate_required'
  | 'quota_required'
  | 'consent_not_supported'
  | 'quota_not_supported';

function defaults(concurrency: number): ChannelSettings {
  return {
    concurrency,
    ratePerSecond: null,
    quietHours: {
      enabled: false,
      start: '21:00',
      end: '08:00',
      timezone: DEFAULT_TIMEZONE,
    },
    requireConsent: false,
    pricePerMessage: null,
    dailyQuota: null,
    quotaTimezone: DEFAULT_TIMEZONE,
  };
}

export const DEFAULT_CHANNEL_SETTINGS: Record<
  CampaignChannel,
  ChannelSettings
> = {
  push: defaults(10),
  email: defaults(5),
  sms: defaults(4),
  whatsapp: defaults(4),
  webhook: defaults(10),
};

const RATE_REQUIRED_CHANNELS: CampaignChannel[] = ['sms', 'whatsapp', 'email'];
// The send contract only carries consent.whatsapp and consent.sms_promotional.
const CONSENT_CHANNELS: CampaignChannel[] = ['sms', 'whatsapp'];

export function checkChannelSettings(
  channel: CampaignChannel,
  settings: ChannelSettings
): ChannelSettingsIssue[] {
  const issues: ChannelSettingsIssue[] = [];
  if (
    RATE_REQUIRED_CHANNELS.includes(channel) &&
    settings.ratePerSecond === null
  ) {
    issues.push('rate_required');
  }
  if (channel === 'email' && settings.dailyQuota === null) {
    issues.push('quota_required');
  }
  if (settings.requireConsent && !CONSENT_CHANNELS.includes(channel)) {
    issues.push('consent_not_supported');
  }
  if (channel !== 'email' && settings.dailyQuota !== null) {
    issues.push('quota_not_supported');
  }
  return issues;
}

export async function getChannelSettings(
  sql: Queryable,
  projectId: string,
  channel: CampaignChannel
): Promise<{
  settings: ChannelSettings;
  version: number;
  configured: boolean;
}> {
  const [row] = await sql.$queryRawUnsafe<
    { settings: unknown; version: number }[]
  >(
    'SELECT settings, version FROM marketing.channel_settings WHERE project_id = $1 AND channel = $2',
    projectId,
    channel
  );
  if (!row) {
    return {
      settings: DEFAULT_CHANNEL_SETTINGS[channel],
      version: NO_SETTINGS_VERSION,
      configured: false,
    };
  }
  return {
    // A row saved before a key was added to the schema reads back with that key defaulted.
    settings: zChannelSettings.parse({
      ...DEFAULT_CHANNEL_SETTINGS[channel],
      ...(row.settings as object),
    }),
    version: row.version,
    configured: true,
  };
}

export async function putChannelSettings(
  sql: Queryable,
  projectId: string,
  channel: CampaignChannel,
  settings: ChannelSettings,
  expectedVersion: number
): Promise<{ settings: ChannelSettings; version: number }> {
  const payload = JSON.stringify(settings);
  const [row] =
    expectedVersion === NO_SETTINGS_VERSION
      ? await sql.$queryRawUnsafe<{ version: number }[]>(
          `INSERT INTO marketing.channel_settings (project_id, channel, settings)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (project_id, channel) DO NOTHING
           RETURNING version`,
          projectId,
          channel,
          payload
        )
      : await sql.$queryRawUnsafe<{ version: number }[]>(
          `UPDATE marketing.channel_settings
           SET settings = $3::jsonb, version = version + 1, updated_at = now()
           WHERE project_id = $1 AND channel = $2 AND version = $4
           RETURNING version`,
          projectId,
          channel,
          payload,
          expectedVersion
        );
  if (!row) {
    throw new HttpError(409, 'version_conflict');
  }
  await wakeWaitingCampaigns(sql, projectId, channel);
  return { settings, version: row.version };
}

// A wait for quiet hours, the quota or credentials may be over once the operator changed them.
export async function wakeWaitingCampaigns(
  sql: Queryable,
  projectId: string,
  channel: string
): Promise<void> {
  await sql.$executeRawUnsafe(
    `UPDATE marketing.campaigns SET dispatch_retry_at = NULL, dispatch_error = NULL
     WHERE project_id = $1 AND channel = $2 AND state IN ('running', 'paused')`,
    projectId,
    channel
  );
}

type QuietHoursOverride = NonNullable<z.infer<typeof zQuietHoursOverride>>;

export function effectiveQuietHours(
  channel: ChannelSettings['quietHours'],
  override: QuietHoursOverride | null
): QuietHours | null {
  const enabled = override ? override.enabled : channel.enabled;
  if (!enabled) {
    return null;
  }
  return {
    start: override?.start ?? channel.start,
    end: override?.end ?? channel.end,
    timezone: override?.timezone ?? channel.timezone,
  };
}
