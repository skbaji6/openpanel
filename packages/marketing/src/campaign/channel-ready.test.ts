import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  DEFAULT_CHANNEL_SETTINGS,
  putChannelSettings,
} from '../channels/settings';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from '../templates/registry';
import { createChannelReady, pinTemplate } from './channel-ready';

const PROJECT = 'p1';
const CTX = { projectId: PROJECT, userId: 'u1' };
const NOW = new Date('2026-11-03T10:00:00.000Z');
const RATE = 5;

const registry = createTemplateRegistry({ sql, now: () => NOW });
const channelReady = createChannelReady({ sql, registry });

const SMS_TEMPLATE = {
  channel: 'sms' as const,
  displayName: 'Welcome',
  category: 'service' as const,
  providerRef: { flowId: 'abc123' },
  approvedText: 'Hi {#var#}',
  variables: [{ slot: 'var1', value: '{{profile.firstName}}' }],
};
const WHATSAPP_TEMPLATE = {
  channel: 'whatsapp' as const,
  displayName: 'Order',
  category: 'service' as const,
  providerRef: { templateName: 'order', namespace: 'ns', language: 'en' },
  approvedText: 'Hi {{1}}',
  variables: [{ slot: 'body_1', value: '{{profile.firstName}}' }],
};

const EMAIL_TEMPLATE = {
  channel: 'email' as const,
  displayName: 'Mail',
  category: 'service' as const,
  content: { subject: 'Hi', blocks: [{ type: 'text' }] },
};

async function configure(
  channel: 'sms' | 'push',
  ratePerSecond: number | null
) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, 'x')`,
    PROJECT,
    channel
  );
  await putChannelSettings(
    sql,
    PROJECT,
    channel,
    { ...DEFAULT_CHANNEL_SETTINGS[channel], ratePerSecond },
    0
  );
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
});

describe('channel readiness', () => {
  it('sms without channel credentials is channel_not_configured', async () => {
    const template = await registry.create(CTX, SMS_TEMPLATE);
    expect(
      await channelReady(PROJECT, 'sms', { templateId: template.templateId })
    ).toBe('channel_not_configured');
  });

  it('sms with credentials but ratePerSecond null is rate_required', async () => {
    await configure('sms', null);
    const template = await registry.create(CTX, SMS_TEMPLATE);
    expect(
      await channelReady(PROJECT, 'sms', { templateId: template.templateId })
    ).toBe('rate_required');
  });

  it('a disabled template is template_disabled', async () => {
    await configure('sms', RATE);
    const template = await registry.create(CTX, SMS_TEMPLATE);
    const ref = { templateId: template.templateId };
    expect(await channelReady(PROJECT, 'sms', ref)).toBeNull();
    await registry.setEnabled(CTX, template.templateId, false);
    expect(await channelReady(PROJECT, 'sms', ref)).toBe('template_disabled');
    expect(await channelReady(PROJECT, 'sms', { templateId: 'otp' })).toBe(
      'template_not_found'
    );
  });

  it('a whatsapp template id used on an sms campaign is template_channel_mismatch', async () => {
    await configure('sms', RATE);
    const template = await registry.create(CTX, WHATSAPP_TEMPLATE);
    expect(
      await channelReady(PROJECT, 'sms', { templateId: template.templateId })
    ).toBe('template_channel_mismatch');
  });

  it('push with credentials is ready', async () => {
    expect(await channelReady(PROJECT, 'push', {})).toBe(
      'channel_not_configured'
    );
    await configure('push', null);
    expect(await channelReady(PROJECT, 'push', {})).toBeNull();
  });

  it('a push ref is checked and pinned like a provider template; an email ref waits for the compiler', async () => {
    await configure('push', null);
    const push = await registry.create(CTX, {
      channel: 'push',
      displayName: 'Hi',
      category: 'service',
      content: { body: 'Hello' },
    });
    const email = await registry.create(CTX, EMAIL_TEMPLATE);
    const ref = { templateId: push.templateId };
    expect(await channelReady(PROJECT, 'push', ref)).toBeNull();
    expect(await pinTemplate(sql, PROJECT, 'push', ref)).toBe(1);
    expect(
      await channelReady(PROJECT, 'push', { templateId: email.templateId })
    ).toBe('template_channel_mismatch');
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, 'email', 'x')`,
      PROJECT
    );
    await putChannelSettings(
      sql,
      PROJECT,
      'email',
      {
        ...DEFAULT_CHANNEL_SETTINGS.email,
        ratePerSecond: RATE,
        dailyQuota: 1000,
      },
      0
    );
    expect(
      await channelReady(PROJECT, 'email', { templateId: email.templateId })
    ).toBe('template_mapping_missing');
    await registry.setEnabled(CTX, push.templateId, false);
    expect(await channelReady(PROJECT, 'push', ref)).toBe('template_disabled');
    expect(await pinTemplate(sql, PROJECT, 'push', ref)).toBeNull();
  });

  it('pinTemplate returns the current version of an enabled template of the channel', async () => {
    const template = await registry.create(CTX, SMS_TEMPLATE);
    const ref = { templateId: template.templateId };
    await registry.update(CTX, template.templateId, SMS_TEMPLATE, 1);
    expect(await pinTemplate(sql, PROJECT, 'sms', ref)).toBe(2);
    expect(await pinTemplate(sql, PROJECT, 'whatsapp', ref)).toBeNull();
    expect(await pinTemplate(sql, 'p2', 'sms', ref)).toBeNull();
    expect(await pinTemplate(sql, PROJECT, 'sms', { templateId: 'otp' })).toBe(
      null
    );
    await registry.setEnabled(CTX, template.templateId, false);
    expect(await pinTemplate(sql, PROJECT, 'sms', ref)).toBeNull();
    expect(await pinTemplate(sql, PROJECT, 'push', {})).toBe(0);
  });
});
