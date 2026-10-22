import { describe, expect, it } from 'bun:test';
import {
  capAllows,
  inQuietHours,
  lagAllowsSending,
  nextAllowedTime,
} from './gates';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const CFG = { maxLag: 1000 };
const KOLKATA = { start: '22:00', end: '08:00', timezone: 'Asia/Kolkata' };

describe('gates', () => {
  it('lag gate false for null state, stale state (61 s), and lag above maxLag; true otherwise', () => {
    expect(lagAllowsSending(null, NOW, CFG)).toBe(false);
    expect(
      lagAllowsSending(
        { lag: 0, updatedAt: new Date(NOW.getTime() - 61_000) },
        NOW,
        CFG
      )
    ).toBe(false);
    expect(lagAllowsSending({ lag: 1001, updatedAt: NOW }, NOW, CFG)).toBe(
      false
    );
    expect(lagAllowsSending({ lag: 1000, updatedAt: NOW }, NOW, CFG)).toBe(
      true
    );
    expect(
      lagAllowsSending(
        { lag: 0, updatedAt: new Date(NOW.getTime() - 60_000) },
        NOW,
        CFG
      )
    ).toBe(true);
  });

  it('quiet hours 22:00-08:00 in Asia/Kolkata: 23:00 local is inside, 12:00 is outside; nextAllowedTime from 23:00 is 08:00 next day', () => {
    // 23:00 IST on 22 Oct is 17:30 UTC.
    const lateEvening = new Date('2026-10-22T17:30:00.000Z');
    const noon = new Date('2026-10-22T06:30:00.000Z');
    expect(inQuietHours(lateEvening, KOLKATA)).toBe(true);
    expect(inQuietHours(noon, KOLKATA)).toBe(false);
    expect(nextAllowedTime(lateEvening, KOLKATA).toISOString()).toBe(
      '2026-10-23T02:30:00.000Z'
    );
    expect(nextAllowedTime(noon, KOLKATA)).toEqual(noon);
  });

  it('quiet hours: early morning inside, end is exclusive, null and empty windows never quiet', () => {
    const early = new Date('2026-10-22T00:15:45.500Z'); // 05:45:45.5 IST
    expect(inQuietHours(early, KOLKATA)).toBe(true);
    expect(nextAllowedTime(early, KOLKATA).toISOString()).toBe(
      '2026-10-22T02:30:00.000Z'
    );
    expect(inQuietHours(new Date('2026-10-22T02:30:00.000Z'), KOLKATA)).toBe(
      false
    );
    expect(inQuietHours(NOW, null)).toBe(false);
    expect(nextAllowedTime(NOW, null)).toEqual(NOW);
    expect(
      inQuietHours(NOW, { start: '10:00', end: '10:00', timezone: 'UTC' })
    ).toBe(false);
    expect(
      inQuietHours(NOW, { start: '09:00', end: '17:00', timezone: 'UTC' })
    ).toBe(true);
  });

  it('nextAllowedTime lands on local end time across a DST change', () => {
    // Europe/Berlin leaves DST on 2026-10-25 at 03:00 local.
    const q = { start: '22:00', end: '08:00', timezone: 'Europe/Berlin' };
    const saturdayNight = new Date('2026-10-24T21:00:00.000Z'); // 23:00 CEST
    expect(nextAllowedTime(saturdayNight, q).toISOString()).toBe(
      '2026-10-25T07:00:00.000Z'
    );
  });

  it('capAllows is false at count >= max, true below; true when caps is null', () => {
    const caps = { max: 2, periodSeconds: 3600 };
    expect(capAllows(1, caps)).toBe(true);
    expect(capAllows(2, caps)).toBe(false);
    expect(capAllows(3, caps)).toBe(false);
    expect(capAllows(100, null)).toBe(true);
  });
});
