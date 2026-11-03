import { isTimeZone } from '../api/routes-dashboard';

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MS_PER_MINUTE = 60_000;

function zoneFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function wallClock(formatter: Intl.DateTimeFormat, instant: number) {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return parts;
}

// Whole minutes: the zone's offset from UTC at that instant.
function offsetAt(formatter: Intl.DateTimeFormat, instant: number) {
  const p = wallClock(formatter, instant);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute)
  );
  return asUtc - Math.floor(instant / MS_PER_MINUTE) * MS_PER_MINUTE;
}

// Returns null for a malformed string, an unknown zone, or a wall time the zone skips.
// An ambiguous (repeated) wall time resolves to whichever instant the two-pass offset lands on.
export function zonedTimeToUtc(local: string, timeZone: string): Date | null {
  const match = LOCAL_TIME.exec(local);
  if (!(match && isTimeZone(timeZone))) {
    return null;
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = zoneFormatter(timeZone);
  const first = guess - offsetAt(formatter, guess);
  const result = guess - offsetAt(formatter, first);
  const date = new Date(result);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const p = wallClock(formatter, result);
  const roundTrip = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  return roundTrip === local ? date : null;
}
