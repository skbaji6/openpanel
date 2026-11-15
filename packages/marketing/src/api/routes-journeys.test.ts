import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createEngine } from '../engine/engine';
import { createTemplateRegistry } from '../templates/registry';
import { createServer } from './server';

const PROXY_SECRET = 'proxy-secret-for-tests';
const BASE = 'http://marketing.internal';
const PROJECT = 'proj-a';
const CTX = { projectId: PROJECT, userId: 'user-1' };

const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  MARKETING_PROXY_SECRET: PROXY_SECRET,
  MARKETING_PUBLIC_URL: 'https://marketing.test',
});
const registry = createTemplateRegistry({ sql, now: () => new Date() });
let onRulesChanged = mock(() => Promise.resolve());
let app = createServer({ cfg, sql, onRulesChanged });

const pushTemplate = (body: string) => ({
  channel: 'push' as const,
  displayName: 'Nudge',
  category: 'service' as const,
  content: { subject: 'Hello', body },
});

const definition = (template: Record<string, unknown>) => ({
  name: 'Journey',
  trigger: { event: 'signup' },
  goal: { kind: 'event', event: 'paid' },
  steps: [{ delaySeconds: 60, channel: 'push', template }],
  reentry: { enabled: false, cooldownSeconds: 0 },
  allowedEventProps: [],
});

function call(method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-marketing-proxy-secret': PROXY_SECRET,
        'x-marketing-project-id': PROJECT,
        'x-marketing-user-id': 'user-1',
        'x-marketing-csrf': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

interface RuleBody {
  id: string;
  status: string;
  version: number;
  unconfirmed: string[];
  definition: { steps: { template: { body: string; version?: number } }[] };
}

async function createRule(
  def: unknown,
  status = 'draft',
  unconfirmed: string[] = []
) {
  const res = await call('POST', '/marketing/rules', {
    definition: def,
    status,
  });
  const rule = (await res.json()) as RuleBody;
  if (unconfirmed.length > 0) {
    await sql.$executeRawUnsafe(
      'UPDATE marketing.rules SET unconfirmed = $2::text[] WHERE id = $1::uuid',
      rule.id,
      unconfirmed
    );
  }
  return rule;
}

const errorOf = async (res: Response) => {
  const body = (await res.json()) as { error: string; details?: unknown };
  return [res.status, body.error, body.details];
};

const newTemplate = (body: string) => registry.create(CTX, pushTemplate(body));

function enroll(profileId: string) {
  return createEngine({ sql }).handleEvent({
    eventId: randomUUID(),
    projectId: PROJECT,
    profileId,
    name: 'signup',
    time: new Date(),
    properties: {},
  });
}

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetMarketingTables();
  onRulesChanged = mock(() => Promise.resolve());
  app = createServer({ cfg, sql, onRulesChanged });
});
afterAll(() => sql.$disconnect());

describe('journey lifecycle', () => {
  it('start pins templates and activates a draft', async () => {
    const t = await newTemplate('Come back');
    const rule = await createRule(definition({ templateId: t.templateId }));
    const res = await call('POST', `/marketing/rules/${rule.id}/start`, {
      expectedVersion: rule.version,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rule: RuleBody;
      pinned: { templateId: string; version: number }[];
    };
    expect(body.rule).toMatchObject({
      status: 'active',
      version: rule.version + 1,
    });
    expect(body.rule.definition.steps[0]?.template).toMatchObject({
      body: 'Come back',
      version: 1,
    });
    expect(body.pinned).toMatchObject([
      { templateId: t.templateId, version: 1 },
    ]);
    expect(onRulesChanged).toHaveBeenCalled();
  });

  it('start refuses journey_unconfirmed and lists the fields', async () => {
    const rule = await createRule(definition({ body: 'x' }), 'draft', [
      'trigger',
      'goal',
    ]);
    const res = await call('POST', `/marketing/rules/${rule.id}/start`, {
      expectedVersion: rule.version,
    });
    expect(await errorOf(res)).toEqual([
      409,
      'journey_unconfirmed',
      { fields: ['trigger', 'goal'] },
    ]);
  });

  it('start gates: not_found, stale version, then already active', async () => {
    const rule = await createRule(definition({ body: 'x' }));
    const missing = await call(
      'POST',
      `/marketing/rules/${randomUUID()}/start`,
      { expectedVersion: 1 }
    );
    expect((await errorOf(missing))[0]).toBe(404);
    const stale = await call('POST', `/marketing/rules/${rule.id}/start`, {
      expectedVersion: rule.version + 5,
    });
    expect((await errorOf(stale)).slice(0, 2)).toEqual([
      409,
      'version_conflict',
    ]);
    const first = await call('POST', `/marketing/rules/${rule.id}/start`, {
      expectedVersion: rule.version,
    });
    expect(first.status).toBe(200);
    const again = await call('POST', `/marketing/rules/${rule.id}/start`, {
      expectedVersion: rule.version + 1,
    });
    expect((await errorOf(again)).slice(0, 2)).toEqual([
      409,
      'invalid_transition',
    ]);
  });

  it('two concurrent starts activate once', async () => {
    const t = await newTemplate('Come back');
    const rule = await createRule(definition({ templateId: t.templateId }));
    const path = `/marketing/rules/${rule.id}/start`;
    const results = await Promise.all([
      call('POST', path, { expectedVersion: rule.version }),
      call('POST', path, { expectedVersion: rule.version }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('start refuses a disabled template, even one already versioned', async () => {
    const t = await newTemplate('Come back');
    const rule = await createRule(
      definition({ templateId: t.templateId, version: 1 })
    );
    await registry.setEnabled(CTX, t.templateId, false);
    const res = await call('POST', `/marketing/rules/${rule.id}/start`, {
      expectedVersion: rule.version,
    });
    expect(await errorOf(res)).toEqual([
      409,
      'template_disabled',
      { stepIndex: 0, variant: 'default' },
    ]);
    const [row] = await sql.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM marketing.rules WHERE id = $1::uuid',
      rule.id
    );
    expect(row?.status).toBe('draft');
  });

  it('PATCH status active on a draft is use_start', async () => {
    const rule = await createRule(definition({ body: 'x' }));
    const res = await call('PATCH', `/marketing/rules/${rule.id}`, {
      status: 'active',
    });
    expect((await errorOf(res)).slice(0, 2)).toEqual([409, 'use_start']);
  });

  it('PATCH confirmed and a changed trigger or goal clear unconfirmed', async () => {
    const rule = await createRule(definition({ body: 'x' }), 'draft', [
      'trigger',
      'goal',
    ]);
    const confirmed = await call('PATCH', `/marketing/rules/${rule.id}`, {
      confirmed: ['trigger'],
    });
    expect(((await confirmed.json()) as RuleBody).unconfirmed).toEqual([
      'goal',
    ]);
    const changed = await call('PATCH', `/marketing/rules/${rule.id}`, {
      definition: {
        ...definition({ body: 'x' }),
        goal: { kind: 'event', event: 'refund' },
      },
    });
    expect(((await changed.json()) as RuleBody).unconfirmed).toEqual([]);
  });

  it('resuming a paused journey pins an unversioned template ref', async () => {
    const t = await newTemplate('Come back');
    const rule = await createRule(
      definition({ templateId: t.templateId }),
      'paused'
    );
    const res = await call('PATCH', `/marketing/rules/${rule.id}`, {
      status: 'active',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RuleBody;
    expect(body.status).toBe('active');
    expect(body.definition.steps[0]?.template).toMatchObject({
      body: 'Come back',
      version: 1,
    });
  });

  it('resuming refuses a disabled template and stays paused', async () => {
    const t = await newTemplate('Come back');
    const rule = await createRule(
      definition({ templateId: t.templateId }),
      'paused'
    );
    await registry.setEnabled(CTX, t.templateId, false);
    const res = await call('PATCH', `/marketing/rules/${rule.id}`, {
      status: 'active',
    });
    expect((await errorOf(res)).slice(0, 2)).toEqual([
      409,
      'template_disabled',
    ]);
    const [row] = await sql.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM marketing.rules WHERE id = $1::uuid',
      rule.id
    );
    expect(row?.status).toBe('paused');
  });

  it('POST rules with status active pins first', async () => {
    const t = await newTemplate('Come back');
    const rule = await createRule(
      definition({ templateId: t.templateId }),
      'active'
    );
    expect(rule.definition.steps[0]?.template.version).toBe(1);
  });

  it('editing an active journey re-pins templates and a running enrollment keeps its old snapshot text', async () => {
    const first = await newTemplate('Old text');
    const second = await newTemplate('New text');
    const rule = await createRule(
      definition({ templateId: first.templateId }),
      'active'
    );
    await enroll('u1');
    const res = await call('PATCH', `/marketing/rules/${rule.id}`, {
      definition: definition({ templateId: second.templateId }),
    });
    expect(res.status).toBe(200);
    await enroll('u2');
    const rows = await sql.$queryRawUnsafe<
      { profile_id: string; body: string }[]
    >(
      `SELECT profile_id, rule_snapshot->'steps'->0->'template'->>'body' AS body
       FROM marketing.enrollments ORDER BY profile_id`
    );
    expect(rows).toEqual([
      { profile_id: 'u1', body: 'Old text' },
      { profile_id: 'u2', body: 'New text' },
    ]);
  });

  it('skips counts reasons by code', async () => {
    const rule = await createRule(definition({ body: 'x' }), 'active');
    for (const profileId of ['u1', 'u2', 'u3']) {
      await enroll(profileId);
    }
    const reasons = ['no_state_message', 'no_state_message', 'no_device'];
    const steps = await sql.$queryRawUnsafe<{ enrollment_id: string }[]>(
      'SELECT enrollment_id::text FROM marketing.steps ORDER BY enrollment_id'
    );
    for (const [index, step] of steps.entries()) {
      await sql.$executeRawUnsafe(
        `UPDATE marketing.steps SET status = 'skipped', outcome = $2::jsonb
         WHERE enrollment_id = $1::uuid`,
        step.enrollment_id,
        JSON.stringify({ reason: reasons[index] })
      );
    }
    const res = await call('GET', `/marketing/rules/${rule.id}/skips`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reasons: [
        { reason: 'no_state_message', count: 2 },
        { reason: 'no_device', count: 1 },
      ],
    });
  });
});
