import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  spyOn,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import type { LookupChannel, LookupEntry } from '../audience/contract';
import { SourceAuthError, SourceUnavailableError } from '../audience/errors';
import type { AudienceSource } from '../audience/source';
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

const NOW = new Date('2026-10-22T12:00:00.000Z');
const HOUR = 3600;
const DUE = new Date(NOW.getTime() - 10 * 60_000);
const HTTP_PROJECT = 'project-http';
const STORED_PROJECT = 'project-stored';
const ENCRYPTION_KEY = 'a'.repeat(64);
const LOOKED_UP_EMAIL = 'looked-up@example.test';
const SOURCE_BACKOFF_MS = 30_000;

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

const engine = createEngine({ sql, now: () => NOW });
let sends: { msg: RenderedMessage; to: Recipient; projectId: string }[] = [];
let lookups: { ids: string[]; channel: LookupChannel }[] = [];
let answer: (id: string) => LookupEntry = (id) => ({
  id,
  status: 'ok',
  email: LOOKED_UP_EMAIL,
  traits: { firstName: 'Ada' },
});
let lookupError: Error | null = null;
let errorLog: Mock<typeof console.error>;

function unused(): never {
  throw new Error('not used by the ticker');
}

const fakeSource: AudienceSource = {
  schema: unused,
  dimensionValues: unused,
  count: unused,
  members: unused,
  explain: unused,
  resolve: unused,
  lookup(ids, channel) {
    lookups.push({ ids, channel });
    if (lookupError) {
      return Promise.reject(lookupError);
    }
    return Promise.resolve(ids.map((id) => answer(id)));
  },
};

const sources = {
  forProject: (projectId: string) =>
    Promise.resolve(projectId === HTTP_PROJECT ? fakeSource : null),
};

function capturingAdapter(id: ChannelId): ChannelAdapter<{ secret: string }> {
  return {
    id,
    configSchema: z.object({ secret: z.string() }),
    send(msg, to) {
      sends.push({ msg, to, projectId: msg.meta.projectId });
      return Promise.resolve({ ok: true });
    },
  };
}

function tick() {
  return runTick({
    sql,
    engine,
    now: () => NOW,
    cfg: CFG,
    renderUnsubscribeUrl: () => 'https://marketing.test/u',
    logger: { warn: () => undefined },
    sources,
  });
}

function rule(channel: ChannelId = 'email'): RuleDefinition {
  return {
    name: 'test rule',
    trigger: { event: 'purchase' },
    goal: { kind: 'event', event: 'opened' },
    steps: [
      {
        delaySeconds: HOUR,
        channel,
        template: { subject: 'Hi {{profile.firstName}}', body: 'one' },
      },
    ],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
  };
}

async function enroll(
  opts: { projectId?: string; profileId?: string; channel?: ChannelId } = {}
): Promise<string> {
  const projectId = opts.projectId ?? HTTP_PROJECT;
  const definition = rule(opts.channel);
  const ruleId = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, $3, 'active', $4::jsonb)`,
    ruleId,
    projectId,
    definition.name,
    JSON.stringify(definition)
  );
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
     VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5, 'active', $6::timestamptz)`,
    id,
    projectId,
    ruleId,
    JSON.stringify(definition),
    opts.profileId ?? 'u1',
    new Date(DUE.getTime() - HOUR * 1000).toISOString()
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status, attempt)
     VALUES ($1::uuid, 0, $2::timestamptz, 'pending', 0)`,
    id,
    DUE.toISOString()
  );
  return id;
}

interface StepRow {
  status: string;
  attempt: number;
  due_at: Date;
  outcome: { reason?: string } | null;
}

async function stepOf(enrollmentId: string): Promise<StepRow | undefined> {
  const [row] = await sql.$queryRawUnsafe<StepRow[]>(
    'SELECT status, attempt, due_at, outcome FROM marketing.steps WHERE enrollment_id = $1::uuid',
    enrollmentId
  );
  return row;
}

async function sourceStatus(): Promise<string | undefined> {
  const [row] = await sql.$queryRawUnsafe<{ status: string }[]>(
    'SELECT status FROM marketing.audience_sources WHERE project_id = $1',
    HTTP_PROJECT
  );
  return row?.status;
}

async function count(table: string): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM marketing.${table}`
  );
  return row?.n ?? 0;
}

describe('runTick with an http audience source', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(async () => {
    sends = [];
    lookups = [];
    lookupError = null;
    answer = (id) => ({
      id,
      status: 'ok',
      email: LOOKED_UP_EMAIL,
      traits: { firstName: 'Ada' },
    });
    errorLog?.mockRestore();
    errorLog = spyOn(console, 'error').mockImplementation(() => undefined);
    await resetMarketingTables();
    await sql.$executeRawUnsafe(
      'INSERT INTO marketing.consumer_state (id, lag, updated_at) VALUES (1, 0, $1::timestamptz)',
      NOW.toISOString()
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.audience_sources (project_id, kind, base_url, key_id, secret_encrypted)
       VALUES ($1, 'http', 'https://owner.test', 'k1', 'unused')`,
      HTTP_PROJECT
    );
    for (const channel of ['email', 'webhook', 'push'] as const) {
      registerAdapter(capturingAdapter(channel));
      for (const projectId of [HTTP_PROJECT, STORED_PROJECT]) {
        await sql.$executeRawUnsafe(
          'INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)',
          projectId,
          channel,
          encryptCredential(ENCRYPTION_KEY, JSON.stringify({ secret: 's' }))
        );
      }
    }
  });
  afterAll(async () => {
    errorLog?.mockRestore();
    await resetMarketingTables();
    await sql.$disconnect();
  });

  it('delivers through lookup without reading marketing contacts', async () => {
    const enrollmentId = await enroll();
    expect(await tick()).toMatchObject({ sent: 1 });
    expect(await count('contacts')).toBe(0);
    expect(await count('devices')).toBe(0);
    expect(lookups).toEqual([{ ids: ['u1'], channel: 'email' }]);
    expect(sends[0]?.to.email).toBe(LOOKED_UP_EMAIL);
    expect(sends[0]?.msg.subject).toBe('Hi Ada');
    expect((await stepOf(enrollmentId))?.status).toBe('sent');
    expect(await sourceStatus()).toBe('ok');
  });

  it('skips not_found with reason not_found', async () => {
    answer = (id) => ({ id, status: 'not_found' });
    const enrollmentId = await enroll();
    expect(await tick()).toMatchObject({ skipped: 1 });
    expect(sends).toHaveLength(0);
    const step = await stepOf(enrollmentId);
    expect(step?.status).toBe('skipped');
    expect(step?.outcome).toEqual({ reason: 'not_found' });
  });

  it('skips suppressed', async () => {
    answer = (id) => ({ id, status: 'suppressed' });
    const enrollmentId = await enroll();
    await tick();
    expect(sends).toHaveLength(0);
    expect((await stepOf(enrollmentId))?.outcome).toEqual({
      reason: 'suppressed',
    });
  });

  it('skips unreachable with its reason', async () => {
    answer = (id) => ({ id, status: 'unreachable', reason: 'opted_out' });
    const enrollmentId = await enroll();
    await tick();
    expect(sends).toHaveLength(0);
    const step = await stepOf(enrollmentId);
    expect(step?.status).toBe('skipped');
    expect(step?.outcome).toEqual({ reason: 'unreachable:opted_out' });
  });

  it('a webhook step uses channel none', async () => {
    const enrollmentId = await enroll({ channel: 'webhook' });
    await tick();
    expect(lookups).toEqual([{ ids: ['u1'], channel: 'none' }]);
    expect(sends[0]?.to.attributes).toEqual({ firstName: 'Ada' });
    expect((await stepOf(enrollmentId))?.status).toBe('sent');
  });

  it('a stored project in the same tick still uses its contact rows', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.contacts (project_id, profile_id, email, attributes)
       VALUES ($1, 'u1', 'stored@example.test', '{"firstName":"Grace"}'::jsonb)`,
      STORED_PROJECT
    );
    const httpStep = await enroll();
    const storedStep = await enroll({ projectId: STORED_PROJECT });
    expect(await tick()).toMatchObject({ sent: 2 });
    expect(lookups).toHaveLength(1);
    const stored = sends.find((send) => send.projectId === STORED_PROJECT);
    const http = sends.find((send) => send.projectId === HTTP_PROJECT);
    expect(stored?.to.email).toBe('stored@example.test');
    expect(stored?.msg.subject).toBe('Hi Grace');
    expect(http?.to.email).toBe(LOOKED_UP_EMAIL);
    expect((await stepOf(httpStep))?.status).toBe('sent');
    expect((await stepOf(storedStep))?.status).toBe('sent');
  });

  it('when lookup throws SourceUnavailableError the claimed steps return to pending, none is marked failed and the attempt count is not increased', async () => {
    lookupError = new SourceUnavailableError('breaker_open');
    const first = await enroll();
    const second = await enroll({ profileId: 'u2' });
    expect(await tick()).toEqual({
      sent: 0,
      skipped: 0,
      postponed: 2,
      failed: 0,
    });
    expect(sends).toHaveLength(0);
    for (const id of [first, second]) {
      const step = await stepOf(id);
      expect(step?.status).toBe('pending');
      expect(step?.attempt).toBe(0);
      expect(step?.due_at.getTime()).toBe(NOW.getTime() + SOURCE_BACKOFF_MS);
    }
    expect(await sourceStatus()).toBe('unknown');
  });

  it("SourceAuthError sets the project's source status to source_auth_failed and leaves steps pending", async () => {
    lookupError = new SourceAuthError('lookup: 401');
    const enrollmentId = await enroll();
    await tick();
    expect(await sourceStatus()).toBe('source_auth_failed');
    const step = await stepOf(enrollmentId);
    expect(step?.status).toBe('pending');
    expect(step?.attempt).toBe(0);
    expect(sends).toHaveLength(0);
  });

  it('one lookup call serves many steps of one project', async () => {
    for (const profileId of ['u1', 'u2', 'u3']) {
      await enroll({ profileId });
    }
    expect(await tick()).toMatchObject({ sent: 3 });
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.ids.sort()).toEqual(['u1', 'u2', 'u3']);
  });
});
