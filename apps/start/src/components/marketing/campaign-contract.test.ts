import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CAMPAIGN_CHANNELS,
  CAMPAIGN_STATES,
  FILTER_OPS,
  RECIPIENT_STATUSES,
  zAudienceInput,
  zCampaignDraft,
  zChannelSettings,
  zTemplateInput,
} from './campaign-contract';

// Read as text, not imported: the dashboard must not depend on the service package's source.
const read = (path: string) =>
  readFileSync(
    new URL(`../../../../../packages/marketing/src/${path}`, import.meta.url),
    'utf8'
  );

// The quoted words between a marker and the closing bracket that follows it.
function quotedWords(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  const end = source.indexOf(']', start);
  if (start === -1 || end === -1) {
    throw new Error(`${marker} not found`);
  }
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(
    (match) => match[1] as string
  );
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  name: 'Welcome',
  channel: 'push',
  template: { body: 'Hi' },
  ...overrides,
});

describe('campaign contract mirrors the service', () => {
  test('states', () => {
    expect([...CAMPAIGN_STATES]).toEqual(
      quotedWords(read('campaign/state.ts'), 'CAMPAIGN_STATES')
    );
  });

  test('recipient statuses', () => {
    expect([...RECIPIENT_STATUSES]).toEqual(
      quotedWords(read('campaign/recipients.ts'), 'RECIPIENT_STATUSES')
    );
  });

  test('campaign channels', () => {
    expect([...CAMPAIGN_CHANNELS]).toEqual(
      quotedWords(read('channels/settings.ts'), 'CAMPAIGN_CHANNELS')
    );
  });

  test('filter ops', () => {
    expect([...FILTER_OPS]).toEqual(
      quotedWords(read('audience/contract.ts'), 'export const zOp')
    );
  });
});

describe('zCampaignDraft', () => {
  test('accepts a minimal push draft and one with image and link', () => {
    expect(zCampaignDraft.safeParse(draft()).success).toBe(true);
    expect(
      zCampaignDraft.safeParse(
        draft({
          template: {
            body: 'Hi',
            imageUrl: 'https://cdn.example.test/a.png',
            link: 'sia://course/12',
          },
        })
      ).success
    ).toBe(true);
  });

  test('rejects skipPreviousRecipients without a campaignKey', () => {
    expect(
      zCampaignDraft.safeParse(draft({ skipPreviousRecipients: true })).success
    ).toBe(false);
    expect(
      zCampaignDraft.safeParse(
        draft({ skipPreviousRecipients: true, campaignKey: 'k' })
      ).success
    ).toBe(true);
  });

  test('rejects a push imageUrl that is not https, variables, unsafe links and extra keys', () => {
    for (const template of [
      { body: 'Hi', imageUrl: 'http://x.test/a.png' },
      { body: 'Hi', imageUrl: 'https://x.test/{{a}}.png' },
      { body: 'Hi', link: 'javascript:alert(1)' },
      { body: 'Hi', extra: 1 },
    ]) {
      expect(zCampaignDraft.safeParse(draft({ template })).success).toBe(false);
    }
  });

  test('imageUrl is not allowed on an email draft', () => {
    expect(
      zCampaignDraft.safeParse(
        draft({
          channel: 'email',
          template: { body: 'Hi', imageUrl: 'https://x.test/a.png' },
        })
      ).success
    ).toBe(false);
  });

  test('sms needs a templateId', () => {
    expect(
      zCampaignDraft.safeParse(
        draft({ channel: 'sms', template: { templateId: 't1' } })
      ).success
    ).toBe(true);
    expect(zCampaignDraft.safeParse(draft({ channel: 'sms' })).success).toBe(
      false
    );
  });
});

describe('other schemas', () => {
  test('audience input needs an explicit filter and excludeFilter', () => {
    expect(
      zAudienceInput.safeParse({ name: 'a', mode: 'dynamic' }).success
    ).toBe(false);
    expect(
      zAudienceInput.safeParse({
        name: 'a',
        mode: 'dynamic',
        filter: null,
        excludeFilter: null,
      }).success
    ).toBe(true);
  });

  test('template input checks sender id and variable values', () => {
    const sms = {
      channel: 'sms',
      displayName: 'Promo',
      category: 'promotional',
      providerRef: { flowId: 'abc123', senderId: 'SIAAPP' },
      approvedText: 'Hi ##name##',
      variables: [{ slot: 'name', value: '{{profile.firstName}}' }],
    };
    expect(zTemplateInput.safeParse(sms).success).toBe(true);
    expect(
      zTemplateInput.safeParse({
        ...sms,
        providerRef: { flowId: 'abc123', senderId: 'abc123' },
      }).success
    ).toBe(false);
    expect(
      zTemplateInput.safeParse({
        ...sms,
        variables: [{ slot: 'name', value: '{{event.x}}' }],
      }).success
    ).toBe(false);
  });

  test('channel settings reject equal quiet hours and a bad currency', () => {
    const settings = {
      concurrency: 4,
      ratePerSecond: 5,
      quietHours: {
        enabled: true,
        start: '21:00',
        end: '08:00',
        timezone: 'Asia/Kolkata',
      },
      requireConsent: false,
      pricePerMessage: { amount: 0.1, currency: 'INR' },
      dailyQuota: null,
      quotaTimezone: 'Asia/Kolkata',
    };
    expect(zChannelSettings.safeParse(settings).success).toBe(true);
    expect(
      zChannelSettings.safeParse({
        ...settings,
        quietHours: { ...settings.quietHours, end: '21:00' },
      }).success
    ).toBe(false);
    expect(
      zChannelSettings.safeParse({
        ...settings,
        pricePerMessage: { amount: 1, currency: 'inr' },
      }).success
    ).toBe(false);
  });
});
