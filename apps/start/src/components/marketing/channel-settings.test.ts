import { describe, expect, test } from 'vitest';
import {
  CREDENTIAL_FIELDS,
  channelStatus,
  rateHelp,
  type SettingsForm,
  settingsFieldsFor,
  settingsProblems,
  toSettingsBody,
  toSettingsForm,
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

  test('always carries all four quiet hours keys', () => {
    expect(Object.keys(toSettingsBody(form).quietHours).sort()).toEqual([
      'enabled',
      'end',
      'start',
      'timezone',
    ]);
  });

  test('a body survives a trip through the form', () => {
    const body = toSettingsBody({
      ...form,
      ratePerSecond: '12.5',
      quietEnabled: true,
      requireConsent: true,
      priceAmount: '0.2',
      dailyQuota: '900',
    });
    expect(toSettingsBody(toSettingsForm(body))).toEqual(body);
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
  const problemsOf = (patch: Partial<SettingsForm>, channel = 'sms' as const) =>
    settingsProblems({ ...form, ...patch }, channel);
  const emailProblemsOf = (patch: Partial<SettingsForm>) =>
    settingsProblems({ ...form, ...patch }, 'email');

  test('accepts the defaults', () => {
    expect(problemsOf({})).toEqual([]);
  });

  test('names which rule was broken', () => {
    expect(problemsOf({ quietEnabled: true, quietEnd: '21:00' })[0]).toMatch(
      /Quiet hours start and end/
    );
    expect(problemsOf({ ratePerSecond: '0' })[0]).toMatch(/Rate must be/);
    expect(problemsOf({ ratePerSecond: '10001' })[0]).toMatch(/Rate must be/);
    expect(problemsOf({ ratePerSecond: '10000' })).toEqual([]);
    expect(problemsOf({ concurrency: '0' })[0]).toMatch(/Concurrency/);
    expect(problemsOf({ concurrency: '201' })[0]).toMatch(/Concurrency/);
    expect(problemsOf({ concurrency: '2.5' })[0]).toMatch(/Concurrency/);
    expect(problemsOf({ priceAmount: '1001' })[0]).toMatch(/Price must be/);
    expect(problemsOf({ priceAmount: '-1' })[0]).toMatch(/Price must be/);
    expect(problemsOf({ priceAmount: '1', priceCurrency: 'inr' })[0]).toMatch(
      /Currency/
    );
  });

  test('daily quota and its time zone are checked for email only', () => {
    expect(emailProblemsOf({ dailyQuota: '0' })[0]).toMatch(/Daily quota/);
    expect(emailProblemsOf({ dailyQuota: '10000001' })[0]).toMatch(
      /Daily quota/
    );
    expect(emailProblemsOf({ dailyQuota: '500' })).toEqual([]);
    expect(emailProblemsOf({ quotaTimezone: ' ' })[0]).toMatch(
      /Quota time zone/
    );
    expect(problemsOf({ dailyQuota: '0', quotaTimezone: '' })).toEqual([]);
  });

  test('quiet hours time zone must be known once quiet hours are on', () => {
    expect(
      problemsOf({ quietEnabled: true, quietTimezone: 'Mars/Base' })[0]
    ).toMatch(/Quiet hours time zone/);
  });
});

describe('rateHelp', () => {
  test('differs by channel family', () => {
    expect(rateHelp('sms')).toBe(
      'Messages per second your MSG91 account allows. Required'
    );
    expect(rateHelp('whatsapp')).toBe(rateHelp('sms'));
    expect(rateHelp('email')).toBe(
      'Messages per second your mail provider allows. Required'
    );
    expect(rateHelp('push')).toBe(
      'Optional ceiling in messages per second. Leave empty for no limit'
    );
    expect(rateHelp('webhook')).toBe(rateHelp('push'));
  });
});

describe('channelStatus', () => {
  const base = { isAdmin: true, credentialsConfigured: true, issues: [] };

  test('ready only for an admin with credentials and no issues', () => {
    expect(channelStatus(base)).toEqual({ ready: true, lines: ['Ready'] });
  });

  test('unset credentials are never ready, even with no issues', () => {
    const status = channelStatus({ ...base, credentialsConfigured: false });
    expect(status.ready).toBe(false);
    expect(status.lines[0]).toBe('Credentials not set up');
  });

  test('credentials not set up come before the labelled issues', () => {
    const status = channelStatus({
      ...base,
      credentialsConfigured: false,
      issues: ['rate_required'],
    });
    expect(status.lines).toHaveLength(2);
    expect(status.lines[1]).not.toBe('rate_required');
  });

  test('a non-admin is never told ready', () => {
    expect(
      channelStatus({ isAdmin: false, credentialsConfigured: null, issues: [] })
    ).toEqual({ ready: false, lines: ['Sending settings complete'] });
    const withIssue = channelStatus({
      isAdmin: false,
      credentialsConfigured: null,
      issues: ['rate_required'],
    });
    expect(withIssue.ready).toBe(false);
    expect(withIssue.lines).toHaveLength(1);
  });

  test('an admin with credentials and an issue is not ready', () => {
    const status = channelStatus({ ...base, issues: ['rate_required'] });
    expect(status.ready).toBe(false);
    expect(status.lines).toHaveLength(1);
  });
});

describe('credential fields', () => {
  const required = (channel: 'sms' | 'whatsapp') =>
    Object.fromEntries(
      CREDENTIAL_FIELDS[channel].map((field) => [field.key, field.required])
    );

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

  test('required flags', () => {
    expect(required('sms')).toEqual({
      authKey: true,
      baseUrl: false,
      defaultCountryCode: false,
    });
    expect(required('whatsapp')).toEqual({
      authKey: true,
      integratedNumber: true,
      baseUrl: false,
      defaultCountryCode: false,
    });
  });
});
