import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import { audienceSourceRoutes } from '../api/routes-audience-source';
import { createServer } from '../api/server';
import type { FilterTree, Schema } from '../audience/contract';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import { createSourceResolver } from '../audience/resolver';
import {
  campaignService,
  createClock,
  dispatchDeps,
  drain,
  insertRunningCampaign,
} from '../campaign/dispatch.test-helpers';
import { runMaterializeTick } from '../campaign/materialize-runner';
import { retryUncertain } from '../campaign/operator';
import { runTestSendTick } from '../campaign/test-sends';
import { perRecipientBatch } from '../channels/batch';
import { createPooledEmailAdapter } from '../channels/email';
import { createFakeFcm } from '../channels/fakes/fcm';
import { smsReportFor } from '../channels/fakes/msg91-reports';
import {
  extractPhones,
  SMS_PATH,
  startFakeMsg91,
  WHATSAPP_PATH,
} from '../channels/fakes/msg91-server';
import { startFakeSmtp } from '../channels/fakes/smtp-server';
import { createMsg91SmsAdapter } from '../channels/msg91-sms';
import { createMsg91WhatsAppAdapter } from '../channels/msg91-whatsapp';
import { createPushAdapter } from '../channels/push';
import {
  getAdapter,
  registerAdapter,
  registerBatchAdapter,
  unregisterBatchAdapter,
} from '../channels/registry';
import { CAMPAIGN_CHANNELS } from '../channels/settings';
import type {
  ChannelAdapter,
  ChannelId,
  Recipient,
  RenderedMessage,
} from '../channels/types';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { redactSecrets } from '../redact';
import type { RuleDefinition } from '../rules/rule.schema';
import { createTemplateRegistry } from '../templates/registry';
import { webhookPath, webhookSecret } from '../tracking/keys';
import { createEngine } from './engine';
import { recipientValues, runTick } from './ticker';

// What a source-backed project must never persist or log: it is looked up per send and forgotten.
const CANARY_EMAIL = 'pii-canary@example.test';
const CANARY_PHONE = '919999900001';
const CANARY_TOKEN = 'canary-fcm-token-1';
const CANARY_NAME = 'Canary Student';
const CANARY_AUTH_KEY = 'msg91-pii-canary-auth-key-0123456789';
const CANARY_STATE = 'ZZ-canary-state';
const CANARIES = [
  CANARY_STATE,
  CANARY_EMAIL,
  CANARY_PHONE,
  CANARY_TOKEN,
  CANARY_NAME,
  CANARY_AUTH_KEY,
];
// A plaintext value in a bytea column shows up as hex in row_to_json.
const CANARY_FORMS = CANARIES.flatMap((canary) => [
  canary.toLowerCase(),
  Buffer.from(canary).toString('hex'),
  Buffer.from(canary).toString('base64'),
]);

const NOW = new Date('2026-10-22T12:00:00.000Z');
const HOUR = 3600;
const DUE = new Date(NOW.getTime() - 10 * 60_000);
const PROJECT = 'project-pii';
const ENCRYPTION_KEY = 'a'.repeat(64);
const SOURCE_SECRET = 'source-secret-for-pii-test';
const MAX_TICKS = 6;
const PROXY_SECRET = 'proxy-secret-for-pii-test';
const SCHEMA: Schema = {
  dimensions: [
    {
      key: 'plan',
      label: 'Plan',
      type: 'string',
      multiValued: false,
      valuesListable: true,
    },
  ],
};
const PRO_FILTER: FilterTree = { dimension: 'plan', op: 'eq', values: ['pro'] };

const CFG: MarketingConfig = {
  databaseUrl: '',
  redisUrl: '',
  encryptionKey: ENCRYPTION_KEY,
  proxySecret: '',
  publicUrl: 'https://marketing.test',
  port: 4100,
  trustProxy: false,
  graceSeconds: 300,
  maxLag: 1000,
  tickMs: 5000,
  leaseSeconds: 120,
  retentionDays: 30,
  claimBatch: 200,
  sendConcurrency: 10,
  campaignConcurrency: 2,
  dbPool: 10,
  sourceConcurrency: 4,
  lookupWindowMs: 0,
  maxLatenessSeconds: 86_400,
  confirmThreshold: 5000,
  webhookAllowHosts: [],
  kafka: { brokers: [], clientId: '', topic: '', groupId: '', ssl: false },
};

const redis = getRedisCache();
const clock = NOW;
const engine = createEngine({ sql, now: () => clock });

type SendFailure = 'throw_with_address' | 'code_only';
let sends: { channel: ChannelId; msg: RenderedMessage; to: Recipient }[] = [];
let failures = new Map<string, SendFailure>();
let malformedProfiles = new Set<string>();
let redisKeysDuringLookup: string[] = [];
let logged: string[] = [];
let spies: { mockRestore(): void }[] = [];
const ADAPTER_IDS: ChannelId[] = ['email', 'webhook', 'push'];
const originalAdapters: ChannelAdapter<unknown>[] = [];

function capturingAdapter(id: ChannelId): ChannelAdapter<{ secret: string }> {
  return {
    id,
    configSchema: z.object({ secret: z.string() }),
    send(msg, to) {
      sends.push({ channel: id, msg, to });
      const failure = failures.get(to.profileId);
      if (failure === 'throw_with_address') {
        // What an unexpected library exception can look like: the recipient inside the message.
        throw new Error(
          `delivery refused for ${to.email} (${to.deviceTokens.join(',')}) ${CANARY_NAME}`
        );
      }
      if (failure === 'code_only') {
        return Promise.resolve({
          ok: false,
          retryable: false,
          reason: 'smtp 550',
        });
      }
      return Promise.resolve({
        ok: true,
        invalidTokens: id === 'push' ? [CANARY_TOKEN] : undefined,
      });
    },
  };
}

function canaryEntry(id: string) {
  return {
    id,
    status: 'ok',
    email: CANARY_EMAIL,
    phone: CANARY_PHONE,
    devices: [{ token: CANARY_TOKEN, platform: 'android' }],
    traits: {
      firstName: CANARY_NAME,
      phone: CANARY_PHONE,
      state: CANARY_STATE,
    },
  };
}

async function scanRedis(): Promise<string[]> {
  const lines: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      lines.push(key, ...(await redisValues(key)));
    }
  } while (cursor !== '0');
  return lines;
}

async function redisValues(key: string): Promise<string[]> {
  switch (await redis.type(key)) {
    case 'string':
      return [(await redis.get(key)) ?? ''];
    case 'hash':
      return Object.entries(await redis.hgetall(key)).flat();
    case 'list':
      return await redis.lrange(key, 0, -1);
    case 'set':
      return await redis.smembers(key);
    case 'zset':
      return await redis.zrange(key, 0, -1, 'WITHSCORES');
    default:
      return [];
  }
}

async function scanTables(): Promise<{ tables: number; text: string[] }> {
  const tables = await sql.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'marketing' AND table_type = 'BASE TABLE'`
  );
  const text: string[] = [];
  for (const { table_name } of tables) {
    const rows = await sql.$queryRawUnsafe<{ j: string }[]>(
      `SELECT row_to_json(t)::text AS j FROM marketing."${table_name}" t`
    );
    text.push(...rows.map((row) => `${table_name}: ${row.j}`));
  }
  return { tables: tables.length, text };
}

function leaks(haystack: string[]): string[] {
  return haystack.filter((line) => {
    const lower = line.toLowerCase();
    return CANARY_FORMS.some((form) => lower.includes(form.toLowerCase()));
  });
}

function definition(): RuleDefinition {
  return {
    name: 'pii rule',
    trigger: { event: 'purchase' },
    goal: { kind: 'event', event: 'opened' },
    steps: [
      {
        delaySeconds: HOUR,
        channel: 'email',
        template: { subject: 'Hi {{profile.firstName}}', body: 'one' },
        variants: {
          TS: { subject: 'TS {{profile.firstName}}', body: 'ts' },
          AP: { subject: 'AP {{profile.firstName}}', body: 'ap' },
        },
      },
      {
        delaySeconds: 2 * HOUR,
        channel: 'push',
        template: { body: 'two {{profile.firstName}}' },
      },
      {
        delaySeconds: 3 * HOUR,
        channel: 'webhook',
        template: { body: 'three {{profile.firstName}}' },
      },
    ],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
  };
}

async function enroll(profileId: string): Promise<void> {
  const def = definition();
  const ruleId = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, $3, 'active', $4::jsonb)`,
    ruleId,
    PROJECT,
    `${def.name} ${profileId}`,
    JSON.stringify(def)
  );
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
     VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5, 'active', $6::timestamptz)`,
    id,
    PROJECT,
    ruleId,
    JSON.stringify(def),
    profileId,
    new Date(DUE.getTime() - HOUR * 1000).toISOString()
  );
  for (let index = 0; index < def.steps.length; index++) {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status, attempt)
       VALUES ($1::uuid, $2, $3::timestamptz, 'pending', 0)`,
      id,
      index,
      DUE.toISOString()
    );
  }
}

async function tickUntilQuiet(): Promise<void> {
  const resolver = createSourceResolver({
    sql,
    cfg: CFG,
    redis,
    now: () => clock.getTime(),
    fetch: (async (_url: string, init: RequestInit) => {
      redisKeysDuringLookup.push(
        ...(await scanRedis()).filter((line) => line.startsWith('marketing:'))
      );
      const body = JSON.parse(String(init.body)) as { ids: string[] };
      const entries = body.ids.map((id) =>
        malformedProfiles.has(id)
          ? {
              ...canaryEntry(id),
              traits: { firstName: { nested: CANARY_NAME } },
            }
          : canaryEntry(id)
      );
      return Response.json({ entries });
    }) as unknown as typeof fetch,
  });
  for (let round = 0; round < MAX_TICKS; round++) {
    const result = await runTick({
      sql,
      engine,
      now: () => clock,
      cfg: CFG,
      renderUnsubscribeUrl: () => 'https://marketing.test/u',
      logger: {
        warn: (...args: unknown[]) => logged.push(JSON.stringify(args)),
      },
      sources: resolver,
    });
    if (result.sent + result.failed + result.skipped + result.postponed === 0) {
      return;
    }
  }
}

describe('personal data from an http audience source', () => {
  beforeAll(async () => {
    for (const id of ADAPTER_IDS) {
      try {
        originalAdapters.push(getAdapter(id));
      } catch {
        // nothing registered yet
      }
    }
    await migrate();
  });
  beforeEach(async () => {
    sends = [];
    failures = new Map();
    malformedProfiles = new Set();
    redisKeysDuringLookup = [];
    logged = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(
        spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logged.push(
            args
              .map((arg) =>
                arg instanceof Error
                  ? `${arg.message}\n${arg.stack}`
                  : typeof arg === 'string'
                    ? arg
                    : JSON.stringify(arg)
              )
              .join(' ')
          );
        })
      );
    }
    await resetMarketingTables();
    await sql.$executeRawUnsafe(
      'INSERT INTO marketing.consumer_state (id, lag, updated_at) VALUES (1, 0, $1::timestamptz)',
      NOW.toISOString()
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.audience_sources (project_id, kind, base_url, key_id, secret_encrypted)
       VALUES ($1, 'http', 'https://owner.test/internal/audience', 'k1', $2)`,
      PROJECT,
      encryptCredential(ENCRYPTION_KEY, SOURCE_SECRET)
    );
    for (const channel of ['email', 'webhook', 'push'] as const) {
      registerAdapter(capturingAdapter(channel));
      await sql.$executeRawUnsafe(
        'INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)',
        PROJECT,
        channel,
        encryptCredential(ENCRYPTION_KEY, JSON.stringify({ secret: 's' }))
      );
    }
  });
  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
    spies = [];
  });
  afterAll(async () => {
    for (const adapter of originalAdapters) {
      registerAdapter(adapter);
    }
    await resetMarketingTables();
    await sql.$disconnect();
    redis.disconnect();
  });

  // Every place personal data could land; the scans must also have looked at something.
  async function scanEverything() {
    const { tables, text } = await scanTables();
    return {
      scanned: tables > 5 && text.length > 0,
      leaked: [
        ...leaks(text),
        ...leaks(await scanRedis()),
        ...leaks(redisKeysDuringLookup),
        ...leaks(logged),
      ],
    };
  }

  it('a multi-step journey uses the canaries but stores and logs none of them', async () => {
    await enroll('u1');
    await enroll('u2');
    await tickUntilQuiet();

    // Without this the scans below prove nothing: the data must have flowed through the send path.
    const channels = new Set(sends.map((send) => send.channel));
    expect([...channels].sort()).toEqual(['email', 'push', 'webhook']);
    const email = sends.find((send) => send.channel === 'email');
    expect(email?.to.email).toBe(CANARY_EMAIL);
    expect(email?.msg.subject).toBe(`Hi ${CANARY_NAME}`);
    expect(
      sends.find((send) => send.channel === 'push')?.to.deviceTokens
    ).toEqual([CANARY_TOKEN]);
    expect(
      sends.find((send) => send.channel === 'webhook')?.to.attributes
    ).toMatchObject({
      firstName: CANARY_NAME,
      state: CANARY_STATE,
    });
    // The semaphore key was live while a lookup ran, so the Redis scan saw real marketing keys.
    expect(redisKeysDuringLookup.length).toBeGreaterThan(0);
    // The token the push channel rejected is kept as a hash only.
    const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM marketing.dead_tokens'
    );
    expect(row?.n).toBe(1);

    expect(await scanEverything()).toEqual({ scanned: true, leaked: [] });
  });

  it('failing sends and protocol errors leave no canary in tables, Redis or logs', async () => {
    failures.set('u-throws', 'throw_with_address');
    failures.set('u-code', 'code_only');
    for (const profile of ['u-throws', 'u-code']) {
      await enroll(profile);
    }
    await tickUntilQuiet();

    // The failing paths were really taken, with the canaries as the recipient.
    const failedTo = sends.filter(
      (send) =>
        failures.has(send.to.profileId) && send.to.email === CANARY_EMAIL
    );
    expect(failedTo.length).toBeGreaterThanOrEqual(2);
    const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM marketing.steps WHERE status = 'failed' OR attempt > 0`
    );
    expect(row?.n).toBeGreaterThan(0);

    expect(await scanEverything()).toEqual({ scanned: true, leaked: [] });
  });

  it('switching a stored project to http removes its stored contacts and devices', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.contacts (project_id, profile_id, email, attributes)
       VALUES ($1, 'u-stored', $2, $3::jsonb)`,
      PROJECT,
      CANARY_EMAIL,
      JSON.stringify({ name: CANARY_NAME, phone: CANARY_PHONE })
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.devices (token, project_id, profile_id, platform)
       VALUES ($1, $2, 'u-stored', 'android')`,
      CANARY_TOKEN,
      PROJECT
    );
    expect(leaks((await scanTables()).text).length).toBeGreaterThan(0);
    const put = audienceSourceRoutes({
      cfg: CFG,
      sql,
      redis,
      resolver: createSourceResolver({ sql, cfg: CFG, redis }),
    }).find((route) => route.method === 'PUT');
    const url = new URL('http://marketing.internal/marketing/audience-source');
    const res = await put?.handle({
      req: new Request(url, {
        method: 'PUT',
        body: JSON.stringify({
          kind: 'http',
          baseUrl: 'https://owner.test/internal/audience',
          keyId: 'k1',
          secret: SOURCE_SECRET,
        }),
      }),
      url,
      params: [],
      projectId: PROJECT,
      userId: '',
      ip: '127.0.0.1',
    });
    expect(res?.status).toBe(200);
    expect(await scanEverything()).toEqual({ scanned: true, leaked: [] });
  });

  it('a lookup entry that fails validation leaves no canary in tables, Redis or logs', async () => {
    malformedProfiles.add('u-malformed');
    await enroll('u-malformed');
    await tickUntilQuiet();

    expect(sends).toHaveLength(0);
    const [row] = await sql.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM marketing.audience_sources WHERE project_id = $1',
      PROJECT
    );
    expect(row?.status).toBe('source_error');

    expect(await scanEverything()).toEqual({ scanned: true, leaked: [] });
  });

  it('an audience and campaign built from canary members store and log none of them', async () => {
    const canary: FakeMember = {
      id: 'canary-1',
      values: { plan: 'pro' },
      displayName: CANARY_NAME,
      contact: { phone: CANARY_PHONE, email: CANARY_EMAIL },
      traits: { firstName: CANARY_NAME },
      devices: [{ token: CANARY_TOKEN, platform: 'android' }],
    };
    const members = [
      canary,
      { id: 'plain-1', values: { plan: 'pro' } },
      { id: 'plain-2', values: { plan: 'free' } },
    ];
    const sources = {
      forProject: async () => createFakeSource({ members, schema: SCHEMA }),
      invalidate: () => undefined,
    } as unknown as ReturnType<typeof createSourceResolver>;
    const cfg = { ...CFG, proxySecret: PROXY_SECRET };
    const app = createServer({
      cfg,
      sql,
      redis,
      sources,
      now: () => clock.getTime(),
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.fetch(
        new Request(`http://marketing.internal${path}`, {
          method,
          headers: {
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            'x-marketing-proxy-secret': PROXY_SECRET,
            'x-marketing-project-id': PROJECT,
            'x-marketing-user-id': 'user-pii',
            'x-marketing-csrf': '1',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      );
      const text = await res.text();
      return {
        status: res.status,
        body: (text ? JSON.parse(text) : null) as Record<string, unknown>,
      };
    };

    const resolved = await call('POST', '/marketing/audience/resolve', {
      inputs: [CANARY_PHONE, CANARY_EMAIL],
    });
    expect(resolved.body).toEqual({
      ids: ['canary-1'],
      unmatchedPositions: [],
    });
    const created = await call('POST', '/marketing/audiences', {
      name: 'Canaries',
      mode: 'snapshot',
      filter: PRO_FILTER,
      excludeFilter: null,
    });
    expect(created.status).toBe(201);
    const audienceId = created.body.id as string;
    const changed = await call(
      'POST',
      `/marketing/audiences/${audienceId}/ids`,
      {
        list: 'include',
        add: resolved.body.ids,
        expectedVersion: created.body.version,
      }
    );
    expect(changed.status).toBe(200);
    // The preview really carried the canary name, so the scan below is not vacuous.
    const previewed = await call(
      'POST',
      `/marketing/audiences/${audienceId}/preview`,
      {}
    );
    expect(previewed.body.members).toContainEqual({
      id: 'canary-1',
      displayName: CANARY_NAME,
    });
    const explained = await call(
      'POST',
      `/marketing/audiences/${audienceId}/explain`,
      { id: 'canary-1' }
    );
    expect(explained.body.verdict).toBe('in');
    const frozen = await call(
      'POST',
      `/marketing/audiences/${audienceId}/freeze`
    );
    expect(frozen.status).toBe(200);

    const campaign = await call('POST', '/marketing/campaigns', {
      name: 'Canary launch',
      channel: 'push',
      template: { subject: 'Hi', body: 'Hello' },
      audienceId,
    });
    expect(campaign.status).toBe(201);
    const campaignId = campaign.body.id as string;
    expect(
      (await call('POST', `/marketing/campaigns/${campaignId}/count-preview`))
        .status
    ).toBe(200);
    const started = await call(
      'POST',
      `/marketing/campaigns/${campaignId}/start`
    );
    expect(started.body.state).toBe('running');
    await runMaterializeTick({ sql, sources, redis, cfg, now: () => clock });
    const [recipients] = await sql.$queryRawUnsafe<{ ids: string[] }[]>(
      `SELECT array_agg(profile_id ORDER BY profile_id) AS ids
       FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid`,
      campaignId
    );
    expect(recipients?.ids).toEqual(['canary-1', 'plain-1']);

    expect(await scanEverything()).toEqual({ scanned: true, leaked: [] });
  });
  describe('every channel through the dispatch engine', () => {
    // One running campaign per project, so each channel gets its own.
    const projectOf = (channel: string) => `project-pii-${channel}`;
    const RATE_PER_SECOND = 1000;
    const EMAIL_QUOTA = 100_000;
    const BAD_REQUEST = 400;
    const OK = 200;
    const FAKE_SERVICE_ACCOUNT = JSON.stringify({
      project_id: 'pii-test',
      client_email: 'pii@pii-test.example.test',
      private_key: 'not-a-real-key',
    });
    const canaryMember = (id: string, email = CANARY_EMAIL): FakeMember => ({
      id,
      values: {},
      displayName: CANARY_NAME,
      contact: { phone: CANARY_PHONE, email },
      traits: { firstName: CANARY_NAME },
      devices: [{ token: CANARY_TOKEN, platform: 'android' }],
    });

    afterEach(() => {
      for (const channel of CAMPAIGN_CHANNELS) {
        unregisterBatchAdapter(channel);
      }
    });

    async function setChannelConfig(channel: string, config: unknown) {
      await sql.$executeRawUnsafe(
        'UPDATE marketing.channel_configs SET config_encrypted = $3 WHERE project_id = $1 AND channel = $2',
        projectOf(channel),
        channel,
        encryptCredential(ENCRYPTION_KEY, JSON.stringify(config))
      );
    }

    async function providerTemplate(
      channel: 'sms' | 'whatsapp',
      now: () => Date
    ): Promise<string> {
      const row = await createTemplateRegistry({ sql, now }).create(
        { projectId: projectOf(channel), userId: 'u1' },
        channel === 'sms'
          ? {
              channel,
              displayName: 'Offer',
              category: 'service',
              providerRef: { flowId: 'flowpii' },
              approvedText: 'Hello ##name##',
              variables: [{ slot: 'name', value: '{{profile.firstName}}' }],
            }
          : {
              channel,
              displayName: 'Offer',
              category: 'service',
              providerRef: {
                templateName: 'promo',
                namespace: 'ns-placeholder',
                language: 'en',
              },
              approvedText: 'Hello {{1}}',
              variables: [{ slot: 'body_1', value: '{{profile.firstName}}' }],
            }
      );
      return row.templateId;
    }

    async function outcomes(campaignId: string): Promise<string[]> {
      const rows = await sql.$queryRawUnsafe<
        { status: string; reason: string }[]
      >(
        `SELECT status, coalesce(reason, '') AS reason FROM marketing.campaign_recipients
         WHERE campaign_id = $1::uuid ORDER BY profile_id`,
        campaignId
      );
      return rows.map((row) => `${row.status}:${row.reason}`);
    }

    it('push, sms, whatsapp, email and webhook campaigns, a test send, an uncertain retry and a preview leave no canary behind', async () => {
      const testClock = createClock();
      const msg91 = await startFakeMsg91();
      const smtp = await startFakeSmtp({
        reply: (command) =>
          command.startsWith('RCPT TO') && command.includes(CANARY_EMAIL)
            ? `550 5.1.1 <${CANARY_EMAIL}> user unknown`
            : undefined,
      });
      try {
        const fcm = createFakeFcm();
        // Deadlines are computed on the test clock, so every adapter reads it too.
        const nowMs = testClock.ms;
        registerBatchAdapter(
          perRecipientBatch(createPushAdapter({ sendMulticast: fcm }), nowMs)
        );
        registerBatchAdapter(createPooledEmailAdapter({ now: nowMs }));
        // The fake MSG91 listens on loopback, which a base url may only name when allow-listed.
        const allowHosts = [new URL(msg91.baseUrl).hostname];
        registerBatchAdapter(createMsg91SmsAdapter({ now: nowMs, allowHosts }));
        registerBatchAdapter(
          createMsg91WhatsAppAdapter({ now: nowMs, allowHosts })
        );

        // One 400 that quotes the phone and the auth key, as a provider echoing the request might.
        msg91.script(SMS_PATH, (body) => ({
          status: BAD_REQUEST,
          body: {
            type: 'error',
            message: `invalid mobile ${extractPhones(body).join(',')} for authkey ${CANARY_AUTH_KEY}`,
          },
        }));
        // The connection drops after the request was written, so the row is uncertain.
        msg91.script(WHATSAPP_PATH, 'reset');

        const members = [
          canaryMember('c-push'),
          canaryMember('c-sms'),
          canaryMember('c-wa'),
          canaryMember('c-email'),
          canaryMember('c-email-ok', 'second@example.test'),
          canaryMember('c-hook'),
        ];
        const source = createFakeSource({ members });
        const deps = dispatchDeps(source, testClock);
        const smsTemplate = await providerTemplate('sms', testClock.now);
        const whatsappTemplate = await providerTemplate(
          'whatsapp',
          testClock.now
        );
        const now = testClock.now();
        const rated = { ratePerSecond: RATE_PER_SECOND };
        const pushId = await insertRunningCampaign({
          project: projectOf('push'),
          now,
          channel: 'push',
          recipients: ['c-push'],
          template: { subject: 'Hi', body: 'Hello {{profile.firstName}}' },
        });
        const smsId = await insertRunningCampaign({
          project: projectOf('sms'),
          now,
          channel: 'sms',
          recipients: ['c-sms'],
          template: { templateId: smsTemplate },
          templateVersion: 1,
          settings: rated,
        });
        const whatsappId = await insertRunningCampaign({
          project: projectOf('whatsapp'),
          now,
          channel: 'whatsapp',
          recipients: ['c-wa'],
          template: { templateId: whatsappTemplate },
          templateVersion: 1,
          settings: rated,
        });
        const emailId = await insertRunningCampaign({
          project: projectOf('email'),
          now,
          channel: 'email',
          recipients: ['c-email', 'c-email-ok'],
          template: {
            subject: 'Hi {{profile.firstName}}',
            body: 'Hello {{profile.firstName}}',
          },
          settings: { ...rated, dailyQuota: EMAIL_QUOTA },
        });
        await insertRunningCampaign({
          project: projectOf('webhook'),
          now,
          channel: 'webhook',
          recipients: ['c-hook'],
          template: { body: 'Hello {{profile.firstName}}' },
        });
        await setChannelConfig('push', {
          serviceAccountJson: FAKE_SERVICE_ACCOUNT,
        });
        await setChannelConfig('sms', {
          authKey: CANARY_AUTH_KEY,
          baseUrl: msg91.baseUrl,
        });
        await setChannelConfig('whatsapp', {
          authKey: CANARY_AUTH_KEY,
          integratedNumber: '910000000000',
          baseUrl: msg91.baseUrl,
        });
        await setChannelConfig('email', {
          host: '127.0.0.1',
          port: smtp.port,
          secure: false,
          from: 'Shop <shop@example.test>',
        });
        await setChannelConfig('webhook', { secret: 's' });
        registerBatchAdapter(
          perRecipientBatch(capturingAdapter('webhook'), nowMs)
        );

        await campaignService(source, testClock.now).requestTestSend(
          { projectId: projectOf('push'), userId: 'u1' },
          pushId,
          'c-push'
        );
        expect((await runTestSendTick(deps)).sent).toBe(1);

        await drain(deps, testClock);
        msg91.script(WHATSAPP_PATH, () => ({
          status: OK,
          body: { status: 'success', hasError: false, request_id: 'req-1' },
        }));
        expect(await outcomes(whatsappId)).toEqual(['uncertain:network']);
        const retried = await retryUncertain(
          sql,
          { projectId: projectOf('whatsapp') },
          whatsappId,
          testClock.now()
        );
        expect(retried.retried).toBe(1);
        await drain(deps, testClock);

        const preview = await createServer({
          cfg: { ...CFG, proxySecret: PROXY_SECRET },
          sql,
          redis,
          sources: deps.sources,
          now: () => testClock.ms(),
        }).fetch(
          new Request(
            `http://marketing.internal/marketing/templates/${smsTemplate}/preview`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-marketing-proxy-secret': PROXY_SECRET,
                'x-marketing-project-id': projectOf('sms'),
                'x-marketing-user-id': 'u1',
                'x-marketing-csrf': '1',
              },
              body: JSON.stringify({
                sample: { profile: { firstName: CANARY_NAME } },
              }),
            }
          )
        );
        expect(await preview.json()).toMatchObject({
          ok: true,
          variables: [{ slot: 'name', value: CANARY_NAME }],
        });

        // Every path above was really taken with the canaries as the recipient.
        expect(await outcomes(smsId)).toEqual(['failed:msg91 400']);
        expect(await outcomes(emailId)).toEqual(['failed:smtp 550', 'sent:']);
        expect(await outcomes(whatsappId)).toEqual(['sent:']);
        expect(msg91.requests.some((r) => r.authkey === CANARY_AUTH_KEY)).toBe(
          true
        );
        expect(fcm.delivered.get(CANARY_TOKEN)).toBeGreaterThanOrEqual(2);
        expect(
          smtp.sessions.some((session) =>
            session.recipients.some((to) => to.includes(CANARY_EMAIL))
          )
        ).toBe(true);

        expect(await scanEverything()).toEqual({ scanned: true, leaked: [] });
      } finally {
        await msg91.close();
        await smtp.close();
      }
    });

    it('a delivery report for the canary student stores no phone-derived value', async () => {
      const testClock = createClock();
      const msg91 = await startFakeMsg91();
      try {
        const nowMs = testClock.ms;
        registerBatchAdapter(
          createMsg91SmsAdapter({
            now: nowMs,
            allowHosts: [new URL(msg91.baseUrl).hostname],
          })
        );
        const source = createFakeSource({ members: [canaryMember('c-sms')] });
        const deps = dispatchDeps(source, testClock);
        const smsTemplate = await providerTemplate('sms', testClock.now);
        await insertRunningCampaign({
          project: projectOf('sms'),
          now: testClock.now(),
          channel: 'sms',
          recipients: ['c-sms'],
          template: { templateId: smsTemplate },
          templateVersion: 1,
          settings: { ratePerSecond: RATE_PER_SECOND },
        });
        await setChannelConfig('sms', {
          authKey: CANARY_AUTH_KEY,
          baseUrl: msg91.baseUrl,
        });
        await drain(deps, testClock);
        const [tracked] = await sql.$queryRawUnsafe<{ provider_ref: string }[]>(
          'SELECT provider_ref FROM marketing.message_tracking WHERE project_id = $1',
          projectOf('sms')
        );
        expect(tracked?.provider_ref).toBeTruthy();

        const project = projectOf('sms');
        const response = await createServer({
          cfg: { ...CFG, proxySecret: PROXY_SECRET },
          sql,
          redis,
          sources: deps.sources,
        }).fetch(
          new Request(
            `http://marketing.internal${webhookPath(project, webhookSecret(ENCRYPTION_KEY, project))}`,
            {
              method: 'POST',
              body: JSON.stringify(
                smsReportFor(tracked?.provider_ref ?? '', [
                  { phone: CANARY_PHONE, status: '1' },
                ])
              ),
            }
          )
        );
        expect(await response.json()).toEqual({
          applied: 1,
          unmatched: 0,
          ignored: 0,
        });
        const [row] = await sql.$queryRawUnsafe<{ status: string }[]>(
          'SELECT status FROM marketing.message_tracking WHERE project_id = $1',
          project
        );
        expect(row?.status).toBe('delivered');

        const lastTen = CANARY_PHONE.slice(-10);
        const sha = (value: string) =>
          createHash('sha256').update(value).digest('hex');
        const derived = [
          lastTen,
          sha(lastTen),
          sha(CANARY_PHONE),
          createHash('md5').update(lastTen).digest('hex'),
          Buffer.from(lastTen).toString('base64'),
        ];
        const { text } = await scanTables();
        const haystack = [...text, ...(await scanRedis()), ...logged];
        expect(
          haystack.filter((line) =>
            derived.some((value) => line.includes(value))
          )
        ).toEqual([]);
        expect(await scanEverything()).toEqual({ scanned: true, leaked: [] });
      } finally {
        await msg91.close();
      }
    });
  });
});

describe('redacting recipient values from adapter errors', () => {
  const recipient = (attributes: Record<string, unknown>): Recipient => ({
    profileId: 'p',
    email: 'Pii-Canary@Example.test',
    deviceTokens: ['tok-1'],
    attributes,
  });

  it('replaces the longest value first so no half of a name is left', () => {
    const message = 'refused Asha Rao <pii-canary@example.test> (Asha) tok-1';
    const redacted = redactSecrets(
      message,
      recipientValues(recipient({ firstName: 'Asha', fullName: 'Asha Rao' }))
    );
    expect(redacted).toBe(
      'refused [redacted] <[redacted]> ([redacted]) [redacted]'
    );
  });

  it('keeps short attribute values and non-strings out of the list', () => {
    const values = recipientValues(
      recipient({ country: 'IN', year: 5, n: '5' })
    );
    expect(values).not.toContain('IN');
    expect(values).not.toContain('5');
    expect(values).toContain('tok-1');
  });
});
