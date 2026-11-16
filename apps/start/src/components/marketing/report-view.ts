import type {
  DailyRow,
  Funnel,
  JourneyReport,
  MessageStatus,
  ReportConversion,
} from './contract';

const FUNNEL_KEYS = [
  'sent',
  'delivered',
  'read',
  'clicked',
  'converted',
] as const;

const FUNNEL_LABELS: Record<(typeof FUNNEL_KEYS)[number], string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  clicked: 'Clicked',
  converted: 'Converted',
};

const STATUS_LABELS: Record<MessageStatus, string> = {
  skipped: 'Skipped',
  uncertain: 'Uncertain',
  sent: 'Sent',
  failed: 'Failed',
  delivered: 'Delivered',
  read: 'Read',
  clicked: 'Clicked',
  converted: 'Converted',
};

const DEFAULT_VARIANT_KEY = 'default';
const NO_VARIANT_KEY = '';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const NOT_REPORTED_LABEL = 'Not reported';
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

export function statusLabel(status: MessageStatus): string {
  return STATUS_LABELS[status];
}

export function funnelSteps(funnel: Funnel, notReported: string[]) {
  return FUNNEL_KEYS.map((key) => {
    const count = notReported.includes(key) ? null : funnel[key];
    const percentOfSent =
      count === null || funnel.sent === 0 ? null : count / funnel.sent;
    return { key, label: FUNNEL_LABELS[key], count, percentOfSent };
  });
}

// A journey mixes channels: a milestone is blank only if no step reports it, partial if some steps omit it.
export function journeyNotReported(steps: { notReported: string[] }[]) {
  const omitted = (key: string) =>
    steps.filter((step) => step.notReported.includes(key)).length;
  const keys = FUNNEL_KEYS.filter((key) => omitted(key) > 0);
  return {
    all: keys.filter((key) => omitted(key) === steps.length),
    some: keys.filter((key) => omitted(key) < steps.length),
  };
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

export function dailySeries(
  daily: DailyRow[],
  statuses: Exclude<keyof DailyRow, 'day'>[]
): { day: string; [status: string]: number | string }[] {
  if (daily.length === 0) {
    return [];
  }
  const byDay = new Map(daily.map((row) => [row.day, row]));
  const days = daily.map((row) => row.day).sort();
  const last = days.at(-1) as string;
  const rows: { day: string; [status: string]: number | string }[] = [];
  for (let day = days[0]; day <= last; day = nextDay(day)) {
    const source = byDay.get(day);
    const row: { day: string; [status: string]: number | string } = { day };
    for (const status of statuses) {
      row[status] = source ? Number(source[status]) : 0;
    }
    rows.push(row);
  }
  return rows;
}

function variantLabel(variantKey: string): string {
  if (variantKey === NO_VARIANT_KEY) {
    return 'No message fitted';
  }
  return variantKey === DEFAULT_VARIANT_KEY ? 'Default' : variantKey;
}

export function variantRows(report: Pick<JourneyReport, 'variants'>) {
  return report.variants.map((row) => ({
    stepIndex: row.stepIndex,
    label: variantLabel(row.variantKey),
    sent: row.sent,
    skipped: row.skipped,
    failed: row.failed,
  }));
}

export function reportCopy(conversion: ReportConversion): string {
  const sent = 'Sent means the provider accepted the message.';
  if (conversion.event === null) {
    return `${sent} Conversions are off; set the conversion event in Channels.`;
  }
  return `${sent} A click or an app open can be counted without a delivery report, and a conversion means the student opened the app within ${conversion.windowDays} days of their last message, not that the message caused it.`;
}

export function browserTimeZone(): string {
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE
    );
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}
