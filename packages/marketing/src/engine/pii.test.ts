import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import { createSourceResolver } from '../audience/resolver';
import { registerAdapter } from '../channels/registry';
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
import type { RuleDefinition } from '../rules/rule.schema';
import { createEngine } from './engine';
import { runTick } from './ticker';

// What a source-backed project must never persist or log: it is looked up per send and forgotten.
const CANARY_EMAIL = 'pii-canary@example.test';
const CANARY_PHONE = '919999900001';
const CANARY_TOKEN = 'canary-fcm-token-1';
const CANARY_NAME = 'Canary Student';
const CANARIES = [CANARY_EMAIL, CANARY_PHONE, CANARY_TOKEN, CANARY_NAME];
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
  dbPool: 10,
  sourceConcurrency: 4,
  lookupWindowMs: 0,
  maxLatenessSeconds: 86_400,
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
const spies: { mockRestore(): void }[] = [];

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
    traits: { firstName: CANARY_NAME, phone: CANARY_PHONE },
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
  afterAll(async () => {
    for (const spy of spies) {
      spy.mockRestore();
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
});
