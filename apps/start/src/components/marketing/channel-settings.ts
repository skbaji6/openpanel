import type { CampaignChannel, ChannelSettings } from './campaign-contract';

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

export function settingsProblems(
  form: SettingsForm,
  channel: CampaignChannel
): string[] {
  const problems: string[] = [];
  const concurrency = Number(form.concurrency);
  if (!(Number.isInteger(concurrency) && concurrency >= 1)) {
    problems.push('Concurrency must be a whole number of at least 1');
  }
  const rate = numberOrNull(form.ratePerSecond);
  if (rate !== null && !(rate > 0)) {
    problems.push('Rate must be more than 0');
  }
  if (form.quietEnabled && form.quietStart === form.quietEnd) {
    problems.push('Quiet hours start and end must differ');
  }
  const amount = numberOrNull(form.priceAmount);
  if (amount !== null && !(amount >= 0)) {
    problems.push('Price must be 0 or more');
  }
  if (amount !== null && !CURRENCY.test(form.priceCurrency.trim())) {
    problems.push('Currency is three capital letters, for example INR');
  }
  const quota = numberOrNull(form.dailyQuota);
  const quotaApplies = settingsFieldsFor(channel).includes('dailyQuota');
  if (
    quotaApplies &&
    quota !== null &&
    !(Number.isInteger(quota) && quota >= 1)
  ) {
    problems.push('Daily quota must be a whole number of at least 1');
  }
  return problems;
}
