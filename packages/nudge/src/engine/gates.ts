const MAX_STATE_AGE_MS = 60_000;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;
const HALF_DAY_MINUTES = 720;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface QuietHours {
  start: string;
  end: string;
  timezone: string;
}

export interface Caps {
  max: number;
  periodSeconds: number;
}

export function lagAllowsSending(
  state: { lag: number; updatedAt: Date } | null,
  now: Date,
  cfg: { maxLag: number }
): boolean {
  if (!state) {
    return false;
  }
  // A clock-skewed future updatedAt is as untrustworthy as an old one.
  const isStale =
    Math.abs(now.getTime() - state.updatedAt.getTime()) > MAX_STATE_AGE_MS;
  return !isStale && state.lag <= cfg.maxLag;
}

function minutesOfDay(hhmm: string): number {
  const match = HH_MM.exec(hhmm);
  if (!match) {
    throw new Error(`invalid time of day: ${hhmm}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return part('hour') * 60 + part('minute');
}

// The window is [start, end) in the project's timezone and may wrap midnight.
export function inQuietHours(now: Date, q: QuietHours | null): boolean {
  if (!q) {
    return false;
  }
  const start = minutesOfDay(q.start);
  const end = minutesOfDay(q.end);
  const local = localMinutes(now, q.timezone);
  if (start === end) {
    return false;
  }
  if (start < end) {
    return local >= start && local < end;
  }
  return local >= start || local < end;
}

export function nextAllowedTime(now: Date, q: QuietHours | null): Date {
  if (!(q && inQuietHours(now, q))) {
    return now;
  }
  const end = minutesOfDay(q.end);
  const startOfMinute = now.getTime() - (now.getTime() % MS_PER_MINUTE);
  const wait =
    (end - localMinutes(now, q.timezone) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const candidate = startOfMinute + wait * MS_PER_MINUTE;
  // A DST change inside the wait shifts the local clock; correct by the drift.
  const drift =
    ((end -
      localMinutes(new Date(candidate), q.timezone) +
      MINUTES_PER_DAY +
      HALF_DAY_MINUTES) %
      MINUTES_PER_DAY) -
    HALF_DAY_MINUTES;
  return new Date(candidate + drift * MS_PER_MINUTE);
}

export function capAllows(count: number, caps: Caps | null): boolean {
  return !caps || count < caps.max;
}
