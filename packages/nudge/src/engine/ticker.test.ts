import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  mock,
  spyOn,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import { registerAdapter } from '../channels/registry';
import type {
  ChannelAdapter,
  ChannelId,
  Recipient,
  RenderedMessage,
  SendOptions,
  SendResult,
} from '../channels/types';
import type { NudgeConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetNudgeTables } from '../db/test-helpers';
import type { RuleDefinition } from '../rules/rule.schema';
import { createEngine, lockProfiles } from './engine';
import {
  CLAIM_SQL,
  createTickState,
  HEAL_SWEEP_INTERVAL_MS,
  LAG_WARN_INTERVAL_MS,
  MARK_SQL,
  runTick,
  type TickDeps,
  type TickResult,
} from './ticker';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR = 3600;
const DAY = 24 * HOUR;
const PROJECT = 'project-a';
const PROFILE = 'u1';
const SECRET = 'sk-test-0123456789abcdef';
const ENCRYPTION_KEY = 'a'.repeat(64);
const DUE = new Date(NOW.getTime() - 10 * MINUTE_MS);

const CFG: NudgeConfig = {
  databaseUrl: '',
  redisUrl: '',
  encryptionKey: ENCRYPTION_KEY,
  proxySecret: '',
  publicUrl: 'https://nudge.test',
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
  webhookAllowHosts: [],
  kafka: { brokers: [], clientId: '', topic: '', groupId: '', ssl: false },
};

interface Call {
  msg: RenderedMessage;
  to: Recipient;
  config: { secret: string };
  opts: SendOptions;
}

let clock = NOW;
const engine = createEngine({ sql, now: () => clock });
let calls: Call[] = [];
let respond: (call: Call) => Promise<SendResult> = async () => ({ ok: true });
let errorLog: Mock<typeof console.error>;

function fakeAdapter(id: ChannelId): ChannelAdapter<{ secret: string }> {
  return {
    id,
    configSchema: z.object({ secret: z.string() }),
    send(msg, to, config, opts) {
      const call = { msg, to, config, opts };
      calls.push(call);
      return respond(call);
    },
  };
}

function tick(cfg: NudgeConfig = CFG, overrides: Partial<TickDeps> = {}) {
  return runTick({
    sql,
    engine,
    now: () => clock,
    cfg,
    renderUnsubscribeUrl: (projectId, profileId, channel) =>
      `https://nudge.test/u/${projectId}/${profileId}/${channel}`,
    ...overrides,
  });
}

// Rejects the first `failures` calls of one client method (only those with this query text, if given).
function flakySql(
  method: '$executeRawUnsafe' | '$transaction',
  query: string | null,
  failures: number
): typeof sql {
  let remaining = failures;
  return new Proxy(sql, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        const matches =
          prop === method && (query === null || args[0] === query);
        if (matches && remaining > 0) {
          remaining--;
          return Promise.reject(new Error('injected database failure'));
        }
        return value.apply(target, args);
      };
    },
  });
}

async function holdProfileLock() {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = sql.$transaction(
    async (tx) => {
      await lockProfiles(tx, [{ projectId: PROJECT, profileId: PROFILE }]);
      locked();
      await released;
    },
    { timeout: 20_000 }
  );
  await isLocked;
  return {
    async release() {
      release();
      await holder;
    },
  };
}

function rule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    name: 'test rule',
    trigger: { event: 'purchase' },
    goal: { kind: 'event', event: 'opened' },
    steps: [
      {
        delaySeconds: HOUR,
        channel: 'email',
        template: { subject: 'Hi {{profile.firstName}}', body: 'one' },
      },
    ],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
    ...overrides,
  };
}

async function insertRule(
  definition: RuleDefinition,
  status = 'active'
): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO nudge.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
    id,
    PROJECT,
    definition.name,
    status,
    JSON.stringify(definition)
  );
  return id;
}

interface StepSeed {
  dueAt: Date;
  status?: string;
  attempt?: number;
  leaseUntil?: Date;
  sentAt?: Date;
}

async function enroll(opts: {
  ruleId: string;
  definition: RuleDefinition;
  steps: StepSeed[];
  profileId?: string;
  triggerTime?: Date;
}): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO nudge.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
     VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5, 'active', $6::timestamptz)`,
    id,
    PROJECT,
    opts.ruleId,
    JSON.stringify(opts.definition),
    opts.profileId ?? PROFILE,
    (opts.triggerTime ?? new Date(DUE.getTime() - HOUR * 1000)).toISOString()
  );
  for (const [index, step] of opts.steps.entries()) {
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.steps (enrollment_id, step_index, due_at, status, attempt, lease_until, sent_at)
       VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6::timestamptz, $7::timestamptz)`,
      id,
      index,
      step.dueAt.toISOString(),
      step.status ?? 'pending',
      step.attempt ?? 0,
      step.leaseUntil?.toISOString() ?? null,
      step.sentAt?.toISOString() ?? null
    );
  }
  return id;
}

async function enrollOne(
  definition: RuleDefinition = rule(),
  steps: StepSeed[] = [{ dueAt: DUE }]
) {
  const ruleId = await insertRule(definition);
  const enrollmentId = await enroll({ ruleId, definition, steps });
  return { ruleId, enrollmentId };
}

async function setConsumerState(lag: number, updatedAt: Date = NOW) {
  await sql.$executeRawUnsafe(
    `INSERT INTO nudge.consumer_state (id, lag, updated_at) VALUES (1, $1, $2::timestamptz)
     ON CONFLICT (id) DO UPDATE SET lag = EXCLUDED.lag, updated_at = EXCLUDED.updated_at`,
    lag,
    updatedAt.toISOString()
  );
}

async function addContact(
  email: string | null,
  attributes: Record<string, unknown> = { firstName: 'Ada' },
  profileId = PROFILE
) {
  await sql.$executeRawUnsafe(
    `INSERT INTO nudge.contacts (project_id, profile_id, email, attributes)
     VALUES ($1, $2, $3, $4::jsonb)`,
    PROJECT,
    profileId,
    email,
    JSON.stringify(attributes)
  );
}

async function setChannelConfig(channel: ChannelId, config: unknown) {
  await sql.$executeRawUnsafe(
    `INSERT INTO nudge.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, channel) DO UPDATE SET config_encrypted = EXCLUDED.config_encrypted`,
    PROJECT,
    channel,
    encryptCredential(ENCRYPTION_KEY, JSON.stringify(config))
  );
}

async function setSettings(caps: unknown, quietHours: unknown) {
  await sql.$executeRawUnsafe(
    'INSERT INTO nudge.project_settings (project_id, caps, quiet_hours) VALUES ($1, $2::jsonb, $3::jsonb)',
    PROJECT,
    JSON.stringify(caps),
    JSON.stringify(quietHours)
  );
}

interface StepRow {
  step_index: number;
  status: string;
  due_at: Date;
  attempt: number;
  lease_until: Date | null;
  sent_at: Date | null;
  outcome: { reason?: string } | null;
}

function steps(enrollmentId: string): Promise<StepRow[]> {
  return sql.$queryRawUnsafe<StepRow[]>(
    `SELECT step_index, status, due_at, attempt, lease_until, sent_at, outcome
     FROM nudge.steps WHERE enrollment_id = $1::uuid ORDER BY step_index`,
    enrollmentId
  );
}

async function enrollmentStatus(enrollmentId: string): Promise<string> {
  const [row] = await sql.$queryRawUnsafe<{ status: string }[]>(
    'SELECT status FROM nudge.enrollments WHERE id = $1::uuid',
    enrollmentId
  );
  return row?.status ?? 'missing';
}

async function endReason(enrollmentId: string): Promise<string | null> {
  const [row] = await sql.$queryRawUnsafe<{ end_reason: string | null }[]>(
    'SELECT end_reason FROM nudge.enrollments WHERE id = $1::uuid',
    enrollmentId
  );
  return row?.end_reason ?? null;
}

const ZERO = { sent: 0, skipped: 0, postponed: 0, failed: 0 };

describe('runTick', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(async () => {
    clock = NOW;
    calls = [];
    respond = async () => ({ ok: true });
    errorLog?.mockRestore();
    errorLog = spyOn(console, 'error').mockImplementation(() => undefined);
    await resetNudgeTables();
    for (const id of ['email', 'webhook', 'push'] as const) {
      registerAdapter(fakeAdapter(id));
      await setChannelConfig(id, { secret: SECRET });
    }
    await setConsumerState(0);
    await addContact('ada@example.test');
  });
  afterAll(async () => {
    errorLog?.mockRestore();
    // The index test leaves 20,000 enrollments behind, which would skew scripts/load.ts.
    await resetNudgeTables();
    await sql.$disconnect();
  });

  it('REVIEW FOCUS lag: with consumer_state lag above maxLag nothing is claimed and the step stays pending', async () => {
    const { enrollmentId } = await enrollOne();
    await setConsumerState(CFG.maxLag + 1);
    expect(await tick()).toEqual(ZERO);
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('pending');
    expect(step?.attempt).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('REVIEW FOCUS lag: a missing consumer_state row blocks sending', async () => {
    const { enrollmentId } = await enrollOne();
    await sql.$executeRawUnsafe('DELETE FROM nudge.consumer_state');
    expect(await tick()).toEqual(ZERO);
    expect((await steps(enrollmentId))[0]?.status).toBe('pending');
  });

  it('REVIEW FOCUS stale state: updated_at older than 60 s blocks sending', async () => {
    const { enrollmentId } = await enrollOne();
    await setConsumerState(0, new Date(NOW.getTime() - 61_000));
    expect(await tick()).toEqual(ZERO);
    expect((await steps(enrollmentId))[0]?.status).toBe('pending');
    expect(calls).toHaveLength(0);
  });

  it('step due inside the grace window is not claimed; after it is', async () => {
    const { enrollmentId } = await enrollOne(rule(), [
      { dueAt: new Date(NOW.getTime() - 200_000) },
    ]);
    expect(await tick()).toEqual(ZERO);
    expect((await steps(enrollmentId))[0]?.status).toBe('pending');

    clock = new Date(NOW.getTime() + 100_000);
    await setConsumerState(0, clock);
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('sent');
    expect(step?.sent_at).toEqual(clock);
    expect(calls).toHaveLength(1);
  });

  it('goal recheck cancels the step and sends nothing when a goal event with event_time >= trigger_time exists', async () => {
    const definition = rule({
      steps: [
        { delaySeconds: HOUR, channel: 'email', template: { body: 'one' } },
        { delaySeconds: DAY, channel: 'email', template: { body: 'two' } },
      ],
    });
    const triggerTime = new Date(DUE.getTime() - HOUR * 1000);
    const ruleId = await insertRule(definition);
    const enrollmentId = await enroll({
      ruleId,
      definition,
      triggerTime,
      steps: [{ dueAt: DUE }, { dueAt: new Date(NOW.getTime() + DAY * 1000) }],
    });
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.events (project_id, event_id, profile_id, name, event_time)
       VALUES ($1, 'e1', $2, 'opened', $3::timestamptz)`,
      PROJECT,
      PROFILE,
      triggerTime.toISOString()
    );
    expect(await tick()).toEqual({ ...ZERO, skipped: 1 });
    expect(calls).toHaveLength(0);
    expect((await steps(enrollmentId)).map((s) => s.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect((await steps(enrollmentId))[0]?.outcome).toEqual({
      reason: 'goal_met',
    });
    expect(await enrollmentStatus(enrollmentId)).toBe('completed');
    expect(await endReason(enrollmentId)).toBe('goal');
  });

  it("REVIEW FOCUS opted out: email step is skipped, enrollment's next step is still pending and later sent", async () => {
    const definition = rule({
      steps: [
        { delaySeconds: HOUR, channel: 'email', template: { body: 'one' } },
        { delaySeconds: DAY, channel: 'webhook', template: { body: 'two' } },
      ],
    });
    const later = new Date(NOW.getTime() + DAY * 1000);
    const { enrollmentId } = await enrollOne(definition, [
      { dueAt: DUE },
      { dueAt: later },
    ]);
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.opt_outs (project_id, profile_id, channel) VALUES ($1, $2, 'email')`,
      PROJECT,
      PROFILE
    );
    expect(await tick()).toEqual({ ...ZERO, skipped: 1 });
    let rows = await steps(enrollmentId);
    expect(rows[0]?.status).toBe('skipped');
    expect(rows[0]?.outcome).toEqual({ reason: 'opted_out' });
    expect(rows[1]?.status).toBe('pending');
    expect(await enrollmentStatus(enrollmentId)).toBe('active');
    expect(calls).toHaveLength(0);

    clock = new Date(later.getTime() + CFG.graceSeconds * 1000);
    await setConsumerState(0, clock);
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
    rows = await steps(enrollmentId);
    expect(rows[1]?.status).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(await enrollmentStatus(enrollmentId)).toBe('completed');
    expect(await endReason(enrollmentId)).toBe('exhausted');
  });

  it('email step with no synced email is skipped', async () => {
    await sql.$executeRawUnsafe('UPDATE nudge.contacts SET email = NULL');
    const { enrollmentId } = await enrollOne();
    expect(await tick()).toEqual({ ...ZERO, skipped: 1 });
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('skipped');
    expect(step?.outcome).toEqual({ reason: 'no_email' });
    expect(calls).toHaveLength(0);
    expect(await enrollmentStatus(enrollmentId)).toBe('completed');
  });

  it('push step with no device tokens is skipped', async () => {
    const { enrollmentId } = await enrollOne(
      rule({
        steps: [
          { delaySeconds: HOUR, channel: 'push', template: { body: 'one' } },
        ],
      })
    );
    expect(await tick()).toEqual({ ...ZERO, skipped: 1 });
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('skipped');
    expect(step?.outcome).toEqual({ reason: 'no_device' });
    expect(calls).toHaveLength(0);
  });

  it('push step goes to the profile device tokens with title and plain-text body', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.devices (token, project_id, profile_id, platform)
       VALUES ('t1', $1, $2, 'ios'), ('t2', $1, $2, 'android'), ('t3', $1, 'other', 'ios')`,
      PROJECT,
      PROFILE
    );
    await enrollOne(
      rule({
        steps: [
          {
            delaySeconds: HOUR,
            channel: 'push',
            template: {
              subject: 'Hey <b>',
              body: '{{profile.firstName}} & co',
            },
          },
        ],
      })
    );
    await sql.$executeRawUnsafe(
      `UPDATE nudge.contacts SET attributes = '{"firstName":"<Ada>"}'`
    );
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
    expect(calls[0]?.to.deviceTokens).toEqual(['t1', 't2']);
    expect(calls[0]?.msg.title).toBe('Hey <b>');
    expect(calls[0]?.msg.body).toBe('<Ada> & co');
  });

  it('invalid tokens returned by the push adapter are deleted from devices', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.devices (token, project_id, profile_id, platform)
       VALUES ('t1', $1, $2, 'ios'), ('t2', $1, $2, 'android'),
              ('t3', $1, 'other', 'ios'), ('t4', 'project-b', $2, 'ios')`,
      PROJECT,
      PROFILE
    );
    const { enrollmentId } = await enrollOne(
      rule({
        steps: [
          { delaySeconds: HOUR, channel: 'push', template: { body: 'one' } },
        ],
      })
    );
    // t3 and t4 belong to another profile and project: a hostile adapter result must not reach them.
    respond = async () => ({ ok: true, invalidTokens: ['t1', 't3', 't4'] });
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
    const remaining = await sql.$queryRawUnsafe<{ token: string }[]>(
      'SELECT token FROM nudge.devices ORDER BY token'
    );
    expect(remaining.map((row) => row.token)).toEqual(['t2', 't3', 't4']);
    expect((await steps(enrollmentId))[0]?.status).toBe('sent');
  });

  it('a failing invalid-token deletion neither fails nor requeues a sent step', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.devices (token, project_id, profile_id, platform)
       VALUES ('t1', $1, $2, 'ios')`,
      PROJECT,
      PROFILE
    );
    const { enrollmentId } = await enrollOne(
      rule({
        steps: [
          { delaySeconds: HOUR, channel: 'push', template: { body: 'one' } },
        ],
      })
    );
    respond = async () => ({ ok: true, invalidTokens: ['t1'] });
    const failingDelete = new Proxy(sql, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) =>
          prop === '$executeRawUnsafe' &&
          String(args[0]).includes('DELETE FROM nudge.devices')
            ? Promise.reject(new Error('injected database failure'))
            : value.apply(target, args);
      },
    });
    expect(await tick(CFG, { sql: failingDelete })).toEqual({
      ...ZERO,
      sent: 1,
    });
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('sent');
    expect(step?.attempt).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(
      'nudge ticker:',
      'pruning invalid device tokens:',
      expect.stringContaining('injected database failure')
    );
  });

  it('invalid tokens on a failed push result are deleted too', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.devices (token, project_id, profile_id, platform)
       VALUES ('t1', $1, $2, 'ios'), ('t2', $1, $2, 'android')`,
      PROJECT,
      PROFILE
    );
    const { enrollmentId } = await enrollOne(
      rule({
        steps: [
          { delaySeconds: HOUR, channel: 'push', template: { body: 'one' } },
        ],
      })
    );
    respond = async () => ({
      ok: false,
      retryable: false,
      reason: 'fcm messaging/registration-token-not-registered',
      invalidTokens: ['t1', 't2'],
    });
    expect(await tick()).toEqual({ ...ZERO, failed: 1 });
    const remaining = await sql.$queryRawUnsafe<{ token: string }[]>(
      'SELECT token FROM nudge.devices'
    );
    expect(remaining).toEqual([]);
    expect((await steps(enrollmentId))[0]?.status).toBe('failed');
  });

  it('quiet hours postpone instead of send', async () => {
    await setSettings(null, { start: '11:00', end: '13:00', timezone: 'UTC' });
    const { enrollmentId } = await enrollOne();
    expect(await tick()).toEqual({ ...ZERO, postponed: 1 });
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('pending');
    expect(step?.due_at).toEqual(new Date('2026-10-22T13:00:00.000Z'));
    expect(step?.attempt).toBe(0);
    expect(step?.lease_until).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await enrollmentStatus(enrollmentId)).toBe('active');
  });

  it('cap: with caps {max:1, periodSeconds:3600} a second step for the same profile and channel from another rule is skipped', async () => {
    await setSettings({ max: 1, periodSeconds: 3600 }, null);
    await enrollOne(rule({ name: 'earlier' }), [
      {
        dueAt: DUE,
        status: 'sent',
        sentAt: new Date(NOW.getTime() - 30 * MINUTE_MS),
      },
    ]);
    const { enrollmentId } = await enrollOne(rule({ name: 'second' }));
    const webhook = await enrollOne(
      rule({
        name: 'other channel',
        steps: [
          { delaySeconds: HOUR, channel: 'webhook', template: { body: 'w' } },
        ],
      })
    );
    expect(await tick()).toEqual({ ...ZERO, sent: 1, skipped: 1 });
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('skipped');
    expect(step?.outcome).toEqual({ reason: 'cap' });
    expect((await steps(webhook.enrollmentId))[0]?.status).toBe('sent');
    expect(calls.map((call) => call.opts.idempotencyKey)).toEqual([
      `${webhook.enrollmentId}:0`,
    ]);
  });

  it('cap: two due steps of different rules for one profile in the same tick send exactly one', async () => {
    await setSettings({ max: 1, periodSeconds: 3600 }, null);
    const first = await enrollOne(rule({ name: 'a' }));
    const second = await enrollOne(rule({ name: 'b' }));
    expect(await tick()).toEqual({ ...ZERO, sent: 1, skipped: 1 });
    const statuses = [
      (await steps(first.enrollmentId))[0]?.status,
      (await steps(second.enrollmentId))[0]?.status,
    ].sort();
    expect(statuses).toEqual(['sent', 'skipped']);
    expect(calls).toHaveLength(1);
  });

  it('cap: a sent step older than the period does not count', async () => {
    await setSettings({ max: 1, periodSeconds: 3600 }, null);
    await enrollOne(rule({ name: 'old' }), [
      {
        dueAt: DUE,
        status: 'sent',
        sentAt: new Date(NOW.getTime() - 2 * HOUR * 1000),
      },
    ]);
    await enrollOne(rule({ name: 'new' }));
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
  });

  it('two concurrent runTick calls send a due step exactly once', async () => {
    const { enrollmentId } = await enrollOne();
    respond = async () => {
      await Bun.sleep(50);
      return { ok: true };
    };
    const [a, b] = await Promise.all([tick(), tick()]);
    expect((a?.sent ?? 0) + (b?.sent ?? 0)).toBe(1);
    expect(calls).toHaveLength(1);
    expect((await steps(enrollmentId))[0]?.status).toBe('sent');
  });

  it('retryable failure re-queues with backoff and non-retryable marks failed', async () => {
    const retry = await enrollOne(rule({ name: 'retry' }));
    respond = async () => ({ ok: false, retryable: true, reason: '421 busy' });
    expect(await tick()).toEqual({ ...ZERO, postponed: 1 });
    let [step] = await steps(retry.enrollmentId);
    expect(step?.status).toBe('pending');
    expect(step?.attempt).toBe(1);
    expect(step?.due_at).toEqual(new Date(NOW.getTime() + 60_000));
    expect(step?.outcome).toEqual({ reason: '421 busy' });
    expect(step?.sent_at).toBeNull();

    // The fifth attempt is the last one.
    await sql.$executeRawUnsafe(
      'UPDATE nudge.steps SET attempt = 4, due_at = $1::timestamptz',
      DUE.toISOString()
    );
    expect(await tick()).toEqual({ ...ZERO, failed: 1 });
    [step] = await steps(retry.enrollmentId);
    expect(step?.status).toBe('failed');
    expect(step?.attempt).toBe(5);
    expect(await enrollmentStatus(retry.enrollmentId)).toBe('completed');

    const permanent = await enrollOne(rule({ name: 'permanent' }));
    respond = async () => ({ ok: false, retryable: false, reason: '550 no' });
    expect(await tick()).toEqual({ ...ZERO, failed: 1 });
    [step] = await steps(permanent.enrollmentId);
    expect(step?.status).toBe('failed');
    expect(step?.outcome).toEqual({ reason: '550 no' });
    expect(await enrollmentStatus(permanent.enrollmentId)).toBe('completed');
  });

  it('an adapter that throws is retried like a retryable failure', async () => {
    const { enrollmentId } = await enrollOne();
    respond = () => Promise.reject(new Error('socket hang up'));
    expect(await tick()).toEqual({ ...ZERO, postponed: 1 });
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('pending');
    expect(step?.outcome?.reason).toContain('socket hang up');
  });

  it('expired lease on a sending step is reclaimed', async () => {
    const expired = await enrollOne(rule({ name: 'expired' }), [
      {
        dueAt: DUE,
        status: 'sending',
        attempt: 1,
        leaseUntil: new Date(NOW.getTime() - 1000),
      },
    ]);
    const leased = await enrollOne(rule({ name: 'leased' }), [
      {
        dueAt: DUE,
        status: 'sending',
        attempt: 1,
        leaseUntil: new Date(NOW.getTime() + 60_000),
      },
    ]);
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
    const [step] = await steps(expired.enrollmentId);
    expect(step?.status).toBe('sent');
    expect(step?.attempt).toBe(2);
    expect((await steps(leased.enrollmentId))[0]?.status).toBe('sending');
    expect(calls).toHaveLength(1);
  });

  it('idempotencyKey passed to the adapter is enrollmentId:stepIndex', async () => {
    const definition = rule({
      allowedEventProps: ['title'],
      steps: [
        {
          delaySeconds: HOUR,
          channel: 'email',
          template: { subject: 'Re: {{event.title}}', body: 'skip' },
        },
        {
          delaySeconds: DAY,
          channel: 'email',
          template: {
            subject: 'Re: {{event.title}} for {{profile.firstName}}',
            body: '<p>{{event.title}} {{event.secret}} {{profile.firstName}}</p>',
          },
        },
      ],
    });
    const triggerTime = new Date(DUE.getTime() - DAY * 1000);
    const ruleId = await insertRule(definition);
    const enrollmentId = await enroll({
      ruleId,
      definition,
      triggerTime,
      steps: [{ dueAt: DUE, status: 'sent', sentAt: DUE }, { dueAt: DUE }],
    });
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.events (project_id, event_id, profile_id, name, properties, event_time)
       VALUES ($1, 'trigger', $2, 'purchase', $3::jsonb, $4::timestamptz)`,
      PROJECT,
      PROFILE,
      JSON.stringify({ title: '<Dune>', secret: 'S' }),
      triggerTime.toISOString()
    );
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.opts.idempotencyKey).toBe(`${enrollmentId}:1`);
    expect(call?.opts.unsubscribeUrl).toBe(
      `https://nudge.test/u/${PROJECT}/${PROFILE}/email`
    );
    expect(call?.msg.subject).toBe('Re: <Dune> for Ada');
    expect(call?.msg.body).toBe('<p>&lt;Dune&gt;  Ada</p>');
    expect(call?.msg.meta).toEqual({
      projectId: PROJECT,
      enrollmentId,
      ruleId,
      stepIndex: 1,
    });
    expect(call?.to).toEqual({
      profileId: PROFILE,
      email: 'ada@example.test',
      deviceTokens: [],
      attributes: { firstName: 'Ada' },
    });
    expect(call?.config).toEqual({ secret: SECRET });
    expect(await enrollmentStatus(enrollmentId)).toBe('completed');
  });

  it('a step of a paused rule is not claimed', async () => {
    const definition = rule();
    const ruleId = await insertRule(definition, 'paused');
    const enrollmentId = await enroll({
      ruleId,
      definition,
      steps: [{ dueAt: DUE }],
    });
    expect(await tick()).toEqual(ZERO);
    expect((await steps(enrollmentId))[0]?.status).toBe('pending');
  });

  it('a missing or invalid channel config skips the step', async () => {
    await sql.$executeRawUnsafe(
      `DELETE FROM nudge.channel_configs WHERE channel = 'email'`
    );
    const missing = await enrollOne(rule({ name: 'missing' }));
    expect(await tick()).toEqual({ ...ZERO, skipped: 1 });
    expect((await steps(missing.enrollmentId))[0]?.outcome).toEqual({
      reason: 'channel_not_configured',
    });

    await setChannelConfig('email', { wrong: true });
    const invalid = await enrollOne(rule({ name: 'invalid' }));
    expect(await tick()).toEqual({ ...ZERO, skipped: 1 });
    const [step] = await steps(invalid.enrollmentId);
    expect(step?.status).toBe('skipped');
    expect(step?.outcome).toEqual({ reason: 'invalid_channel_config' });
    expect(calls).toHaveLength(0);
  });

  it('the ticker waits for the profile lock held by the engine and proceeds after release', async () => {
    const { enrollmentId } = await enrollOne();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = sql.$transaction(
      async (tx) => {
        await lockProfiles(tx, [{ projectId: PROJECT, profileId: PROFILE }]);
        locked();
        await released;
      },
      { timeout: 20_000 }
    );
    await isLocked;
    let done = false;
    const running = tick().then((result) => {
      done = true;
      return result;
    });
    await Bun.sleep(500);
    expect(done).toBe(false);
    // The sent mark does not wait for the lock; completing the enrollment does.
    expect((await steps(enrollmentId))[0]?.status).toBe('sent');
    expect(await enrollmentStatus(enrollmentId)).toBe('active');
    release();
    await holder;
    expect(await running).toEqual({ ...ZERO, sent: 1 });
    expect((await steps(enrollmentId))[0]?.status).toBe('sent');
    expect(await enrollmentStatus(enrollmentId)).toBe('completed');
  });

  it('PERF a tick claims at most NUDGE_CLAIM_BATCH steps even with 1,000 due', async () => {
    const definition = rule({
      steps: [
        { delaySeconds: HOUR, channel: 'webhook', template: { body: 'w' } },
      ],
    });
    const ruleId = await insertRule(definition);
    await sql.$executeRawUnsafe(
      `WITH e AS (
         INSERT INTO nudge.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
         SELECT gen_random_uuid(), $1, $2::uuid, $3::jsonb, 'p' || g, 'active', $4::timestamptz - interval '1 hour'
         FROM generate_series(1, 1000) g
         RETURNING id)
       INSERT INTO nudge.steps (enrollment_id, step_index, due_at, status)
       SELECT id, 0, $4::timestamptz, 'pending' FROM e`,
      PROJECT,
      ruleId,
      JSON.stringify(definition),
      DUE.toISOString()
    );
    expect(await tick()).toEqual({ ...ZERO, sent: CFG.claimBatch });
    const counts = await sql.$queryRawUnsafe<{ status: string; n: number }[]>(
      'SELECT status, count(*)::int AS n FROM nudge.steps GROUP BY status ORDER BY status'
    );
    expect(counts).toEqual([
      { status: 'pending', n: 1000 - CFG.claimBatch },
      { status: 'sent', n: CFG.claimBatch },
    ]);
    expect(calls).toHaveLength(CFG.claimBatch);
  });

  it('sends run with at most NUDGE_SEND_CONCURRENCY in flight', async () => {
    const definition = rule({
      steps: [
        { delaySeconds: HOUR, channel: 'webhook', template: { body: 'w' } },
      ],
    });
    const ruleId = await insertRule(definition);
    for (let i = 0; i < 30; i++) {
      await enroll({
        ruleId,
        definition,
        profileId: `p${i}`,
        steps: [{ dueAt: DUE }],
      });
    }
    let inFlight = 0;
    let maxInFlight = 0;
    respond = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(30);
      inFlight--;
      return { ok: true };
    };
    const cfg = { ...CFG, sendConcurrency: 4 };
    expect(await tick(cfg)).toEqual({ ...ZERO, sent: 30 });
    expect(maxInFlight).toBe(4);
  });

  it('SECURITY an adapter error whose message contains the channel secret is logged redacted', async () => {
    const { enrollmentId } = await enrollOne();
    respond = async (call) => ({
      ok: false,
      retryable: false,
      reason: `auth failed for key ${call.config.secret} (Bearer abc.def)`,
    });
    expect(await tick()).toEqual({ ...ZERO, failed: 1 });
    const logged = errorLog.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('auth failed');
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('abc.def');
    const [step] = await steps(enrollmentId);
    expect(JSON.stringify(step?.outcome)).not.toContain(SECRET);

    respond = () => Promise.reject(new Error(`boom ${SECRET}`));
    await enrollOne(rule({ name: 'throws' }));
    await tick();
    const all = errorLog.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(all).toContain('boom');
    expect(all).not.toContain(SECRET);
  });

  it('REGRESSION e1: a failed sent mark is retried in-process and the step is never requeued', async () => {
    const { enrollmentId } = await enrollOne();
    const flaky = flakySql('$executeRawUnsafe', MARK_SQL, 1);
    expect(await tick(CFG, { sql: flaky })).toEqual({ ...ZERO, sent: 1 });
    clock = new Date(NOW.getTime() + 10 * MINUTE_MS);
    await setConsumerState(0, clock);
    expect(await tick(CFG, { sql: flaky })).toEqual(ZERO);
    expect(calls).toHaveLength(1);
    expect((await steps(enrollmentId))[0]?.status).toBe('sent');
  });

  it('REGRESSION e1: when every sent mark attempt fails the step stays sending and is not requeued', async () => {
    const { enrollmentId } = await enrollOne();
    const broken = flakySql('$executeRawUnsafe', MARK_SQL, 3);
    expect(await tick(CFG, { sql: broken })).toEqual(ZERO);
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('sending');
    expect(step?.attempt).toBe(1);
    expect(calls).toHaveLength(1);
    expect(errorLog.mock.calls.flat().join(' ')).toContain(
      'recording the send result failed'
    );
  });

  it('REGRESSION e2: each step is sent once when a second tick overlaps a slow first tick (leaseSeconds 1)', async () => {
    const definition = rule();
    const ruleId = await insertRule(definition);
    await addContact('b@example.test', {}, 'u2');
    const first = await enroll({ ruleId, definition, steps: [{ dueAt: DUE }] });
    const second = await enroll({
      ruleId,
      definition,
      profileId: 'u2',
      steps: [{ dueAt: DUE }],
    });
    const cfg = { ...CFG, leaseSeconds: 1, sendConcurrency: 1 };
    let evaluations = 0;
    // The first step's lease is extended at +0.9 s, after the batch lease was stamped at +0 s.
    const slowEngine = {
      ...engine,
      evaluateEnrollment(id: string) {
        if (evaluations++ === 0) {
          clock = new Date(NOW.getTime() + 900);
        }
        return engine.evaluateEnrollment(id);
      },
    };
    let overlapping: Promise<TickResult> | undefined;
    respond = async () => {
      if (!overlapping) {
        clock = new Date(NOW.getTime() + 1200);
        overlapping = tick(cfg, { engine: slowEngine });
        await overlapping;
      }
      return { ok: true };
    };
    const a = await tick(cfg, { engine: slowEngine });
    const b = await overlapping;
    expect(calls.map((call) => call.opts.idempotencyKey).sort()).toEqual(
      [`${first}:0`, `${second}:0`].sort()
    );
    expect(a.sent + (b?.sent ?? 0)).toBe(2);
    expect((await steps(first))[0]?.status).toBe('sent');
    expect((await steps(second))[0]?.status).toBe('sent');
  });

  it('REGRESSION e3: a goal reached while a send is in flight cancels the requeued step and completes the enrollment', async () => {
    const { enrollmentId } = await enrollOne();
    respond = async () => {
      await engine.handleEvent({
        eventId: 'goal',
        projectId: PROJECT,
        profileId: PROFILE,
        name: 'opened',
        properties: {},
        time: NOW,
      });
      return { ok: false, retryable: true, reason: '421 busy' };
    };
    expect(await tick()).toEqual({ ...ZERO, skipped: 1 });
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('cancelled');
    expect(step?.sent_at).toBeNull();
    expect(await enrollmentStatus(enrollmentId)).toBe('completed');
  });

  it('a retry requeue waits for the profile lock', async () => {
    const { enrollmentId } = await enrollOne();
    respond = async () => ({ ok: false, retryable: true, reason: '421' });
    const lock = await holdProfileLock();
    let done = false;
    const running = tick().then((result) => {
      done = true;
      return result;
    });
    await Bun.sleep(500);
    expect(done).toBe(false);
    expect((await steps(enrollmentId))[0]?.status).toBe('sending');
    await lock.release();
    expect(await running).toEqual({ ...ZERO, postponed: 1 });
    expect((await steps(enrollmentId))[0]?.status).toBe('pending');
  });

  it('an expired sending step under a completed enrollment or a paused rule is cancelled and its cap reservation cleared', async () => {
    const expired = {
      dueAt: DUE,
      status: 'sending',
      attempt: 1,
      leaseUntil: new Date(NOW.getTime() - 1000),
      sentAt: new Date(NOW.getTime() - 5 * MINUTE_MS),
    };
    const completed = await enrollOne(rule({ name: 'completed' }), [expired]);
    await sql.$executeRawUnsafe(
      `UPDATE nudge.enrollments SET status = 'completed' WHERE id = $1::uuid`,
      completed.enrollmentId
    );
    const paused = await enrollOne(rule({ name: 'paused' }), [expired]);
    await sql.$executeRawUnsafe(
      `UPDATE nudge.rules SET status = 'paused' WHERE id = $1::uuid`,
      paused.ruleId
    );
    expect(await tick()).toEqual(ZERO);
    for (const { enrollmentId } of [completed, paused]) {
      const [step] = await steps(enrollmentId);
      expect(step?.status).toBe('cancelled');
      expect(step?.sent_at).toBeNull();
      expect(step?.lease_until).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('a rule paused between claim and send sends nothing and cancels the step', async () => {
    const { ruleId, enrollmentId } = await enrollOne();
    const pausing = {
      ...engine,
      async evaluateEnrollment(id: string) {
        await sql.$executeRawUnsafe(
          `UPDATE nudge.rules SET status = 'paused' WHERE id = $1::uuid`,
          ruleId
        );
        return await engine.evaluateEnrollment(id);
      },
    };
    expect(await tick(CFG, { engine: pausing })).toEqual({
      ...ZERO,
      skipped: 1,
    });
    expect(calls).toHaveLength(0);
    const [step] = await steps(enrollmentId);
    expect(step?.status).toBe('cancelled');
    expect(step?.outcome).toEqual({ reason: 'inactive' });
  });

  it('after an outage with two overdue steps only step 0 is claimed first', async () => {
    const definition = rule({
      steps: [
        { delaySeconds: HOUR, channel: 'email', template: { body: 'one' } },
        { delaySeconds: DAY, channel: 'email', template: { body: 'two' } },
      ],
    });
    const { enrollmentId } = await enrollOne(definition, [
      { dueAt: new Date(DUE.getTime() - DAY * 1000) },
      { dueAt: DUE },
    ]);
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
    expect((await steps(enrollmentId)).map((s) => s.status)).toEqual([
      'sent',
      'pending',
    ]);
    expect(await tick()).toEqual({ ...ZERO, sent: 1 });
    expect(calls.map((call) => call.opts.idempotencyKey)).toEqual([
      `${enrollmentId}:0`,
      `${enrollmentId}:1`,
    ]);
  });

  it('REVIEW FOCUS lag: an updated_at more than 60 s in the future blocks sending', async () => {
    const { enrollmentId } = await enrollOne();
    await setConsumerState(0, new Date(NOW.getTime() + 61_000));
    expect(await tick()).toEqual(ZERO);
    expect((await steps(enrollmentId))[0]?.status).toBe('pending');
  });

  it('the sweep completes an enrollment whose completion failed after its last step', async () => {
    const { enrollmentId } = await enrollOne();
    const flaky = flakySql('$transaction', null, 1);
    expect(await tick(CFG, { sql: flaky })).toEqual({ ...ZERO, sent: 1 });
    expect((await steps(enrollmentId))[0]?.status).toBe('sent');
    expect(await enrollmentStatus(enrollmentId)).toBe('active');
    expect(await tick()).toEqual(ZERO);
    expect(await enrollmentStatus(enrollmentId)).toBe('completed');
    expect(calls).toHaveLength(1);
  });

  it('PERF a step that is not the last finishes without a completion transaction', async () => {
    const definition = rule({
      steps: [
        { delaySeconds: HOUR, channel: 'email', template: { body: 'one' } },
        { delaySeconds: DAY, channel: 'email', template: { body: 'two' } },
      ],
    });
    const { enrollmentId } = await enrollOne(definition, [
      { dueAt: DUE },
      { dueAt: new Date(NOW.getTime() + DAY * 1000) },
    ]);
    let transactions = 0;
    const counting = new Proxy(sql, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== '$transaction' || typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          transactions++;
          return value.apply(target, args);
        };
      },
    });
    expect(
      await tick(CFG, { sql: counting, state: createTickState() })
    ).toEqual({ ...ZERO, sent: 1 });
    expect(transactions).toBe(0);
    expect(await enrollmentStatus(enrollmentId)).toBe('active');
  });

  it('with shared tick state the heal sweep runs at most once per interval', async () => {
    const state = createTickState();
    const { enrollmentId } = await enrollOne();
    const flaky = flakySql('$transaction', null, 1);
    expect(await tick(CFG, { sql: flaky, state })).toEqual({
      ...ZERO,
      sent: 1,
    });
    expect(await tick(CFG, { state })).toEqual(ZERO);
    expect(await enrollmentStatus(enrollmentId)).toBe('active');
    clock = new Date(NOW.getTime() + HEAL_SWEEP_INTERVAL_MS);
    await setConsumerState(0, clock);
    expect(await tick(CFG, { state })).toEqual(ZERO);
    expect(await enrollmentStatus(enrollmentId)).toBe('completed');
  });

  it('a closed lag gate warns at most once per interval with lag, threshold and state age', async () => {
    const state = createTickState();
    const logger = { warn: mock((..._args: unknown[]) => undefined) };
    await setConsumerState(CFG.maxLag + 1);
    await tick(CFG, { state, logger });
    await tick(CFG, { state, logger });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const first = logger.warn.mock.calls[0]?.join(' ') ?? '';
    expect(first).toContain(`consumer lag ${CFG.maxLag + 1}`);
    expect(first).toContain(`threshold ${CFG.maxLag}`);
    expect(first).toContain('state 0 s old');
    clock = new Date(NOW.getTime() + LAG_WARN_INTERVAL_MS);
    await tick(CFG, { state, logger });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[1]?.join(' ')).toContain('state 60 s old');
  });

  it('the claim query uses the pending and lease indexes', async () => {
    const definition = rule();
    const ruleId = await insertRule(definition);
    await sql.$executeRawUnsafe(
      `WITH e AS (
         INSERT INTO nudge.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
         SELECT gen_random_uuid(), $1, $2::uuid, $3::jsonb, 'p' || g, 'active', $4::timestamptz
         FROM generate_series(1, 20000) g
         RETURNING id)
       INSERT INTO nudge.steps (enrollment_id, step_index, due_at, status)
       SELECT id, 0, $4::timestamptz + random() * interval '30 days', 'pending' FROM e`,
      PROJECT,
      ruleId,
      JSON.stringify(definition),
      NOW.toISOString()
    );
    await sql.$executeRawUnsafe(
      'ANALYZE nudge.steps, nudge.enrollments, nudge.rules'
    );
    const plan = await sql.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN ${CLAIM_SQL}`,
        NOW.toISOString(),
        DUE.toISOString(),
        CFG.claimBatch,
        NOW.toISOString()
      );
      return rows.map((row) => Object.values(row).join(' ')).join('\n');
    });
    expect(plan).toContain('steps_pending_due_idx');
    expect(plan).toContain('steps_sending_lease_idx');
  });
});
