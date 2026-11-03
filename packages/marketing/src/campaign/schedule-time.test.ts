import { describe, expect, it } from 'bun:test';
import { zonedTimeToUtc } from './schedule-time';

function formatInZone(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

describe('zonedTimeToUtc', () => {
  it('converts Asia/Kolkata 09:00 to 03:30Z', () => {
    expect(
      zonedTimeToUtc('2026-11-10T09:00', 'Asia/Kolkata')?.toISOString()
    ).toBe('2026-11-10T03:30:00.000Z');
  });

  it('corrects the offset when the guess falls on the other side of a transition', () => {
    expect(
      zonedTimeToUtc('2026-03-08T03:30', 'America/New_York')?.toISOString()
    ).toBe('2026-03-08T07:30:00.000Z');
  });
  it('returns null for a time inside a DST gap', () => {
    expect(zonedTimeToUtc('2026-03-08T02:30', 'America/New_York')).toBeNull();
  });

  it('resolves an ambiguous time to an instant that round-trips', () => {
    const ambiguous = '2026-11-01T01:30';
    const result = zonedTimeToUtc(ambiguous, 'America/New_York');
    expect(result).not.toBeNull();
    expect(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']).toContain(
      result!.toISOString()
    );
    expect(formatInZone(result!, 'America/New_York')).toBe(ambiguous);
  });

  it('returns null for an unknown zone', () => {
    expect(zonedTimeToUtc('2026-11-10T09:00', 'Mars/Olympus')).toBeNull();
  });

  it('returns null for an impossible date or malformed string', () => {
    expect(zonedTimeToUtc('2026-02-30T10:00', 'UTC')).toBeNull();
    expect(zonedTimeToUtc('2026-02-10 10:00', 'UTC')).toBeNull();
  });
});
