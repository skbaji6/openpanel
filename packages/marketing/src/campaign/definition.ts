import { z } from 'zod';
import { isTimeZone } from '../api/routes-dashboard';
import { HH_MM } from '../engine/gates';
import { zStep } from '../rules/rule.schema';

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

const JOURNEY_TEMPLATE_CHANNELS = ['push', 'email', 'webhook'] as const;
const REGISTRY_TEMPLATE_CHANNELS = ['sms', 'whatsapp'] as const;

const zTimeZone = z.string().refine(isTimeZone, 'unknown timezone');
const zIfLateMinutes = z.number().int().min(0).max(MAX_IF_LATE_MINUTES);

const zQuietHoursOverride = z
  .strictObject({
    enabled: z.boolean(),
    start: z.string().regex(HH_MM).optional(),
    end: z.string().regex(HH_MM).optional(),
    timezone: zTimeZone.optional(),
  })
  .nullable();

const zFrequencyCap = z
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

const journeyShape = {
  ...commonFields,
  channel: z.enum(JOURNEY_TEMPLATE_CHANNELS),
  template: zStep.shape.template,
};
const registryShape = {
  ...commonFields,
  channel: z.enum(REGISTRY_TEMPLATE_CHANNELS),
  template: z.strictObject({
    templateId: z.string().min(1).max(MAX_TEMPLATE_ID),
  }),
};

export const zCampaignDraft = z.discriminatedUnion('channel', [
  z.strictObject(journeyShape),
  z.strictObject(registryShape),
]);

// The service re-checks a merged draft with this one: it drops fields a client may not set (confirmThreshold).
export const zCampaignFields = z.discriminatedUnion('channel', [
  z.object(journeyShape),
  z.object(registryShape),
]);

// Template and channel are checked together once merged into the stored draft.
export const zCampaignPatch = z
  .strictObject({
    ...commonFields,
    timezone: zTimeZone,
    ifLateMinutes: zIfLateMinutes,
    channel: z.enum([
      ...JOURNEY_TEMPLATE_CHANNELS,
      ...REGISTRY_TEMPLATE_CHANNELS,
    ]),
    template: z.unknown(),
  })
  .partial();

export type CampaignDraft = z.input<typeof zCampaignDraft>;
export type CampaignPatch = z.infer<typeof zCampaignPatch>;
