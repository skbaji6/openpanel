import { z } from 'zod';

// Copied from packages/marketing/src (campaign, audience, templates, channels); campaign-contract.test.ts
// compares the state, status, channel and operator lists with the service files as text.

export const CAMPAIGN_CHANNELS = [
  'push',
  'whatsapp',
  'sms',
  'email',
  'webhook',
] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

// Channels that send provider-approved templates from the registry.
export const PROVIDER_TEMPLATE_CHANNELS = ['sms', 'whatsapp'] as const;
export type ProviderTemplateChannel =
  (typeof PROVIDER_TEMPLATE_CHANNELS)[number];

// The channels the Templates tab edits. Email templates arrive with the email editor.
export const REGISTRY_TEMPLATE_CHANNELS = [
  ...PROVIDER_TEMPLATE_CHANNELS,
  'push',
] as const;
export type RegistryTemplateChannel =
  (typeof REGISTRY_TEMPLATE_CHANNELS)[number];

export const isProviderChannel = (
  channel: string
): channel is ProviderTemplateChannel =>
  PROVIDER_TEMPLATE_CHANNELS.some((candidate) => candidate === channel);

export const CAMPAIGN_STATES = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
  'missed',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const RECIPIENT_STATUSES = [
  'pending',
  'leased',
  'sending',
  'sent',
  'uncertain',
  'failed',
  'skipped',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const FILTER_OPS = [
  'eq',
  'in',
  'not_in',
  'gt',
  'lt',
  'between',
  'exists',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const MAX_FILTER_DEPTH = 3;
export const MAX_LIST_IDS = 20_000;
export const MAX_IDS_PER_CHANGE = 2000;
// The service rejects more than 200 distinct inputs per call (after trim and dedupe); the proxy body holds 1000.
export const MAX_RESOLVE_DISTINCT_INPUTS = 200;
export const MAX_RESOLVE_INPUT_LENGTH = 256;
// Also the largest leave-out list sent to the audience API, so previews cannot drop students past it.
export const MAX_ID_CONDITION_VALUES = 1000;
export const MAX_FILTER_STRING_LENGTH = 512;
export const MAX_PREVIEW_LIMIT = 50;
export const RESERVED_ID_DIMENSION = 'id';

const MAX_CAMPAIGN_NAME = 200;
const MAX_CAMPAIGN_KEY = 100;
const MAX_TEMPLATE_ID = 200;
const MAX_IF_LATE_MINUTES = 1440;
const DEFAULT_IF_LATE_MINUTES = 60;
const MAX_FREQUENCY = 10_000;
const MIN_PERIOD_SECONDS = 60;
const MAX_PERIOD_SECONDS = 31_536_000;
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const MAX_TIMEZONE_LENGTH = 64;
const MAX_SUBJECT_LENGTH = 300;
const MAX_BODY_LENGTH = 20_000;
const MAX_URL_LENGTH = 2000;
export const MAX_AUDIENCE_NAME = 200;
export const MAX_ID_LENGTH = 256;
const MAX_VARIABLES = 20;
const MAX_VARIABLE_VALUE_LENGTH = 500;
const MAX_APPROVED_TEXT_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_CONCURRENCY = 200;
const MAX_RATE_PER_SECOND = 10_000;
const MAX_PRICE = 1000;
const MAX_DAILY_QUOTA = 10_000_000;
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UNSAFE_LINK_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
]);

const SMS_SLOT = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const WHATSAPP_SLOT = /^(header|body|button)_[1-9][0-9]?$/;
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PROFILE_PLACEHOLDER = /^profile\.[A-Za-z0-9_]+$/;

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const zTimeZone = z
  .string()
  .max(MAX_TIMEZONE_LENGTH)
  .refine(isTimeZone, 'unknown timezone');

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const noVariables = (value: string) => !value.includes('{{');

export const zImageUrl = z
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

const zMessage = z.strictObject({
  subject: z.string().max(MAX_SUBJECT_LENGTH).optional(),
  body: z.string().max(MAX_BODY_LENGTH),
});
const zPushTemplate = z.strictObject({
  subject: z.string().max(MAX_SUBJECT_LENGTH).optional(),
  body: z.string().max(MAX_BODY_LENGTH),
  imageUrl: zImageUrl.optional(),
  link: zLink.optional(),
});
const zRegistryTemplateRef = z.strictObject({
  templateId: z.string().min(1).max(MAX_TEMPLATE_ID),
});

const zQuietHoursOverride = z
  .strictObject({
    enabled: z.boolean(),
    start: z.string().regex(HH_MM).optional(),
    end: z.string().regex(HH_MM).optional(),
    timezone: zTimeZone.optional(),
  })
  .refine((o) => !(o.enabled && o.start !== undefined && o.start === o.end), {
    message: 'start and end must differ',
    path: ['end'],
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
  timezone: zTimeZone.default(DEFAULT_TIMEZONE),
  ifLateMinutes: z
    .number()
    .int()
    .min(0)
    .max(MAX_IF_LATE_MINUTES)
    .default(DEFAULT_IF_LATE_MINUTES),
  quietHoursOverride: zQuietHoursOverride.optional(),
  frequencyCap: zFrequencyCap.optional(),
};

// Skipping earlier recipients is keyed on campaignKey, so without one it would silently skip no one.
export const zCampaignDraft = z
  .discriminatedUnion('channel', [
    z.strictObject({
      ...commonFields,
      channel: z.literal('push'),
      template: z.union([zPushTemplate, zRegistryTemplateRef]),
    }),
    z.strictObject({
      ...commonFields,
      channel: z.literal('email'),
      template: z.union([zMessage, zRegistryTemplateRef]),
    }),
    z.strictObject({
      ...commonFields,
      channel: z.literal('webhook'),
      template: zMessage,
    }),
    z.strictObject({
      ...commonFields,
      channel: z.enum(PROVIDER_TEMPLATE_CHANNELS),
      template: zRegistryTemplateRef,
    }),
  ])
  .refine(
    (draft) => !draft.skipPreviousRecipients || Boolean(draft.campaignKey),
    {
      message: 'skipPreviousRecipients needs a campaignKey',
      path: ['campaignKey'],
    }
  );
export type CampaignDraft = z.input<typeof zCampaignDraft>;

const zIdentifier = z.string().min(1).max(MAX_ID_LENGTH);

// A missing key must fail: null means "no filter" and has to be said.
const zExplicitFilter = z.custom<unknown>(
  (value) => value !== undefined,
  'filter is required, use null'
);

export const zAudienceInput = z.strictObject({
  name: z.string().trim().min(1).max(MAX_AUDIENCE_NAME),
  mode: z.enum(['dynamic', 'snapshot']),
  filter: zExplicitFilter,
  excludeFilter: zExplicitFilter,
});

export const zIdListChange = z
  .strictObject({
    list: z.enum(['include', 'exclude']),
    add: z.array(zIdentifier).max(MAX_IDS_PER_CHANGE).optional(),
    remove: z.array(zIdentifier).max(MAX_IDS_PER_CHANGE).optional(),
    clear: z.literal(true).optional(),
  })
  .refine(
    (change) => change.add?.length || change.remove?.length || change.clear,
    'add, remove or clear is required'
  );

// Only profile traits may be mapped: event data is attacker-controlled.
const onlyProfilePlaceholders = (value: string) =>
  [...value.matchAll(ANY_PLACEHOLDER)].every((match) =>
    PROFILE_PLACEHOLDER.test((match[1] ?? '').trim())
  );

const zSmsProviderRef = z.strictObject({
  flowId: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
  senderId: z
    .string()
    .regex(/^[A-Z]{6}$/)
    .optional(),
});
const zWhatsAppProviderRef = z.strictObject({
  templateName: z.string().regex(/^[a-z0-9_]{1,512}$/),
  namespace: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  integratedNumber: z
    .string()
    .regex(/^[0-9]{8,15}$/)
    .optional(),
});

export const zTemplateInput = z
  .strictObject({
    channel: z.enum(PROVIDER_TEMPLATE_CHANNELS),
    displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
    category: z.enum(['promotional', 'service']),
    providerRef: z.union([zSmsProviderRef, zWhatsAppProviderRef]),
    approvedText: z.string().min(1).max(MAX_APPROVED_TEXT_LENGTH),
    variables: z
      .array(
        z.strictObject({
          slot: z.string(),
          value: z
            .string()
            .max(MAX_VARIABLE_VALUE_LENGTH)
            .refine(
              onlyProfilePlaceholders,
              'only {{profile.<trait>}} placeholders'
            ),
        })
      )
      .max(MAX_VARIABLES),
  })
  .superRefine((input, ctx) => {
    const providerRef = (
      input.channel === 'sms' ? zSmsProviderRef : zWhatsAppProviderRef
    ).safeParse(input.providerRef);
    if (!providerRef.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerRef'],
        message: `not a valid ${input.channel} provider reference`,
      });
    }
    const slotPattern = input.channel === 'sms' ? SMS_SLOT : WHATSAPP_SLOT;
    const seen = new Set<string>();
    for (const [index, variable] of input.variables.entries()) {
      const path = ['variables', index, 'slot'];
      if (!slotPattern.test(variable.slot)) {
        ctx.addIssue({ code: 'custom', path, message: 'invalid slot' });
      } else if (seen.has(variable.slot)) {
        ctx.addIssue({ code: 'custom', path, message: 'duplicate slot' });
      }
      seen.add(variable.slot);
    }
  });
export type TemplateInput = z.infer<typeof zTemplateInput>;

// Push templates carry their text as content instead of a provider reference.
export interface PushTemplateInput {
  channel: 'push';
  displayName: string;
  category: 'promotional' | 'service';
  content: { subject?: string; body: string };
}

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

export const ISSUE_CODES = [
  'rate_required',
  'quota_required',
  'consent_not_supported',
  'quota_not_supported',
] as const satisfies readonly ChannelSettingsIssue[];

export interface ChannelSettingsResponse {
  channel: CampaignChannel;
  settings: ChannelSettings;
  version: number;
  configured: boolean;
  issues: ChannelSettingsIssue[];
}

export interface ProjectSettings {
  caps: {
    max: number;
    periodSeconds: number;
    scope?: 'channel' | 'all';
  } | null;
  quietHours: { start: string; end: string; timezone: string } | null;
}

export interface Condition {
  dimension: string;
  op: FilterOp;
  values: (string | number | boolean)[];
}
export interface FilterGroup {
  op: 'and' | 'or';
  children: FilterTree[];
}
export type FilterTree = Condition | FilterGroup;

export interface Dimension {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  multiValued: boolean;
  valuesListable: boolean;
}

export interface AudienceSchema {
  dimensions: Dimension[];
}

export interface DimensionValue {
  value: string;
  label: string;
}

export interface AudienceRow {
  id: string;
  projectId: string;
  name: string;
  mode: 'dynamic' | 'snapshot';
  filter: FilterTree | null;
  excludeFilter: FilterTree | null;
  includeCount: number;
  excludeCount: number;
  version: number;
  snapshotVersion: number | null;
  snapshotCount: number | null;
  snapshotAt: string | null;
  schemaCheckedAt: string | null;
  inUse: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AudienceCount {
  count: number;
  approximate: boolean;
  countedAt: string;
  filterCount: number | null;
  includeCount: number;
  excludeCount: number;
}

export interface CountPreview extends AudienceCount {
  campaignVersion: number;
  audienceVersion: number;
}

export interface Confirmation {
  count: number;
  channel: CampaignChannel;
  spreadOverDays?: boolean;
}

export interface CampaignCounters {
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  uncertain: number;
}

// The service strips its materialize lease and cursor fields from responses.
export interface CampaignRow {
  id: string;
  projectId: string;
  name: string;
  state: CampaignState;
  stateReason: string | null;
  channel: CampaignChannel;
  template: unknown;
  audienceId: string | null;
  audienceVersion: number | null;
  campaignKey: string | null;
  skipPreviousRecipients: boolean;
  sendKind: 'now' | 'scheduled' | null;
  sendAt: string | null;
  sendAtLocal: string | null;
  timezone: string;
  ifLateMinutes: number;
  quietHoursOverride: unknown;
  frequencyCap: unknown;
  confirmThreshold: number;
  countPreview: CountPreview | null;
  materializeState: 'not_started' | 'in_progress' | 'done' | 'failed';
  materializePhase: string | null;
  materializeError: string | null;
  materializeAttempts: number;
  templateVersion: number | null;
  dispatchError: string | null;
  dispatchRetryAt: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counters: CampaignCounters;
}

export interface RecipientRow {
  profileId: string;
  status: RecipientStatus;
  reason: string | null;
  attempt: number;
  providerRef: string | null;
  sentAt: string | null;
  updatedAt: string;
}

export type TestSendStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped';

export interface TestSendRow {
  id: string;
  profileId: string;
  status: TestSendStatus;
  reason: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface SkipReasonRow {
  status: 'skipped' | 'failed' | 'uncertain';
  reason: string;
  count: number;
}

export interface Estimate {
  count: number;
  channel: string;
  ratePerSecond: number | null;
  estimatedSeconds: number | null;
  cost: { amount: number; currency: string } | null;
  quota: {
    dailyQuota: number;
    usedToday: number;
    remainingToday: number;
    daysNeeded: number;
  } | null;
  issues: string[];
}

export interface TemplateVersion {
  templateId: string;
  version: number;
  displayName: string;
  category: 'promotional' | 'service';
  providerRef: unknown;
  approvedText: string;
  variables: { slot: string; value: string }[];
  // Push and email versions carry content instead of a provider reference.
  content?: unknown;
  createdBy: string;
  createdAt: string;
}

export interface TemplateRow extends TemplateVersion {
  projectId: string;
  channel: ProviderTemplateChannel | 'push' | 'email';
  enabled: boolean;
  currentVersion: number;
  updatedAt: string;
}

export interface RecipientsPage {
  recipients: RecipientRow[];
  nextCursor: string | null;
}

export interface SkipReasonsResponse {
  reasons: SkipReasonRow[];
}

export interface TestSendsResponse {
  testSends: TestSendRow[];
}

export interface AudiencePreview {
  members: { id: string; displayName?: string }[];
  nextCursor: string | null;
  exclusionsApplied: boolean;
}

export interface ResolveResponse {
  ids: string[];
  unmatchedPositions: number[];
}

export type ExplanationReason =
  | 'matched_filter'
  | 'not_matched'
  | 'included'
  | 'excluded_by_list'
  | 'excluded_by_filter';

export interface Explanation {
  id: string;
  verdict: 'in' | 'out';
  reasons: ExplanationReason[];
}

export interface IdsPage {
  ids: string[];
  nextCursor: string | null;
}
