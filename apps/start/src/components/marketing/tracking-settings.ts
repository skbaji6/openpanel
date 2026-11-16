import { z } from 'zod';

const MAX_URL_LENGTH = 200;
const MAX_EVENT_NAME_LENGTH = 200;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 30;
const PLAIN_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);

// Copy of the service's zBaseUrl: the dashboard never imports from packages/marketing.
const zBaseUrl = z
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
      return invalid('Use an address such as https://example.com');
    }
    const secure =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && PLAIN_HTTP_HOSTS.has(url.hostname));
    if (!secure) {
      return invalid('Use https');
    }
    const text = raw.toLowerCase();
    if (text !== url.origin && text !== `${url.origin}/`) {
      return invalid('Use only the address, without a path or query');
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

export interface TrackingForm {
  publicUrl: string;
  campaignUrl: string;
  conversionEvent: string;
  conversionWindowDays: string;
}

export function toTrackingForm(settings: TrackingSettings): TrackingForm {
  return {
    publicUrl: settings.publicUrl ?? '',
    campaignUrl: settings.campaignUrl ?? '',
    conversionEvent: settings.conversionEvent ?? '',
    conversionWindowDays: String(settings.conversionWindowDays),
  };
}

const orNull = (text: string) => (text.trim() === '' ? null : text);

function toCandidate(form: TrackingForm) {
  return {
    publicUrl: orNull(form.publicUrl),
    campaignUrl: orNull(form.campaignUrl),
    conversionEvent: orNull(form.conversionEvent),
    conversionWindowDays:
      form.conversionWindowDays.trim() === ''
        ? Number.NaN
        : Number(form.conversionWindowDays),
  };
}

// Call only when trackingProblems is empty.
export function toTrackingBody(form: TrackingForm): TrackingSettings {
  return zTrackingSettings.parse(toCandidate(form));
}

export function trackingProblems(
  form: TrackingForm
): { field: keyof TrackingSettings; message: string }[] {
  const result = zTrackingSettings.safeParse(toCandidate(form));
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => {
    const field = issue.path[0] as keyof TrackingSettings;
    return {
      field,
      message:
        field === 'conversionWindowDays'
          ? `Use a whole number from ${MIN_WINDOW_DAYS} to ${MAX_WINDOW_DAYS}`
          : issue.message,
    };
  });
}

export function exampleTrackedLink(campaignUrl: string | null): string | null {
  return campaignUrl ? `${campaignUrl.replace(/\/$/, '')}/marketing/r/…` : null;
}
