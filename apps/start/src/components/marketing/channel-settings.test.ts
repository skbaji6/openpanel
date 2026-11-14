import { describe, expect, test } from 'vitest';
import {
  CREDENTIAL_FIELDS,
  type SettingsForm,
  settingsFieldsFor,
  settingsProblems,
  toSettingsBody,
} from './channel-settings';

const form: SettingsForm = {
  concurrency: '4',
  ratePerSecond: '',
  quietEnabled: false,
  quietStart: '21:00',
  quietEnd: '08:00',
  quietTimezone: 'Asia/Kolkata',
  requireConsent: false,
  priceAmount: '',
  priceCurrency: 'INR',
  dailyQuota: '',
  quotaTimezone: 'Asia/Kolkata',
};

describe('toSettingsBody', () => {
  test('empty numbers become null and numbers parse', () => {
    expect(toSettingsBody(form).ratePerSecond).toBeNull();
    expect(toSettingsBody(form).pricePerMessage).toBeNull();
    expect(
      toSettingsBody({ ...form, ratePerSecond: '12.5' }).ratePerSecond
    ).toBe(12.5);
    expect(
      toSettingsBody({ ...form, priceAmount: '0.2' }).pricePerMessage
    ).toEqual({ amount: 0.2, currency: 'INR' });
  });
});

describe('settingsFieldsFor', () => {
  test('consent only for sms and whatsapp, quota only for email', () => {
    const push = settingsFieldsFor('push');
    expect(push).not.toContain('requireConsent');
    expect(push).not.toContain('dailyQuota');
    expect(settingsFieldsFor('sms')).toContain('requireConsent');
    expect(settingsFieldsFor('whatsapp')).toContain('requireConsent');
    expect(settingsFieldsFor('email')).toContain('dailyQuota');
    expect(settingsFieldsFor('email')).toContain('quotaTimezone');
    expect(settingsFieldsFor('email')).not.toContain('requireConsent');
  });
});

describe('settingsProblems', () => {
  test('flags equal quiet hours, non-positive rate and a bad currency', () => {
    expect(settingsProblems(form, 'sms')).toEqual([]);
    expect(
      settingsProblems(
        { ...form, quietEnabled: true, quietEnd: '21:00' },
        'sms'
      )
    ).toHaveLength(1);
    expect(
      settingsProblems({ ...form, ratePerSecond: '0' }, 'sms')
    ).toHaveLength(1);
    expect(
      settingsProblems({ ...form, ratePerSecond: '-2' }, 'sms')
    ).toHaveLength(1);
    expect(
      settingsProblems(
        { ...form, priceAmount: '1', priceCurrency: 'inr' },
        'sms'
      )
    ).toHaveLength(1);
  });
});

describe('credential fields', () => {
  test('sms and whatsapp fields match the MSG91 config', () => {
    expect(CREDENTIAL_FIELDS.sms.map((field) => field.key)).toEqual([
      'authKey',
      'baseUrl',
      'defaultCountryCode',
    ]);
    expect(CREDENTIAL_FIELDS.whatsapp.map((field) => field.key)).toEqual([
      'authKey',
      'integratedNumber',
      'baseUrl',
      'defaultCountryCode',
    ]);
    expect(CREDENTIAL_FIELDS.sms[0]?.secret).toBe(true);
  });
});
