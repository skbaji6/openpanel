import { describe, expect, it } from 'bun:test';
import { zQuietHoursOverride } from '../campaign/definition';
import {
  CAMPAIGN_CHANNELS,
  checkChannelSettings,
  DEFAULT_CHANNEL_SETTINGS,
  effectiveQuietHours,
  zChannelSettings,
} from './settings';

const CHANNEL_QUIET = {
  enabled: true,
  start: '21:00',
  end: '08:00',
  timezone: 'Asia/Kolkata',
};

describe('channel settings', () => {
  it('defaults for every channel parse', () => {
    for (const channel of CAMPAIGN_CHANNELS) {
      expect(
        zChannelSettings.safeParse(DEFAULT_CHANNEL_SETTINGS[channel]).success
      ).toBe(true);
    }
  });

  it('sms with ratePerSecond null reports rate_required', () => {
    expect(checkChannelSettings('sms', DEFAULT_CHANNEL_SETTINGS.sms)).toEqual([
      'rate_required',
    ]);
    expect(
      checkChannelSettings('whatsapp', DEFAULT_CHANNEL_SETTINGS.whatsapp)
    ).toEqual(['rate_required']);
    expect(
      checkChannelSettings('sms', {
        ...DEFAULT_CHANNEL_SETTINGS.sms,
        ratePerSecond: 5,
      })
    ).toEqual([]);
  });

  it('email needs dailyQuota and ratePerSecond', () => {
    expect(
      checkChannelSettings('email', DEFAULT_CHANNEL_SETTINGS.email).sort()
    ).toEqual(['quota_required', 'rate_required']);
    expect(
      checkChannelSettings('email', {
        ...DEFAULT_CHANNEL_SETTINGS.email,
        ratePerSecond: 2,
        dailyQuota: 1000,
      })
    ).toEqual([]);
  });

  it('requireConsent on push is consent_not_supported', () => {
    for (const channel of ['push', 'email', 'webhook'] as const) {
      expect(
        checkChannelSettings(channel, {
          ...DEFAULT_CHANNEL_SETTINGS[channel],
          requireConsent: true,
        })
      ).toContain('consent_not_supported');
    }
    expect(
      checkChannelSettings('sms', {
        ...DEFAULT_CHANNEL_SETTINGS.sms,
        ratePerSecond: 1,
        requireConsent: true,
      })
    ).toEqual([]);
  });

  it('a quota on a non-email channel is quota_not_supported', () => {
    expect(
      checkChannelSettings('push', {
        ...DEFAULT_CHANNEL_SETTINGS.push,
        dailyQuota: 5,
      })
    ).toEqual(['quota_not_supported']);
  });

  it('an unknown timezone and 24:00 are rejected', () => {
    const base = DEFAULT_CHANNEL_SETTINGS.push;
    const withQuiet = (quietHours: object) =>
      zChannelSettings.safeParse({ ...base, quietHours }).success;
    expect(withQuiet({ ...CHANNEL_QUIET, timezone: 'Mars/Base' })).toBe(false);
    expect(withQuiet({ ...CHANNEL_QUIET, start: '24:00' })).toBe(false);
    expect(withQuiet(CHANNEL_QUIET)).toBe(true);
    expect(
      zChannelSettings.safeParse({ ...base, quotaTimezone: 'Mars/Base' })
        .success
    ).toBe(false);
  });

  it('rejects out-of-range numbers, bad currency and unknown keys', () => {
    const base = DEFAULT_CHANNEL_SETTINGS.sms;
    const bad = [
      { concurrency: 0 },
      { concurrency: 201 },
      { ratePerSecond: 0 },
      { ratePerSecond: 10_001 },
      { dailyQuota: 0 },
      { pricePerMessage: { amount: -1, currency: 'INR' } },
      { pricePerMessage: { amount: 1, currency: 'inr' } },
      { extra: 1 },
    ];
    for (const patch of bad) {
      expect(zChannelSettings.safeParse({ ...base, ...patch }).success).toBe(
        false
      );
    }
  });

  it('effectiveQuietHours: a null override uses the channel setting when enabled, none when disabled', () => {
    expect(effectiveQuietHours(CHANNEL_QUIET, null)).toEqual({
      start: '21:00',
      end: '08:00',
      timezone: 'Asia/Kolkata',
    });
    expect(
      effectiveQuietHours({ ...CHANNEL_QUIET, enabled: false }, null)
    ).toBe(null);
  });

  it('override enabled with only start inherits end and timezone', () => {
    expect(
      effectiveQuietHours(
        { ...CHANNEL_QUIET, enabled: false },
        { enabled: true, start: '22:30' }
      )
    ).toEqual({ start: '22:30', end: '08:00', timezone: 'Asia/Kolkata' });
  });

  it('override enabled false disables channel quiet hours', () => {
    expect(effectiveQuietHours(CHANNEL_QUIET, { enabled: false })).toBe(null);
  });

  it('quiet hours with start equal to end are rejected only when enabled', () => {
    const base = DEFAULT_CHANNEL_SETTINGS.push;
    const parse = (quietHours: object) =>
      zChannelSettings.safeParse({ ...base, quietHours }).success;
    expect(parse({ ...CHANNEL_QUIET, end: '21:00' })).toBe(false);
    expect(parse({ ...CHANNEL_QUIET, enabled: false, end: '21:00' })).toBe(
      true
    );
  });

  it('a campaign quiet hours override with start equal to end is rejected', () => {
    const parse = (value: unknown) =>
      zQuietHoursOverride.safeParse(value).success;
    expect(parse({ enabled: true, start: '09:00', end: '09:00' })).toBe(false);
    expect(parse({ enabled: false, start: '09:00', end: '09:00' })).toBe(true);
    expect(parse({ enabled: true, start: '09:00' })).toBe(true);
    expect(parse(null)).toBe(true);
  });
});
