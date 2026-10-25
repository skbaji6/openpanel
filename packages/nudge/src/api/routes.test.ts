import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { decryptCredential } from '@openpanel/shared/server';
import { registerDefaultAdapters } from '../channels/registry';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetNudgeTables } from '../db/test-helpers';
import { createEngine, lockProfiles } from '../engine/engine';
import { STARTER_RULES } from '../rules/starter-rules';
import { createServer } from './server';
import { createUnsubscribeUrlRenderer } from './unsubscribe';

const PROXY_SECRET = 'proxy-secret-for-tests';
const BASE = 'http://nudge.internal';
const MASK = '********';
const MIB = 1024 * 1024;

const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  NUDGE_PROXY_SECRET: PROXY_SECRET,
  NUDGE_PUBLIC_URL: 'https://nudge.test',
});

let onRulesChanged = mock(() => Promise.resolve());
let app = createServer({ cfg, sql, onRulesChanged });

function peer(address: string) {
  return { requestIP: () => ({ address }) };
}

interface CallOptions {
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  ip?: string;
}

function call(method: string, path: string, options: CallOptions = {}) {
  const hasJson = options.body !== undefined;
  const request = new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(hasJson ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: hasJson ? JSON.stringify(options.body) : options.rawBody,
  });
  return app.fetch(request, peer(options.ip ?? '10.0.0.1'));
}

function dashboard(
  method: string,
  path: string,
  body?: unknown,
  overrides: Record<string, string> = {}
) {
  return call(method, path, {
    body,
    headers: {
      'x-nudge-proxy-secret': PROXY_SECRET,
      'x-nudge-project-id': 'proj-a',
      'x-nudge-user-id': 'user-1',
      'x-nudge-csrf': '1',
      ...overrides,
    },
  });
}

function sync(method: string, path: string, key: string, body?: unknown) {
  return call(method, path, { body, headers: { 'x-nudge-api-key': key } });
}

async function createKey(projectId: string): Promise<string> {
  const response = await dashboard(
    'POST',
    '/nudge/api-keys',
    { label: 'backend' },
    { 'x-nudge-project-id': projectId }
  );
  if (response.status !== 201) {
    throw new Error(`api key creation failed with ${response.status}`);
  }
  const created = (await response.json()) as { key: string };
  return created.key;
}

function ruleDefinition(overrides: Record<string, unknown> = {}) {
  return { ...STARTER_RULES['cart-abandoned'], ...overrides };
}

async function insertRule(projectId: string, status = 'active') {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO nudge.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, 'r', $3, $4::jsonb)`,
    id,
    projectId,
    status,
    JSON.stringify(ruleDefinition())
  );
  return id;
}

async function insertEnrollment(
  ruleId: string,
  profileId: string,
  status: string,
  stepStatuses: string[],
  projectId = 'proj-a'
) {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO nudge.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
     VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5, $6, now())`,
    id,
    projectId,
    ruleId,
    JSON.stringify(ruleDefinition()),
    profileId,
    status
  );
  for (const [index, stepStatus] of stepStatuses.entries()) {
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.steps (enrollment_id, step_index, due_at, status)
       VALUES ($1::uuid, $2, now(), $3)`,
      id,
      index,
      stepStatus
    );
  }
  return id;
}

async function statusesOf(enrollmentId: string) {
  const [enrollment] = await sql.$queryRawUnsafe<{ status: string }[]>(
    'SELECT status FROM nudge.enrollments WHERE id = $1::uuid',
    enrollmentId
  );
  const steps = await sql.$queryRawUnsafe<{ status: string }[]>(
    'SELECT status FROM nudge.steps WHERE enrollment_id = $1::uuid ORDER BY step_index',
    enrollmentId
  );
  return {
    enrollment: enrollment?.status,
    steps: steps.map((step) => step.status),
  };
}

const WAIT_POLL_MS = 20;

// Waits until exactly this many advisory-lock requests are blocked, so interleavings are deterministic.
async function waitForAdvisoryWaiters(count: number) {
  for (;;) {
    const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
    );
    if (row?.n === count) {
      return;
    }
    await Bun.sleep(WAIT_POLL_MS);
  }
}

function unsubscribePath(profileId: string, channel = 'email') {
  const url = new URL(
    createUnsubscribeUrlRenderer(cfg)('proj-a', profileId, channel)
  );
  return `${url.pathname}${url.search}`;
}

const ONE_CLICK = {
  rawBody: 'List-Unsubscribe=One-Click',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
};

async function optOuts() {
  return await sql.$queryRawUnsafe<
    { project_id: string; profile_id: string; channel: string }[]
  >('SELECT project_id, profile_id, channel FROM nudge.opt_outs');
}

beforeAll(async () => {
  await migrate();
  registerDefaultAdapters({ webhookAllowHosts: [] });
});

beforeEach(async () => {
  await resetNudgeTables();
  onRulesChanged = mock(() => Promise.resolve());
  app = createServer({ cfg, sql, onRulesChanged });
});

afterAll(async () => {
  await sql.$disconnect();
});

describe('health', () => {
  it('GET /nudge/health returns ok without auth', async () => {
    const response = await call('GET', '/nudge/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('unknown routes return a JSON 404', async () => {
    const response = await dashboard('GET', '/nudge/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});

describe('sync routes', () => {
  it('sync routes reject a missing or wrong api key with 401', async () => {
    const key = await createKey('proj-a');
    const [id] = key.split('.');
    const missing = await call('PUT', '/nudge/contacts/u1', {
      body: { email: 'a@b.co' },
    });
    const wrong = await sync(
      'PUT',
      '/nudge/contacts/u1',
      `${id}.${'x'.repeat(43)}`,
      {
        email: 'a@b.co',
      }
    );
    const garbage = await sync('PUT', '/nudge/contacts/u1', 'garbage', {
      email: 'a@b.co',
    });
    expect([missing.status, wrong.status, garbage.status]).toEqual([
      401, 401, 401,
    ]);
    expect(await wrong.json()).toEqual({ error: 'unauthorized' });
    const ok = await sync('PUT', '/nudge/contacts/u1', key, {
      email: 'a@b.co',
    });
    expect(ok.status).toBe(200);
  });

  it('a key for project A cannot write contacts for project B', async () => {
    const keyA = await createKey('proj-a');
    const response = await call('PUT', '/nudge/contacts/u1', {
      body: { email: 'a@b.co', attributes: { firstName: 'Ada' } },
      headers: { 'x-nudge-api-key': keyA, 'x-nudge-project-id': 'proj-b' },
    });
    expect(response.status).toBe(200);
    const rows = await sql.$queryRawUnsafe<
      { project_id: string; email: string; attributes: unknown }[]
    >('SELECT project_id, email, attributes FROM nudge.contacts');
    expect(rows).toEqual([
      {
        project_id: 'proj-a',
        email: 'a@b.co',
        attributes: { firstName: 'Ada' },
      },
    ]);
  });

  it('PUT contacts keeps omitted fields and rejects a bad email', async () => {
    const key = await createKey('proj-a');
    await sync('PUT', '/nudge/contacts/u1', key, {
      email: 'a@b.co',
      attributes: { plan: 'pro' },
    });
    await sync('PUT', '/nudge/contacts/u1', key, {
      attributes: { plan: 'free' },
    });
    const [row] = await sql.$queryRawUnsafe<
      { email: string; attributes: unknown }[]
    >('SELECT email, attributes FROM nudge.contacts');
    expect(row).toEqual({ email: 'a@b.co', attributes: { plan: 'free' } });
    const bad = await sync('PUT', '/nudge/contacts/u1', key, {
      email: 'not an email',
    });
    expect(bad.status).toBe(400);
    const extra = await sync('PUT', '/nudge/contacts/u1', key, { admin: true });
    expect(extra.status).toBe(400);
  });

  it('PUT devices moves an existing token to the new profile', async () => {
    const key = await createKey('proj-a');
    await sync('PUT', '/nudge/devices', key, {
      profileId: 'u1',
      token: 'tok-1',
      platform: 'android',
    });
    const moved = await sync('PUT', '/nudge/devices', key, {
      profileId: 'u2',
      token: 'tok-1',
      platform: 'ios',
    });
    expect(moved.status).toBe(200);
    const rows = await sql.$queryRawUnsafe<
      { token: string; profile_id: string; platform: string }[]
    >('SELECT token, profile_id, platform FROM nudge.devices');
    expect(rows).toEqual([
      { token: 'tok-1', profile_id: 'u2', platform: 'ios' },
    ]);
  });

  it('DELETE devices removes it', async () => {
    const keyA = await createKey('proj-a');
    const keyB = await createKey('proj-b');
    await sync('PUT', '/nudge/devices', keyA, {
      profileId: 'u1',
      token: 'tok-1',
      platform: 'android',
    });
    await sync('DELETE', '/nudge/devices', keyB, { token: 'tok-1' });
    const afterOtherProject = await sql.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM nudge.devices'
    );
    expect(afterOtherProject).toHaveLength(1);
    const response = await sync('DELETE', '/nudge/devices', keyA, {
      token: 'tok-1',
    });
    expect(response.status).toBe(200);
    const rows = await sql.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM nudge.devices'
    );
    expect(rows).toHaveLength(0);
  });

  it('PUT reference-sets replaces the values and bounds their count', async () => {
    const key = await createKey('proj-a');
    await sync('PUT', '/nudge/reference-sets/book-1', key, {
      values: ['s1', 's2'],
    });
    const replaced = await sync('PUT', '/nudge/reference-sets/book-1', key, {
      values: ['s3', 's3'],
    });
    expect(await replaced.json()).toEqual({ setKey: 'book-1', count: 1 });
    const listed = await dashboard('GET', '/nudge/reference-sets');
    expect(await listed.json()).toEqual({
      referenceSets: [{ setKey: 'book-1', count: 1 }],
    });
    const one = await dashboard('GET', '/nudge/reference-sets/book-1');
    expect(await one.json()).toEqual({ setKey: 'book-1', values: ['s3'] });
    const missing = await dashboard('GET', '/nudge/reference-sets/other');
    expect(missing.status).toBe(404);
    const tooMany = await sync('PUT', '/nudge/reference-sets/book-1', key, {
      values: Array.from({ length: 100_001 }, (_, index) => String(index)),
    });
    expect(tooMany.status).toBe(400);
  });

  it('invalid JSON returns 400', async () => {
    const key = await createKey('proj-a');
    const response = await call('PUT', '/nudge/devices', {
      rawBody: '{not json',
      headers: { 'x-nudge-api-key': key, 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });
});

describe('dashboard routes', () => {
  it('dashboard routes reject a missing or wrong proxy secret with 401 and a mutating call without x-nudge-csrf with 403', async () => {
    const missing = await call('GET', '/nudge/rules', {
      headers: { 'x-nudge-project-id': 'proj-a', 'x-nudge-user-id': 'u' },
    });
    const wrong = await dashboard('GET', '/nudge/rules', undefined, {
      'x-nudge-proxy-secret': 'wrong',
    });
    const noCsrf = await call('POST', '/nudge/rules', {
      body: { definition: ruleDefinition() },
      headers: {
        'x-nudge-proxy-secret': PROXY_SECRET,
        'x-nudge-project-id': 'proj-a',
        'x-nudge-user-id': 'user-1',
      },
    });
    const badProject = await dashboard('GET', '/nudge/rules', undefined, {
      'x-nudge-project-id': 'proj a; drop',
    });
    expect([
      missing.status,
      wrong.status,
      noCsrf.status,
      badProject.status,
    ]).toEqual([401, 401, 403, 400]);
    const rows = await sql.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM nudge.rules'
    );
    expect(rows).toHaveLength(0);
  });

  it('POST rules validates with zRuleDefinition and returns 400 on invalid', async () => {
    const invalid = await dashboard('POST', '/nudge/rules', {
      definition: ruleDefinition({ steps: [] }),
    });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('invalid_body');
    expect(body.issues.length).toBeGreaterThan(0);

    const created = await dashboard('POST', '/nudge/rules', {
      definition: ruleDefinition(),
      status: 'active',
    });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as { id: string; version: number };
    expect(rule.version).toBe(1);
    expect(onRulesChanged).toHaveBeenCalledTimes(1);
    const listed = (await (await dashboard('GET', '/nudge/rules')).json()) as {
      rules: { id: string; status: string }[];
    };
    expect(listed.rules.map((r) => [r.id, r.status])).toEqual([
      [rule.id, 'active'],
    ]);
  });

  it('editing a rule bumps its version', async () => {
    const ruleId = await insertRule('proj-a');
    const response = await dashboard('PATCH', `/nudge/rules/${ruleId}`, {
      definition: ruleDefinition({ name: 'Renamed' }),
    });
    expect(response.status).toBe(200);
    const rule = (await response.json()) as { name: string; version: number };
    expect([rule.name, rule.version]).toEqual(['Renamed', 2]);
  });

  it('pausing a rule cancels its pending steps and active enrollments', async () => {
    const ruleId = await insertRule('proj-a');
    const otherRule = await insertRule('proj-a');
    const active = await insertEnrollment(ruleId, 'u1', 'active', [
      'sent',
      'pending',
    ]);
    const completed = await insertEnrollment(ruleId, 'u2', 'completed', [
      'sent',
      'cancelled',
    ]);
    const untouched = await insertEnrollment(otherRule, 'u1', 'active', [
      'pending',
    ]);

    const response = await dashboard('PATCH', `/nudge/rules/${ruleId}`, {
      status: 'paused',
    });
    expect(response.status).toBe(200);
    expect(await statusesOf(active)).toEqual({
      enrollment: 'cancelled',
      steps: ['sent', 'cancelled'],
    });
    expect(await statusesOf(completed)).toEqual({
      enrollment: 'completed',
      steps: ['sent', 'cancelled'],
    });
    expect(await statusesOf(untouched)).toEqual({
      enrollment: 'active',
      steps: ['pending'],
    });
    expect(onRulesChanged).toHaveBeenCalledTimes(1);
  });

  it('deleting a rule cancels its work and removes it', async () => {
    const ruleId = await insertRule('proj-a');
    const active = await insertEnrollment(ruleId, 'u1', 'active', ['pending']);
    const response = await dashboard('DELETE', `/nudge/rules/${ruleId}`);
    expect(response.status).toBe(200);
    expect(await statusesOf(active)).toEqual({
      enrollment: 'cancelled',
      steps: ['cancelled'],
    });
    const rows = await sql.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM nudge.rules'
    );
    expect(rows).toHaveLength(0);
  });

  it('a pause concurrent with an in-flight engine batch leaves no active enrollment or pending step', async () => {
    const ruleId = await insertRule('proj-a');
    const { promise: released, resolve: release } =
      Promise.withResolvers<void>();
    // Holds u1's profile lock so the engine batch stops inside its transaction, after the shared rule lock.
    const holder = sql.$transaction(
      async (tx) => {
        await lockProfiles(tx, [{ projectId: 'proj-a', profileId: 'u1' }]);
        await released;
      },
      { timeout: 30_000 }
    );
    await waitForAdvisoryWaiters(0);
    const batch = createEngine({ sql }).handleEvent({
      eventId: randomUUID(),
      projectId: 'proj-a',
      profileId: 'u1',
      name: 'add_to_cart',
      time: new Date(),
      properties: { item_id: 'book-1' },
    });
    await waitForAdvisoryWaiters(1);
    const pause = dashboard('PATCH', `/nudge/rules/${ruleId}`, {
      status: 'paused',
    });
    // The pause now waits for the batch's shared rule lock.
    await waitForAdvisoryWaiters(2);
    release();
    await Promise.all([holder, batch]);
    expect((await pause).status).toBe(200);

    const enrollments = await sql.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM nudge.enrollments WHERE rule_id = $1::uuid',
      ruleId
    );
    expect(enrollments.map((row) => row.status)).toEqual(['cancelled']);
    const pending = await sql.$queryRawUnsafe<unknown[]>(
      "SELECT 1 FROM nudge.steps WHERE status = 'pending'"
    );
    expect(pending).toHaveLength(0);
  });

  it('a delete that fails while cancelling can be retried, and leaves no pending step', async () => {
    const ruleId = await insertRule('proj-a');
    const snapshot = JSON.stringify(ruleDefinition());
    // One more profile than a cancel chunk, so cancelling needs a second transaction.
    await sql.$executeRawUnsafe(
      `WITH created AS (
         INSERT INTO nudge.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
         SELECT gen_random_uuid(), 'proj-a', $1::uuid, $2::jsonb, 'p' || n, 'active', now()
         FROM generate_series(1, 1001) AS n
         RETURNING id
       )
       INSERT INTO nudge.steps (enrollment_id, step_index, due_at, status)
       SELECT id, 0, now(), 'pending' FROM created`,
      ruleId,
      snapshot
    );
    let transactions = 0;
    const failing = createServer({
      cfg,
      sql: new Proxy(sql, {
        get(target, property, receiver) {
          if (property !== '$transaction') {
            return Reflect.get(target, property, receiver);
          }
          return (...args: Parameters<typeof sql.$transaction>) => {
            transactions += 1;
            return transactions === 2
              ? Promise.reject(new Error('injected chunk failure'))
              : target.$transaction(...args);
          };
        },
      }),
    });
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await failing.fetch(
      new Request(`${BASE}/nudge/rules/${ruleId}`, {
        method: 'DELETE',
        headers: {
          'x-nudge-proxy-secret': PROXY_SECRET,
          'x-nudge-project-id': 'proj-a',
          'x-nudge-user-id': 'user-1',
          'x-nudge-csrf': '1',
        },
      }),
      peer('10.0.0.1')
    );
    errors.mockRestore();
    expect(failed.status).toBe(500);
    const [rule] = await sql.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM nudge.rules WHERE id = $1::uuid',
      ruleId
    );
    expect(rule?.status).toBe('paused');

    const retried = await dashboard('DELETE', `/nudge/rules/${ruleId}`);
    expect(retried.status).toBe(200);
    const leftovers = await sql.$queryRawUnsafe<{ n: number }[]>(
      `SELECT (SELECT count(*) FROM nudge.rules)::int
            + (SELECT count(*) FROM nudge.enrollments WHERE status = 'active')::int
            + (SELECT count(*) FROM nudge.steps WHERE status = 'pending')::int AS n`
    );
    expect(leftovers[0]?.n).toBe(0);
  });

  it('SECURITY dashboard rule ids from another project return 404', async () => {
    const ruleId = await insertRule('proj-b');
    const active = await insertEnrollment(
      ruleId,
      'u1',
      'active',
      ['pending'],
      'proj-b'
    );
    const patched = await dashboard('PATCH', `/nudge/rules/${ruleId}`, {
      status: 'paused',
    });
    const deleted = await dashboard('DELETE', `/nudge/rules/${ruleId}`);
    const results = await dashboard('GET', `/nudge/results?ruleId=${ruleId}`);
    const notUuid = await dashboard('DELETE', '/nudge/rules/not-a-uuid');
    expect([
      patched.status,
      deleted.status,
      results.status,
      notUuid.status,
    ]).toEqual([404, 404, 404, 404]);
    expect(await statusesOf(active)).toEqual({
      enrollment: 'active',
      steps: ['pending'],
    });
    const [rule] = await sql.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM nudge.rules WHERE id = $1::uuid',
      ruleId
    );
    expect(rule?.status).toBe('active');
  });

  it('GET starter-rules lists the starter definitions', async () => {
    const response = await dashboard('GET', '/nudge/starter-rules');
    const body = (await response.json()) as { starterRules: { key: string }[] };
    expect(body.starterRules.map((rule) => rule.key)).toEqual(
      Object.keys(STARTER_RULES)
    );
  });

  it('PUT channels stores config encrypted (raw column does not contain the secret) and GET masks it', async () => {
    const config = {
      host: 'smtp.test',
      port: 587,
      secure: false,
      user: 'mailer',
      pass: 'super-secret-password',
      from: 'news@shop.test',
    };
    const put = await dashboard('PUT', '/nudge/channels/email', { config });
    expect(put.status).toBe(200);
    expect(JSON.stringify(await put.json())).not.toContain(config.pass);
    const [row] = await sql.$queryRawUnsafe<{ config_encrypted: string }[]>(
      'SELECT config_encrypted FROM nudge.channel_configs'
    );
    expect(row?.config_encrypted).not.toContain(config.pass);
    expect(
      JSON.parse(
        decryptCredential(cfg.encryptionKey, row?.config_encrypted ?? '')
      )
    ).toEqual(config);

    const get = await dashboard('GET', '/nudge/channels/email');
    expect(await get.json()).toEqual({
      channel: 'email',
      configured: true,
      config: { ...config, pass: MASK },
    });

    const resaved = await dashboard('PUT', '/nudge/channels/email', {
      config: { ...config, pass: MASK },
    });
    expect(resaved.status).toBe(200);
    const [after] = await sql.$queryRawUnsafe<{ config_encrypted: string }[]>(
      'SELECT config_encrypted FROM nudge.channel_configs'
    );
    expect(
      JSON.parse(
        decryptCredential(cfg.encryptionKey, after?.config_encrypted ?? '')
      )
    ).toEqual(config);

    const invalid = await dashboard('PUT', '/nudge/channels/email', {
      config: { host: 'smtp.test' },
    });
    expect(invalid.status).toBe(400);
  });

  it('SECURITY a masked secret is not kept when a public field changes in the same request', async () => {
    const config = {
      host: 'smtp.test',
      port: 587,
      secure: false,
      user: 'mailer',
      pass: 'super-secret-password',
      from: 'news@shop.test',
    };
    await dashboard('PUT', '/nudge/channels/email', { config });
    const redirected = await dashboard('PUT', '/nudge/channels/email', {
      config: { ...config, host: 'attacker.example', pass: MASK },
    });
    expect(redirected.status).toBe(400);
    expect(await redirected.json()).toEqual({
      error: 'secrets_required',
      issues: [
        {
          path: 'config.pass',
          message: 're-enter this secret when changing other settings',
        },
      ],
    });
    const [row] = await sql.$queryRawUnsafe<{ config_encrypted: string }[]>(
      'SELECT config_encrypted FROM nudge.channel_configs'
    );
    expect(
      JSON.parse(
        decryptCredential(cfg.encryptionKey, row?.config_encrypted ?? '')
      )
    ).toEqual(config);
    const reentered = await dashboard('PUT', '/nudge/channels/email', {
      config: { ...config, host: 'smtp2.test', pass: 'new-password' },
    });
    expect(reentered.status).toBe(200);
  });

  it('SECURITY GET channels never returns a secret value, even masked values do not reveal length', async () => {
    const short = 'whsec-0123456789ab';
    const long = `whsec-${'z'.repeat(90)}`;
    const put = await dashboard('PUT', '/nudge/channels/webhook', {
      config: {
        url: 'https://hooks.example.com/nudge',
        secrets: [short, long],
      },
    });
    expect(put.status).toBe(200);
    const response = await dashboard('GET', '/nudge/channels/webhook');
    const text = await response.text();
    expect(text).not.toContain(short);
    expect(text).not.toContain('zzzz');
    expect(JSON.parse(text)).toEqual({
      channel: 'webhook',
      configured: true,
      config: { url: 'https://hooks.example.com/nudge', secrets: MASK },
    });
    const empty = await dashboard('GET', '/nudge/channels/push');
    expect(await empty.json()).toEqual({
      channel: 'push',
      configured: false,
      config: null,
    });
  });

  it('settings validate caps, quiet hours and timezone', async () => {
    const settings = {
      caps: { max: 2, periodSeconds: 86_400 },
      quietHours: { start: '22:00', end: '08:00', timezone: 'Asia/Kolkata' },
    };
    const put = await dashboard('PUT', '/nudge/settings', settings);
    expect(put.status).toBe(200);
    expect(await (await dashboard('GET', '/nudge/settings')).json()).toEqual(
      settings
    );
    const badZone = await dashboard('PUT', '/nudge/settings', {
      ...settings,
      quietHours: { ...settings.quietHours, timezone: 'Mars/Olympus' },
    });
    const badTime = await dashboard('PUT', '/nudge/settings', {
      ...settings,
      quietHours: { ...settings.quietHours, start: '25:00' },
    });
    expect([badZone.status, badTime.status]).toEqual([400, 400]);
  });

  it('results counts match seeded steps', async () => {
    const ruleId = await insertRule('proj-a');
    const idle = await insertRule('proj-a');
    await insertEnrollment(ruleId, 'u1', 'completed', ['sent', 'cancelled']);
    await insertEnrollment(ruleId, 'u2', 'active', ['sent', 'skipped']);
    await insertEnrollment(ruleId, 'u3', 'active', ['failed']);
    await insertEnrollment(ruleId, 'u4', 'completed', ['cancelled']);
    const otherProjectRule = await insertRule('proj-b');
    await insertEnrollment(
      otherProjectRule,
      'u1',
      'active',
      ['sent'],
      'proj-b'
    );

    const response = await dashboard('GET', '/nudge/results');
    const body = (await response.json()) as {
      results: Record<string, unknown>[];
    };
    const byRule = new Map(body.results.map((row) => [row.ruleId, row]));
    expect(byRule.size).toBe(2);
    expect(byRule.get(ruleId)).toEqual({
      ruleId,
      name: 'r',
      enrolled: 4,
      nudged: 2,
      sent: 2,
      completedAfterSend: 1,
      conversionRate: 0.5,
      skipped: 1,
      failed: 1,
    });
    expect(byRule.get(idle)).toEqual({
      ruleId: idle,
      name: 'r',
      enrolled: 0,
      nudged: 0,
      sent: 0,
      completedAfterSend: 0,
      conversionRate: 0,
      skipped: 0,
      failed: 0,
    });
    const one = await dashboard('GET', `/nudge/results?ruleId=${ruleId}`);
    const filtered = (await one.json()) as { results: unknown[] };
    expect(filtered.results).toHaveLength(1);
  });

  it('POST api-keys returns the secret once and stores only its hash', async () => {
    const key = await createKey('proj-a');
    const [id, secret] = key.split('.');
    const [row] = await sql.$queryRawUnsafe<{ key_hash: string }[]>(
      'SELECT key_hash FROM nudge.api_keys WHERE id = $1::uuid',
      id
    );
    expect(row?.key_hash).not.toContain(secret ?? '');
  });

  it('preview escapes HTML in variables', async () => {
    const response = await dashboard('POST', '/nudge/preview', {
      channel: 'email',
      template: {
        subject: 'Hi {{profile.firstName}}',
        body: '<p>Hi {{profile.firstName}}</p>',
      },
      sample: { profile: { firstName: '<script>alert(1)</script>' } },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subject: 'Hi <script>alert(1)</script>',
      body: '<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    });
  });
});

describe('unsubscribe', () => {
  it('unsubscribe POST with a valid token inserts an opt-out and a tampered token returns 400', async () => {
    const path = unsubscribePath('u1');
    const ok = await call('POST', path, ONE_CLICK);
    expect(ok.status).toBe(200);
    expect(await optOuts()).toEqual([
      { project_id: 'proj-a', profile_id: 'u1', channel: 'email' },
    ]);
    const again = await call('POST', path, ONE_CLICK);
    expect(again.status).toBe(200);

    const tampered = `${path.slice(0, -3)}${path.endsWith('A') ? 'B' : 'A'}xx`;
    const bad = await call('POST', tampered, ONE_CLICK);
    expect(bad.status).toBe(400);
    const noToken = await call('POST', '/nudge/unsubscribe', ONE_CLICK);
    expect(noToken.status).toBe(400);
    expect(await optOuts()).toHaveLength(1);
  });

  it('the URL the ticker renders opts out a profile whose id contains "|"', async () => {
    const response = await call(
      'POST',
      unsubscribePath('a|b|c', 'push'),
      ONE_CLICK
    );
    expect(response.status).toBe(200);
    expect(await optOuts()).toEqual([
      { project_id: 'proj-a', profile_id: 'a|b|c', channel: 'push' },
    ]);
  });

  it('unsubscribe GET shows a confirmation form and does not opt out', async () => {
    const path = unsubscribePath('<b>u1</b>');
    const response = await call('GET', path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'"
    );
    const html = await response.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(html).not.toContain('<b>');
    expect(await optOuts()).toHaveLength(0);
    const bad = await call('GET', '/nudge/unsubscribe?t=%3Cscript%3E');
    expect(bad.status).toBe(400);
  });

  it('one-click POST works with a urlencoded, a multipart or an empty body', async () => {
    const multipart = new FormData();
    multipart.set('List-Unsubscribe', 'One-Click');
    const urlencoded = await call('POST', unsubscribePath('u1'), ONE_CLICK);
    const formData = await call('POST', unsubscribePath('u2'), {
      rawBody: multipart,
    });
    const empty = await call('POST', unsubscribePath('u3'));
    expect([urlencoded.status, formData.status, empty.status]).toEqual([
      200, 200, 200,
    ]);
    const rows = await optOuts();
    expect(rows.map((row) => row.profile_id).sort()).toEqual([
      'u1',
      'u2',
      'u3',
    ]);
  });

  it('SECURITY the 31st invalid unsubscribe token from one IP returns 429, a valid token still works', async () => {
    const ip = '203.0.113.9';
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await call('POST', '/nudge/unsubscribe?t=bad', {
        ...ONE_CLICK,
        ip,
      });
      expect(response.status).toBe(400);
    }
    const limited = await call('GET', '/nudge/unsubscribe?t=bad', { ip });
    expect(limited.status).toBe(429);
    const valid = await call('POST', unsubscribePath('u1'), {
      ...ONE_CLICK,
      ip,
    });
    expect(valid.status).toBe(200);
    expect(await optOuts()).toHaveLength(1);
  });
});

describe('SECURITY limits', () => {
  it('SECURITY a body over 1 MiB returns 413', async () => {
    const response = await dashboard('POST', '/nudge/preview', {
      channel: 'email',
      template: { body: 'x' },
      sample: { profile: { blob: 'y'.repeat(MIB) } },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload_too_large' });
  });

  it('SECURITY a streamed body over 1 MiB without content-length returns 413', async () => {
    const chunk = new TextEncoder().encode('a'.repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 2 * MIB) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request(`${BASE}/nudge/preview`, {
      method: 'POST',
      body: stream,
      headers: {
        'x-nudge-proxy-secret': PROXY_SECRET,
        'x-nudge-project-id': 'proj-a',
        'x-nudge-user-id': 'user-1',
        'x-nudge-csrf': '1',
      },
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const response = await app.fetch(request, peer('10.0.0.1'));
    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(2 * MIB);
  });

  it('SECURITY a template body over 20,000 characters returns 400', async () => {
    const [step] = STARTER_RULES['cart-abandoned'].steps;
    const response = await dashboard('POST', '/nudge/rules', {
      definition: ruleDefinition({
        steps: [{ ...step, template: { body: 'x'.repeat(20_001) } }],
      }),
    });
    expect(response.status).toBe(400);
    const rows = await sql.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM nudge.rules'
    );
    expect(rows).toHaveLength(0);
  });

  it('SECURITY the 31st failed api-key attempt from one IP within a minute returns 429', async () => {
    const key = await createKey('proj-a');
    const attempt = (apiKey: string, ip: string) =>
      call('PUT', '/nudge/devices', {
        body: { profileId: 'u1', token: 't', platform: 'ios' },
        headers: { 'x-nudge-api-key': apiKey },
        ip,
      });
    for (let failure = 0; failure < 30; failure++) {
      expect((await attempt('wrong', '198.51.100.7')).status).toBe(401);
    }
    expect((await attempt('wrong', '198.51.100.7')).status).toBe(429);
    expect((await attempt(key, '198.51.100.7')).status).toBe(429);
    expect((await attempt(key, '198.51.100.8')).status).toBe(200);
  });

  it('SECURITY a recently verified api key still works from an IP locked out by failed attempts', async () => {
    const key = await createKey('proj-a');
    const attempt = (apiKey: string) =>
      call('PUT', '/nudge/devices', {
        body: { profileId: 'u1', token: 't', platform: 'ios' },
        headers: { 'x-nudge-api-key': apiKey },
        ip: '198.51.100.9',
      });
    expect((await attempt(key)).status).toBe(200);
    for (let failure = 0; failure < 30; failure++) {
      expect((await attempt('wrong')).status).toBe(401);
    }
    expect((await attempt('wrong')).status).toBe(429);
    expect((await attempt(key)).status).toBe(200);
  });

  it('SECURITY an internal error returns a generic 500 without details', async () => {
    const broken = createServer({
      cfg,
      sql: new Proxy(sql, {
        get(target, property, receiver) {
          if (property === '$queryRawUnsafe') {
            return () => Promise.reject(new Error(`boom ${PROXY_SECRET}`));
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    const errors = mock(() => undefined);
    const original = console.error;
    console.error = errors;
    const response = await broken.fetch(
      new Request(`${BASE}/nudge/rules`, {
        headers: {
          'x-nudge-proxy-secret': PROXY_SECRET,
          'x-nudge-project-id': 'proj-a',
          'x-nudge-user-id': 'user-1',
        },
      }),
      peer('10.0.0.1')
    );
    console.error = original;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain(PROXY_SECRET);
  });
});
