import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetNudgeTables } from '../db/test-helpers';
import { createEngine } from '../engine/engine';
import type { NormalizedEvent } from '../events/normalize';
import type { RuleDefinition } from '../rules/rule.schema';
import {
  createMemoryInterestSet,
  createRedisInterestSet,
  INTEREST_PROFILES_KEY,
} from './interest';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const PROJECT = 'project-a';
const PROFILE = 'u1';
const HOUR = 3600;

const engine = createEngine({ sql, now: () => NOW });

function rule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    name: 'test rule',
    trigger: { event: 'purchase' },
    goal: { kind: 'event', event: 'opened' },
    steps: [
      { delaySeconds: HOUR, channel: 'email', template: { body: 'one' } },
    ],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
    ...overrides,
  };
}

async function insertRule(definition: RuleDefinition): Promise<void> {
  await sql.$executeRawUnsafe(
    `INSERT INTO nudge.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, $3, 'active', $4::jsonb)`,
    randomUUID(),
    PROJECT,
    definition.name,
    JSON.stringify(definition)
  );
}

function event(name: string, minutesAfterNow: number): NormalizedEvent {
  return {
    eventId: randomUUID(),
    projectId: PROJECT,
    profileId: PROFILE,
    name,
    time: new Date(NOW.getTime() + minutesAfterNow * 60_000),
    properties: {},
  };
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetNudgeTables();
  await getRedisCache().del(INTEREST_PROFILES_KEY);
});

afterAll(async () => {
  await getRedisCache().del(INTEREST_PROFILES_KEY);
  getRedisCache().disconnect();
  await sql.$disconnect();
});

describe('memory interest set', () => {
  it("interest.refresh picks up a newly created active rule's event names", async () => {
    const interest = createMemoryInterestSet({ engine, sql });
    await interest.refresh();
    expect(await interest.has(PROJECT, 'purchase', PROFILE)).toBe(false);

    await insertRule(rule({ trigger: { event: 'add_to_cart' } }));
    expect(await interest.has(PROJECT, 'add_to_cart', PROFILE)).toBe(false);
    await interest.refresh();
    expect(await interest.has(PROJECT, 'add_to_cart', PROFILE)).toBe(true);
    expect(await interest.has(PROJECT, 'opened', PROFILE)).toBe(true);
    expect(await interest.has(PROJECT, 'page_view', PROFILE)).toBe(false);
  });

  it('memory interest set reports a profile active after enrollment and inactive after completion', async () => {
    await insertRule(rule());
    const interest = createMemoryInterestSet({ engine, sql });
    await interest.refresh();
    expect(await interest.has(PROJECT, 'page_view', PROFILE)).toBe(false);

    await engine.handleEvents([event('purchase', 0)]);
    await interest.refresh();
    expect(await interest.has(PROJECT, 'page_view', PROFILE)).toBe(true);
    expect(await interest.has('project-b', 'page_view', PROFILE)).toBe(false);
    expect(await interest.has(PROJECT, 'page_view', 'u2')).toBe(false);

    await engine.handleEvents([event('opened', 1)]);
    await interest.refresh();
    expect(await interest.has(PROJECT, 'page_view', PROFILE)).toBe(false);
  });
});

describe('redis interest set', () => {
  it('a profile added on one replica is seen by another before any refresh', async () => {
    const replicaA = createRedisInterestSet(getRedisCache(), { engine, sql });
    const replicaB = createRedisInterestSet(getRedisCache(), { engine, sql });
    await replicaA.refresh();
    await replicaB.refresh();
    expect(await replicaB.has(PROJECT, 'page_view', PROFILE)).toBe(false);

    await replicaA.add([{ projectId: PROJECT, profileId: PROFILE }]);
    expect(await replicaB.has(PROJECT, 'page_view', PROFILE)).toBe(true);
  });

  it('refresh replaces the shared profile set with the active enrollments', async () => {
    await insertRule(rule());
    const interest = createRedisInterestSet(getRedisCache(), { engine, sql });
    await interest.add([{ projectId: PROJECT, profileId: 'stale' }]);
    await engine.handleEvents([event('purchase', 0)]);
    await interest.refresh();
    expect(await interest.has(PROJECT, 'page_view', PROFILE)).toBe(true);
    expect(await interest.has(PROJECT, 'page_view', 'stale')).toBe(false);
    expect(await interest.has(PROJECT, 'purchase', 'anyone')).toBe(true);
  });
});
