import type { ComponentProps } from 'react';
import {
  type CampaignChannel,
  type CampaignRow,
  type CampaignState,
  zCampaignDraft,
  zImageUrl,
} from './campaign-contract';
import type { Badge } from '@/components/ui/badge';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_IF_LATE_MINUTES = '60';
const DEFAULT_CAP_MAX = '1';
const DEFAULT_CAP_PERIOD_HOURS = '24';
const SECONDS_PER_HOUR = 3600;
const MISSING_SEND_TIME = 'Pick the date and time to send';

export type QuietHoursChoice = 'channel' | 'off' | 'custom';

// Everything is kept as typed text; toDraftBody turns it into the API shape.
export interface CampaignForm {
  name: string;
  channel: CampaignChannel;
  audienceId: string;
  subject: string;
  body: string;
  imageUrl: string;
  link: string;
  templateId: string;
  sendKind: 'now' | 'scheduled';
  sendAtLocal: string;
  timezone: string;
  ifLateMinutes: string;
  quietHours: QuietHoursChoice;
  quietStart: string;
  quietEnd: string;
  quietTimezone: string;
  capEnabled: boolean;
  capMax: string;
  capPeriodHours: string;
  campaignKey: string;
  skipPreviousRecipients: boolean;
}

export interface CampaignProblem {
  path: string;
  message: string;
}

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>;

export const STATE_BADGE: Record<
  CampaignState,
  { label: string; variant: BadgeVariant }
> = {
  draft: { label: 'Draft', variant: 'secondary' },
  scheduled: { label: 'Scheduled', variant: 'outline' },
  running: { label: 'Sending', variant: 'info' },
  paused: { label: 'Paused', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' },
  missed: { label: 'Missed', variant: 'destructive' },
};

export const CHANNEL_LABELS: Record<CampaignChannel, string> = {
  push: 'Push',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  webhook: 'Webhook',
};

// sendAtLocal is wall-clock time in the campaign's zone, so it is shown as typed, never through the browser's zone.
export function sendTimeText(row: CampaignRow): string {
  if (row.sendAtLocal) {
    return `${row.sendAtLocal.replace('T', ' ')} ${row.timezone}`;
  }
  return 'When launched';
}

export function progressText(row: CampaignRow): string {
  if (!row.startedAt) {
    return '';
  }
  return `${row.counters.sent} / ${row.counters.queued}`;
}

const EMPTY_MESSAGE = {
  subject: '',
  body: '',
  imageUrl: '',
  link: '',
  templateId: '',
};

export function emptyCampaign(): CampaignForm {
  return {
    name: '',
    channel: 'push',
    audienceId: '',
    ...EMPTY_MESSAGE,
    sendKind: 'now',
    sendAtLocal: '',
    timezone: DEFAULT_TIMEZONE,
    ifLateMinutes: DEFAULT_IF_LATE_MINUTES,
    quietHours: 'channel',
    quietStart: '',
    quietEnd: '',
    quietTimezone: DEFAULT_TIMEZONE,
    capEnabled: false,
    capMax: DEFAULT_CAP_MAX,
    capPeriodHours: DEFAULT_CAP_PERIOD_HOURS,
    campaignKey: '',
    skipPreviousRecipients: false,
  };
}

// A message written for one channel does not fit another.
export function withChannel(
  form: CampaignForm,
  channel: CampaignChannel
): CampaignForm {
  return { ...form, ...EMPTY_MESSAGE, channel };
}

const numberOf = (text: string): number =>
  text.trim() === '' ? Number.NaN : Number(text);

const optional = (key: string, text: string) =>
  text.trim() === '' ? {} : { [key]: text.trim() };

function templateOf(form: CampaignForm): unknown {
  switch (form.channel) {
    case 'push':
      return {
        ...optional('subject', form.subject),
        body: form.body,
        ...optional('imageUrl', form.imageUrl),
        ...optional('link', form.link),
      };
    case 'email':
    case 'webhook':
      return { ...optional('subject', form.subject), body: form.body };
    default:
      return { templateId: form.templateId };
  }
}

function quietHoursOf(form: CampaignForm): unknown {
  if (form.quietHours === 'channel') {
    return null;
  }
  if (form.quietHours === 'off') {
    return { enabled: false };
  }
  return {
    enabled: true,
    start: form.quietStart,
    end: form.quietEnd,
    timezone: form.quietTimezone.trim(),
  };
}

// The API merges a PATCH over the stored draft, so cleared fields are sent as null rather than left out.
export function toDraftBody(form: CampaignForm): unknown {
  const scheduled = form.sendKind === 'scheduled';
  return {
    name: form.name.trim(),
    channel: form.channel,
    template: templateOf(form),
    audienceId: form.audienceId || null,
    campaignKey: form.campaignKey.trim() || null,
    skipPreviousRecipients: form.skipPreviousRecipients,
    sendAtLocal: scheduled && form.sendAtLocal ? form.sendAtLocal : null,
    timezone: form.timezone.trim(),
    ifLateMinutes: numberOf(form.ifLateMinutes),
    quietHoursOverride: quietHoursOf(form),
    frequencyCap: form.capEnabled
      ? {
          max: numberOf(form.capMax),
          periodSeconds: Math.round(
            numberOf(form.capPeriodHours) * SECONDS_PER_HOUR
          ),
        }
      : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

function quietChoiceOf(override: Record<string, unknown> | null) {
  if (override === null) {
    return 'channel';
  }
  return override.enabled === true ? 'custom' : 'off';
}

export function fromRow(row: CampaignRow): CampaignForm {
  const template = isRecord(row.template) ? row.template : {};
  const quiet = isRecord(row.quietHoursOverride)
    ? row.quietHoursOverride
    : null;
  const cap = isRecord(row.frequencyCap) ? row.frequencyCap : null;
  const empty = emptyCampaign();
  return {
    name: row.name,
    channel: row.channel,
    audienceId: row.audienceId ?? '',
    subject: textOf(template.subject),
    body: textOf(template.body),
    imageUrl: textOf(template.imageUrl),
    link: textOf(template.link),
    templateId: textOf(template.templateId),
    sendKind: row.sendAtLocal ? 'scheduled' : 'now',
    sendAtLocal: row.sendAtLocal ?? '',
    timezone: row.timezone,
    ifLateMinutes: String(row.ifLateMinutes),
    quietHours: quietChoiceOf(quiet),
    quietStart: textOf(quiet?.start),
    quietEnd: textOf(quiet?.end),
    quietTimezone: textOf(quiet?.timezone) || empty.quietTimezone,
    capEnabled: cap !== null,
    capMax: cap ? String(cap.max) : empty.capMax,
    capPeriodHours: cap
      ? String(Number(cap.periodSeconds) / SECONDS_PER_HOUR)
      : empty.capPeriodHours,
    campaignKey: row.campaignKey ?? '',
    skipPreviousRecipients: row.skipPreviousRecipients,
  };
}

export function campaignProblems(form: CampaignForm): CampaignProblem[] {
  const parsed = zCampaignDraft.safeParse(toDraftBody(form));
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
  if (form.sendKind === 'scheduled' && !form.sendAtLocal) {
    problems.push({ path: 'sendAtLocal', message: MISSING_SEND_TIME });
  }
  return problems;
}

export function pushPreview(form: CampaignForm): {
  title: string | null;
  body: string;
  imageUrl: string | null;
} {
  const image = zImageUrl.safeParse(form.imageUrl);
  return {
    title: form.subject.trim() || null,
    body: form.body,
    imageUrl: image.success ? image.data : null,
  };
}
