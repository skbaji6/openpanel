import type { CampaignChannel, ChannelSettings } from './campaign-contract';
import { labelSettingsIssue } from './reason-labels';

export type CredentialKind =
  | 'text'
  | 'number'
  | 'boolean'
  | 'secret'
  | 'secretLines'
  | 'secretJson';

export interface CredentialField {
  key: string;
  label: string;
  help: string;
  secret: boolean;
  required: boolean;
  kind: CredentialKind;
}

const BASE_URL_HELP = "Leave empty for MSG91's own address";
const COUNTRY_CODE_HELP = 'Added to 10-digit numbers. India is 91';
const AUTH_KEY_HELP = 'Your MSG91 auth key. Saved, then never shown again';

const baseUrlField: CredentialField = {
  key: 'baseUrl',
  label: 'Base URL',
  help: BASE_URL_HELP,
  secret: false,
  required: false,
  kind: 'text',
};
const countryCodeField: CredentialField = {
  key: 'defaultCountryCode',
  label: 'Default country code',
  help: COUNTRY_CODE_HELP,
  secret: false,
  required: false,
  kind: 'text',
};
const authKeyField: CredentialField = {
  key: 'authKey',
  label: 'MSG91 auth key',
  help: AUTH_KEY_HELP,
  secret: true,
  required: true,
  kind: 'secret',
};

export const CREDENTIAL_FIELDS: Record<CampaignChannel, CredentialField[]> = {
  email: [
    {
      key: 'host',
      label: 'SMTP host',
      help: 'The mail server address',
      secret: false,
      required: true,
      kind: 'text',
    },
    {
      key: 'port',
      label: 'SMTP port',
      help: 'Usually 587, or 465 with TLS from the start',
      secret: false,
      required: true,
      kind: 'number',
    },
    {
      key: 'secure',
      label: 'Use TLS from the start (port 465)',
      help: 'Turn on only for port 465',
      secret: false,
      required: true,
      kind: 'boolean',
    },
    {
      key: 'user',
      label: 'SMTP user',
      help: 'Leave empty if the server needs no login',
      secret: false,
      required: false,
      kind: 'text',
    },
    {
      key: 'pass',
      label: 'SMTP password',
      help: 'Leave empty if the server needs no login',
      secret: true,
      required: false,
      kind: 'secret',
    },
    {
      key: 'from',
      label: 'From address',
      help: 'The sender shown to students',
      secret: false,
      required: true,
      kind: 'text',
    },
  ],
  webhook: [
    {
      key: 'url',
      label: 'URL',
      help: 'Must be https.',
      secret: false,
      required: true,
      kind: 'text',
    },
    {
      key: 'secrets',
      label: 'Signing secrets',
      help: 'One per line, at most two: the first signs, the second is accepted during rotation.',
      secret: true,
      required: true,
      kind: 'secretLines',
    },
  ],
  push: [
    {
      key: 'serviceAccountJson',
      label: 'Firebase service account JSON',
      help: 'Paste the whole JSON file from your Firebase project settings',
      secret: true,
      required: true,
      kind: 'secretJson',
    },
  ],
  sms: [authKeyField, baseUrlField, countryCodeField],
  whatsapp: [
    authKeyField,
    {
      key: 'integratedNumber',
      label: 'WhatsApp number',
      help: 'The business number connected in MSG91, digits only with country code',
      secret: false,
      required: true,
      kind: 'text',
    },
    baseUrlField,
    countryCodeField,
  ],
};

export type SettingsField =
  | 'concurrency'
  | 'ratePerSecond'
  | 'quietHours'
  | 'requireConsent'
  | 'pricePerMessage'
  | 'dailyQuota'
  | 'quotaTimezone';

const CONSENT_CHANNELS: CampaignChannel[] = ['sms', 'whatsapp'];

export function settingsFieldsFor(channel: CampaignChannel): SettingsField[] {
  const fields: SettingsField[] = [
    'concurrency',
    'ratePerSecond',
    'quietHours',
  ];
  if (CONSENT_CHANNELS.includes(channel)) {
    fields.push('requireConsent');
  }
  fields.push('pricePerMessage');
  if (channel === 'email') {
    fields.push('dailyQuota', 'quotaTimezone');
  }
  return fields;
}

export interface SettingsForm {
  concurrency: string;
  ratePerSecond: string;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  quietTimezone: string;
  requireConsent: boolean;
  priceAmount: string;
  priceCurrency: string;
  dailyQuota: string;
  quotaTimezone: string;
}

const DEFAULT_CURRENCY = 'INR';
const CURRENCY = /^[A-Z]{3}$/;

const numberOrNull = (text: string): number | null =>
  text.trim() === '' ? null : Number(text);

const textOrEmpty = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

export function toSettingsForm(settings: ChannelSettings): SettingsForm {
  return {
    concurrency: String(settings.concurrency),
    ratePerSecond: textOrEmpty(settings.ratePerSecond),
    quietEnabled: settings.quietHours.enabled,
    quietStart: settings.quietHours.start,
    quietEnd: settings.quietHours.end,
    quietTimezone: settings.quietHours.timezone,
    requireConsent: settings.requireConsent,
    priceAmount: textOrEmpty(settings.pricePerMessage?.amount),
    priceCurrency: settings.pricePerMessage?.currency ?? DEFAULT_CURRENCY,
    dailyQuota: textOrEmpty(settings.dailyQuota),
    quotaTimezone: settings.quotaTimezone,
  };
}

export function toSettingsBody(form: SettingsForm): ChannelSettings {
  const amount = numberOrNull(form.priceAmount);
  return {
    concurrency: Number(form.concurrency),
    ratePerSecond: numberOrNull(form.ratePerSecond),
    quietHours: {
      enabled: form.quietEnabled,
      start: form.quietStart,
      end: form.quietEnd,
      timezone: form.quietTimezone,
    },
    requireConsent: form.requireConsent,
    pricePerMessage:
      amount === null ? null : { amount, currency: form.priceCurrency.trim() },
    dailyQuota: numberOrNull(form.dailyQuota),
    quotaTimezone: form.quotaTimezone,
  };
}

const MAX_CONCURRENCY = 200;
const MAX_RATE_PER_SECOND = 10_000;
const MAX_PRICE = 1000;
const MAX_DAILY_QUOTA = 10_000_000;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function settingsProblems(
  form: SettingsForm,
  channel: CampaignChannel
): string[] {
  const problems: string[] = [];
  const concurrency = Number(form.concurrency);
  if (
    !(
      Number.isInteger(concurrency) &&
      concurrency >= 1 &&
      concurrency <= MAX_CONCURRENCY
    )
  ) {
    problems.push(
      `Concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}`
    );
  }
  const rate = numberOrNull(form.ratePerSecond);
  if (rate !== null && !(rate > 0 && rate <= MAX_RATE_PER_SECOND)) {
    problems.push(
      `Rate must be more than 0 and at most ${MAX_RATE_PER_SECOND}`
    );
  }
  if (form.quietEnabled && form.quietStart === form.quietEnd) {
    problems.push('Quiet hours start and end must differ');
  }
  if (form.quietEnabled && !isTimeZone(form.quietTimezone)) {
    problems.push('Quiet hours time zone is not a known time zone');
  }
  const amount = numberOrNull(form.priceAmount);
  if (amount !== null && !(amount >= 0 && amount <= MAX_PRICE)) {
    problems.push(`Price must be from 0 to ${MAX_PRICE}`);
  }
  if (amount !== null && !CURRENCY.test(form.priceCurrency.trim())) {
    problems.push('Currency is three capital letters, for example INR');
  }
  if (settingsFieldsFor(channel).includes('dailyQuota')) {
    const quota = numberOrNull(form.dailyQuota);
    if (
      quota !== null &&
      !(Number.isInteger(quota) && quota >= 1 && quota <= MAX_DAILY_QUOTA)
    ) {
      problems.push(
        `Daily quota must be a whole number from 1 to ${MAX_DAILY_QUOTA}`
      );
    }
    if (!isTimeZone(form.quotaTimezone)) {
      problems.push('Quota time zone is not a known time zone');
    }
  }
  return problems;
}

export function rateHelp(channel: CampaignChannel): string {
  if (channel === 'sms' || channel === 'whatsapp') {
    return 'Messages per second your MSG91 account allows. Required';
  }
  if (channel === 'email') {
    return 'Messages per second your mail provider allows. Required';
  }
  return 'Optional ceiling in messages per second. Leave empty for no limit';
}

export interface ChannelStatus {
  ready: boolean;
  lines: string[];
}

// credentialsConfigured is null when unknown (non-admins never fetch credentials).
export function channelStatus(input: {
  isAdmin: boolean;
  credentialsConfigured: boolean | null;
  issues: string[];
}): ChannelStatus {
  const labelled = input.issues.map(labelSettingsIssue);
  if (input.credentialsConfigured === false) {
    return { ready: false, lines: ['Credentials not set up', ...labelled] };
  }
  if (!(input.isAdmin && input.credentialsConfigured === true)) {
    return {
      ready: false,
      lines: labelled.length > 0 ? labelled : ['Sending settings complete'],
    };
  }
  return labelled.length > 0
    ? { ready: false, lines: labelled }
    : { ready: true, lines: ['Ready'] };
}
