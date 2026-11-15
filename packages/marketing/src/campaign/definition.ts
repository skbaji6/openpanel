import { z } from 'zod';
import { isTimeZone } from '../api/routes-dashboard';
import { HH_MM } from '../engine/gates';
import { zInlineTemplate } from '../rules/rule.schema';

const MAX_CAMPAIGN_NAME = 200;
const MAX_CAMPAIGN_KEY = 100;
const MAX_TEMPLATE_ID = 200;
const MAX_IF_LATE_MINUTES = 1440;
const DEFAULT_IF_LATE_MINUTES = 60;
const MAX_FREQUENCY = 10_000;
const MIN_PERIOD_SECONDS = 60;
const MAX_PERIOD_SECONDS = 31_536_000;
const DEFAULT_CAMPAIGN_TIMEZONE = 'Asia/Kolkata';
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const JOURNEY_TEMPLATE_CHANNELS = ['email', 'webhook'] as const;
const REGISTRY_TEMPLATE_CHANNELS = ['sms', 'whatsapp'] as const;

const zTimeZone = z.string().refine(isTimeZone, 'unknown timezone');
const zIfLateMinutes = z.number().int().min(0).max(MAX_IF_LATE_MINUTES);

// start === end is read as never quiet by the send gate, so it is rejected rather than saved.
const START_EQUALS_END = {
  message: 'start and end must differ',
  path: ['end'],
};

export const zQuietHoursOverride = z
  .strictObject({
    enabled: z.boolean(),
    start: z.string().regex(HH_MM).optional(),
    end: z.string().regex(HH_MM).optional(),
    timezone: zTimeZone.optional(),
  })
  .refine(
    (o) => !(o.enabled && o.start !== undefined && o.start === o.end),
    START_EQUALS_END
  )
  .nullable();

export const zFrequencyCap = z
  .strictObject({
    max: z.number().int().min(1).max(MAX_FREQUENCY),
    periodSeconds: z
      .number()
      .int()
      .min(MIN_PERIOD_SECONDS)
      .max(MAX_PERIOD_SECONDS),
  })
  .nullable();

const commonFields = {
  name: z.string().trim().min(1).max(MAX_CAMPAIGN_NAME),
  audienceId: z.uuid().nullable().optional(),
  campaignKey: z.string().min(1).max(MAX_CAMPAIGN_KEY).nullable().optional(),
  skipPreviousRecipients: z.boolean().optional(),
  sendAtLocal: z
    .string()
    .regex(LOCAL_MINUTE, 'must be YYYY-MM-DDTHH:mm')
    .nullable()
    .optional(),
  timezone: zTimeZone.default(DEFAULT_CAMPAIGN_TIMEZONE),
  ifLateMinutes: zIfLateMinutes.default(DEFAULT_IF_LATE_MINUTES),
  quietHoursOverride: zQuietHoursOverride.optional(),
  frequencyCap: zFrequencyCap.optional(),
};

const MAX_URL_LENGTH = 2000;
const UNSAFE_LINK_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
]);

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// Both are fixed operator content, so a variable would be a typo that ships literally.
const noVariables = (value: string) => !value.includes('{{');

const zImageUrl = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .refine((value) => parsedUrl(value)?.protocol === 'https:', 'must be https')
  .refine((value) => {
    const url = parsedUrl(value);
    return !(url?.username || url?.password);
  }, 'must not contain a user name or password')
  .refine(noVariables, 'must not contain variables');
// App deep links such as sia://course/12 are allowed; only schemes that run code or read files are not.
const zLink = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .refine((value) => {
    const url = parsedUrl(value);
    return url !== null && !UNSAFE_LINK_SCHEMES.has(url.protocol);
  }, 'must be a URL with a safe scheme')
  .refine(noVariables, 'must not contain variables');

export const zPushTemplate = z.strictObject({
  subject: zInlineTemplate.shape.subject,
  body: zInlineTemplate.shape.body,
  imageUrl: zImageUrl.optional(),
  link: zLink.optional(),
});

const pushShape = {
  ...commonFields,
  channel: z.literal('push'),
  template: zPushTemplate,
};
const journeyShape = {
  ...commonFields,
  channel: z.enum(JOURNEY_TEMPLATE_CHANNELS),
  template: zInlineTemplate,
};
export const zRegistryTemplate = z.strictObject({
  templateId: z.string().min(1).max(MAX_TEMPLATE_ID),
});
const registryShape = {
  ...commonFields,
  channel: z.enum(REGISTRY_TEMPLATE_CHANNELS),
  template: zRegistryTemplate,
};

// Skipping earlier recipients is keyed on campaignKey, so without one it would silently skip no one.
const keyedSkip = (draft: {
  campaignKey?: string | null;
  skipPreviousRecipients?: boolean;
}) => !draft.skipPreviousRecipients || Boolean(draft.campaignKey);
const KEYED_SKIP_ISSUE = {
  message: 'skipPreviousRecipients needs a campaignKey',
  path: ['campaignKey'],
};

// No cross-field rules here: the service checks the merged draft with zCampaignFields, which answers invalid_campaign.
export const zCampaignDraft = z.discriminatedUnion('channel', [
  z.strictObject(pushShape),
  z.strictObject(journeyShape),
  z.strictObject(registryShape),
]);

// The service re-checks a merged draft with this one: it drops fields a client may not set (confirmThreshold).
export const zCampaignFields = z
  .discriminatedUnion('channel', [
    z.object(pushShape),
    z.object(journeyShape),
    z.object(registryShape),
  ])
  .refine(keyedSkip, KEYED_SKIP_ISSUE);

// Template and channel are checked together once merged into the stored draft.
export const zCampaignPatch = z
  .strictObject({
    ...commonFields,
    timezone: zTimeZone,
    ifLateMinutes: zIfLateMinutes,
    channel: z.enum([
      'push',
      ...JOURNEY_TEMPLATE_CHANNELS,
      ...REGISTRY_TEMPLATE_CHANNELS,
    ]),
    template: z.unknown(),
  })
  .partial();

export type CampaignDraft = z.input<typeof zCampaignDraft>;
export type CampaignPatch = z.infer<typeof zCampaignPatch>;
