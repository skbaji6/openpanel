import { beforeEach, describe, expect, it } from 'bun:test';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { webhookPath, webhookSecret } from '../tracking/keys';
import {
  createTrackingSettingsCache,
  DEFAULT_TRACKING_SETTINGS,
} from '../tracking/settings';
import { createServer } from './server';
import { createUnsubscribeUrlRenderer } from './unsubscribe';

const PROXY_SECRET = 'proxy-secret-for-tests';
const BASE = 'http://marketing.internal';
const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  MARKETING_PROXY_SECRET: PROXY_SECRET,
  MARKETING_PUBLIC_URL: 'https://marketing.test',
});

let trackingSettings = createTrackingSettingsCache({ sql });
let app = createServer({ cfg, sql, trackingSettings });

function call(
  method: string,
  path: string,
  body?: unknown,
  project = 'proj-a'
) {
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-marketing-proxy-secret': PROXY_SECRET,
        'x-marketing-project-id': project,
        'x-marketing-user-id': 'user-1',
        'x-marketing-csrf': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

beforeEach(async () => {
  trackingSettings = createTrackingSettingsCache({ sql });
  app = createServer({ cfg, sql, trackingSettings });
  await migrate();
  await resetMarketingTables();
});

describe('tracking settings routes', () => {
  it('PUT then GET returns the saved settings and effectivePublicUrl falls back to MARKETING_PUBLIC_URL', async () => {
    const before = await call('GET', '/marketing/tracking-settings');
    expect(await before.json()).toEqual({
      settings: DEFAULT_TRACKING_SETTINGS,
      effectivePublicUrl: 'https://marketing.test',
    });
    const settings = {
      ...DEFAULT_TRACKING_SETTINGS,
      campaignUrl: 'https://campaign.sianext.com/',
      conversionEvent: 'paid',
      conversionWindowDays: 14,
    };
    const put = await call('PUT', '/marketing/tracking-settings', settings);
    expect(put.status).toBe(200);
    const get = await call('GET', '/marketing/tracking-settings');
    expect(await get.json()).toEqual({
      settings: { ...settings, campaignUrl: 'https://campaign.sianext.com' },
      effectivePublicUrl: 'https://marketing.test',
    });
  });

  it('rejects an invalid body with 400 and issues', async () => {
    const res = await call('PUT', '/marketing/tracking-settings', {
      ...DEFAULT_TRACKING_SETTINGS,
      publicUrl: 'http://evil.example.com/x',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: unknown[] }).issues.length).toBe(1);
  });

  it("the webhook url uses the project's publicUrl when set", async () => {
    const fallback = await call('GET', '/marketing/tracking-settings/webhook');
    const secret = webhookSecret(cfg.encryptionKey, 'proj-a');
    expect(await fallback.json()).toEqual({
      url: `https://marketing.test${webhookPath('proj-a', secret)}`,
    });
    await call('PUT', '/marketing/tracking-settings', {
      ...DEFAULT_TRACKING_SETTINGS,
      publicUrl: 'https://panel.sianext.com',
    });
    const res = await call('GET', '/marketing/tracking-settings/webhook');
    expect(await res.json()).toEqual({
      url: `https://panel.sianext.com${webhookPath('proj-a', secret)}`,
    });
  });

  it('an unsubscribe link of a project with publicUrl set uses it within the cache ttl', async () => {
    const render = createUnsubscribeUrlRenderer(
      cfg,
      (id) => trackingSettings.peek(id)?.publicUrl
    );
    await trackingSettings.get('proj-b');
    expect(
      render('proj-b', 'u1', 'email').startsWith('https://marketing.test/')
    ).toBe(true);
    await call(
      'PUT',
      '/marketing/tracking-settings',
      { ...DEFAULT_TRACKING_SETTINGS, publicUrl: 'https://panel.sianext.com' },
      'proj-b'
    );
    expect(
      render('proj-b', 'u1', 'email').startsWith(
        'https://panel.sianext.com/marketing/unsubscribe?t='
      )
    ).toBe(true);
    expect(
      render('proj-a', 'u1', 'email').startsWith('https://marketing.test/')
    ).toBe(true);
  });
});
