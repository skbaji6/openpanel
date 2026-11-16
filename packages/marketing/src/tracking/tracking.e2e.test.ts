import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { encryptCredential } from '@openpanel/shared/server';
import { createServer } from '../api/server';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import type { SourceResolver } from '../audience/resolver';
import {
  CFG,
  createClock,
  dispatchDeps,
  drain,
  ENCRYPTION_KEY,
  insertRunningCampaign,
  redis,
} from '../campaign/dispatch.test-helpers';
import { perRecipientBatch } from '../channels/batch';
import { createFakeFcm } from '../channels/fakes/fcm';
import { smsReportFor } from '../channels/fakes/msg91-reports';
import { type FakeMsg91, startFakeMsg91 } from '../channels/fakes/msg91-server';
import { createMsg91SmsAdapter } from '../channels/msg91-sms';
import { createPushAdapter, type MulticastSender } from '../channels/push';
import {
  registerBatchAdapter,
  unregisterBatchAdapter,
} from '../channels/registry';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createBatchHandler } from '../kafka/consumer';
import { createTemplateRegistry } from '../templates/registry';
import { createConversionRecorder } from './conversions';
import { webhookPath, webhookSecret } from './keys';
import { campaignReport } from './reports';
import {
  createTrackingSettingsCache,
  DEFAULT_TRACKING_SETTINGS,
  putTrackingSettings,
} from './settings';

const SMS_PROJECT = 'e2e-sms';
const PUSH_PROJECT = 'e2e-push';
const BASE = 'http://marketing.internal';
const CAMPAIGN_URL = 'https://c.test';
const APP_OPEN = 'app_open';
const SMS_RECIPIENTS = 300;
const SMS_FAILED = 3;
const PUSH_RECIPIENTS = 3;
const COUNTRY_CODE = '91';
const SETUP_TIMEOUT_MS = 120_000;
const HOUR_MS = 3_600_000;
const LANDING_PATH = '/landing?a=1&b=2';
const TIME_ZONE = 'UTC';
const FAKE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'e2e',
  client_email: 'e2e@e2e.example.test',
  private_key: 'not-a-real-key',
});

const phoneOf = (index: number) => `9${String(index).padStart(9, '0')}`;
const smsId = (index: number) => `e2e-student-${index}`;
const pushId = (index: number) => `e2e-push-${index}`;

const members: FakeMember[] = [
  ...Array.from({ length: SMS_RECIPIENTS }, (_, i) => ({
    id: smsId(i),
    values: {},
    displayName: `Student ${i}`,
    contact: { phone: phoneOf(i) },
    traits: { firstName: `Student${i}` },
  })),
  ...Array.from({ length: PUSH_RECIPIENTS }, (_, i) => ({
    id: pushId(i),
    values: {},
    traits: {},
    devices: [{ token: `token-${pushId(i)}`, platform: 'android' as const }],
  })),
];

const source = createFakeSource({ members });
const resolver = {
  forProject: async () => source,
  invalidate: () => undefined,
} as unknown as SourceResolver;

const cfg = { ...CFG, proxySecret: 'proxy', trustProxy: true };
const app = createServer({ cfg, sql, redis, sources: resolver });

let msg91: FakeMsg91;
let landing: ReturnType<typeof Bun.serve>;
const landingHits: string[] = [];
const pushLinks = new Map<string, string>();
const clock = createClock();

const fcm = createFakeFcm();
const recordingFcm: MulticastSender = (json, multicast) => {
  for (const token of multicast.tokens) {
    pushLinks.set(token, multicast.data?.link ?? '');
  }
  return fcm(json, multicast);
};

const fakeInterest = {
  has: async () => false,
  hasMany: async (queries: unknown[]) => queries.map(() => false),
  refresh: async () => undefined,
  add: async () => undefined,
};

const one = async <T>(query: string, ...params: unknown[]) =>
  (await sql.$queryRawUnsafe<T[]>(query, ...params))[0] as T;

describe('tracking end to end', () => {
  let targetUrl: string;
  let smsCampaign: string;
  let pushCampaign: string;

  beforeAll(async () => {
    await migrate();
    await resetMarketingTables();
    msg91 = await startFakeMsg91();
    landing = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const url = new URL(req.url);
        landingHits.push(url.pathname + url.search);
        return new Response('landing');
      },
    });
    targetUrl = `http://127.0.0.1:${landing.port}${LANDING_PATH}`;

    registerBatchAdapter(
      createMsg91SmsAdapter({
        now: clock.ms,
        allowHosts: [new URL(msg91.baseUrl).hostname],
      })
    );
    registerBatchAdapter(
      perRecipientBatch(
        createPushAdapter({ sendMulticast: recordingFcm }),
        clock.ms
      )
    );

    const template = await createTemplateRegistry({
      sql,
      now: clock.now,
    }).create(
      { projectId: SMS_PROJECT, userId: 'u1' },
      {
        channel: 'sms',
        displayName: 'Offer',
        category: 'service',
        providerRef: { flowId: 'flowe2e' },
        approvedText: 'Hello ##name##',
        variables: [{ slot: 'name', value: '{{profile.firstName}}' }],
      }
    );
    smsCampaign = await insertRunningCampaign({
      project: SMS_PROJECT,
      now: clock.now(),
      channel: 'sms',
      recipients: Array.from({ length: SMS_RECIPIENTS }, (_, i) => smsId(i)),
      template: { templateId: template.templateId },
      templateVersion: 1,
      settings: { ratePerSecond: 1000 },
    });
    await sql.$executeRawUnsafe(
      'UPDATE marketing.channel_configs SET config_encrypted = $3 WHERE project_id = $1 AND channel = $2',
      SMS_PROJECT,
      'sms',
      encryptCredential(
        ENCRYPTION_KEY,
        JSON.stringify({
          authKey: 'e2e-auth-key-0123456789',
          baseUrl: msg91.baseUrl,
        })
      )
    );

    pushCampaign = await insertRunningCampaign({
      project: PUSH_PROJECT,
      now: clock.now(),
      channel: 'push',
      recipients: Array.from({ length: PUSH_RECIPIENTS }, (_, i) => pushId(i)),
      template: { body: 'Hello', link: targetUrl },
    });
    await sql.$executeRawUnsafe(
      'UPDATE marketing.channel_configs SET config_encrypted = $3 WHERE project_id = $1 AND channel = $2',
      PUSH_PROJECT,
      'push',
      encryptCredential(
        ENCRYPTION_KEY,
        JSON.stringify({ serviceAccountJson: FAKE_SERVICE_ACCOUNT })
      )
    );

    await putTrackingSettings(sql, PUSH_PROJECT, {
      ...DEFAULT_TRACKING_SETTINGS,
      campaignUrl: CAMPAIGN_URL,
      conversionEvent: APP_OPEN,
    });
    const settings = createTrackingSettingsCache({ sql });
    await drain(
      dispatchDeps(source, clock, { trackingSettings: settings }),
      clock
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    unregisterBatchAdapter('sms');
    unregisterBatchAdapter('push');
    await msg91.close();
    await landing.stop(true);
  });

  it('delivery reports posted over HTTP mark the SMS rows delivered or failed', async () => {
    const rows = await sql.$queryRawUnsafe<
      { provider_ref: string; profile_id: string }[]
    >(
      `SELECT provider_ref, profile_id FROM marketing.message_tracking
       WHERE campaign_id = $1::uuid ORDER BY profile_id`,
      smsCampaign
    );
    expect(rows.length).toBe(SMS_RECIPIENTS);
    const byRequest = new Map<string, { phone: string; status: '1' | '2' }[]>();
    rows.forEach((row, position) => {
      const index = Number(row.profile_id.split('-').at(-1));
      const failed = position < SMS_FAILED;
      byRequest.set(row.provider_ref, [
        ...(byRequest.get(row.provider_ref) ?? []),
        {
          phone: `${COUNTRY_CODE}${phoneOf(index)}`,
          status: failed ? '2' : '1',
        },
      ]);
    });
    expect(byRequest.size).toBeGreaterThan(1);
    const path = webhookPath(
      SMS_PROJECT,
      webhookSecret(ENCRYPTION_KEY, SMS_PROJECT)
    );
    for (const [requestId, entries] of byRequest) {
      const response = await app.fetch(
        new Request(`${BASE}${path}`, {
          method: 'POST',
          body: JSON.stringify(smsReportFor(requestId, entries)),
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '10.0.0.9',
          },
        })
      );
      expect(response.status).toBe(200);
    }
    const report = await campaignReport(
      sql,
      SMS_PROJECT,
      smsCampaign,
      TIME_ZONE
    );
    expect(report?.statuses.delivered).toBe(SMS_RECIPIENTS - SMS_FAILED);
    expect(report?.statuses.failed).toBe(SMS_FAILED);
    expect(report?.funnel.delivered).toBe(SMS_RECIPIENTS - SMS_FAILED);
    expect(report?.notReported).toEqual(['read', 'clicked']);
  });

  it('a push link goes through the redirect to exactly the stored url, and an app open converts', async () => {
    const link = pushLinks.get(`token-${pushId(0)}`) ?? '';
    const prefix = `${CAMPAIGN_URL}/marketing/r/`;
    expect(link.startsWith(prefix)).toBe(true);
    const redirect = await app.fetch(
      new Request(`${BASE}/marketing/r/${link.slice(prefix.length)}`, {
        headers: { 'x-forwarded-for': '10.0.0.8' },
      })
    );
    expect(redirect.status).toBe(302);
    const stored = await one<{ url: string }>(
      'SELECT url FROM marketing.tracked_links WHERE project_id = $1',
      PUSH_PROJECT
    );
    expect(stored.url).toBe(targetUrl);
    const location = redirect.headers.get('location') ?? '';
    expect(location).toBe(stored.url);
    await fetch(location);
    expect(landingHits).toEqual([LANDING_PATH]);

    const sent = await one<{ at: Date }>(
      'SELECT max(sent_at) AS at FROM marketing.message_tracking WHERE project_id = $1',
      PUSH_PROJECT
    );
    const openedAt = new Date(sent.at.getTime() + HOUR_MS);
    const handle = createBatchHandler({
      conversions: createConversionRecorder({
        sql,
        now: () => new Date(openedAt.getTime() + 60_000),
        ttlMs: 0,
      }),
      engine: { handleEvents: async () => undefined },
      interest: fakeInterest,
      logger: { warn: () => undefined, error: () => undefined },
    });
    await handle([
      Buffer.from(
        JSON.stringify({
          id: 'e2e-open-1',
          projectId: PUSH_PROJECT,
          deviceId: 'device-1',
          event: {
            name: APP_OPEN,
            profileId: pushId(0),
            properties: {},
            timestamp: openedAt.toISOString(),
          },
        })
      ),
    ]);

    const report = await campaignReport(
      sql,
      PUSH_PROJECT,
      pushCampaign,
      TIME_ZONE
    );
    expect(report?.funnel).toMatchObject({
      sent: PUSH_RECIPIENTS,
      clicked: 1,
      converted: 1,
    });
    expect(report?.statuses.converted).toBe(1);
    expect(report?.statuses.sent).toBe(PUSH_RECIPIENTS - 1);
    expect(report?.notReported).toEqual(['delivered', 'read']);
  });

  it('no phone number is stored in the tracking tables', async () => {
    const phones = Array.from({ length: SMS_RECIPIENTS }, (_, i) =>
      phoneOf(i)
    ).join('|');
    const tables = await sql.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'marketing'
       AND (tablename LIKE '%track%' OR tablename LIKE '%link%' OR tablename LIKE '%variant%')`
    );
    expect(tables.length).toBeGreaterThan(1);
    for (const { tablename } of tables) {
      const hit = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM marketing."${tablename}" t WHERE t::text ~ $1`,
        phones
      );
      expect({ tablename, hits: hit.n }).toEqual({ tablename, hits: 0 });
    }
  });
});
