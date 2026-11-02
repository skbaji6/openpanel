import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { type NormalizedEvent, normalizeEvent } from '../events/normalize';
import type { Goal, RuleDefinition } from '../rules/rule.schema';
import {
  createEngine,
  ENROLL_SQL,
  evaluateGoal,
  GOAL_FACTS_SQL,
  MAX_FUTURE_SKEW_MS,
  matchesTrigger,
  PURGE_CHUNK_SQL,
} from './engine';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const HOUR = 3600;
const DAY = 24 * HOUR;
const MINUTE_MS = 60_000;
const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const PROFILE = 'u1';
const BOOK_A = 'book-a';
const BOOK_B = 'book-b';

let clock = NOW;
const engine = createEngine({ sql, now: () => clock });

function at(minutesAfterNow: number): Date {
  return new Date(NOW.getTime() + minutesAfterNow * MINUTE_MS);
}

function rule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    name: 'test rule',
    trigger: { event: 'purchase' },
    goal: { kind: 'event', event: 'opened' },
    steps: [
      { delaySeconds: HOUR, channel: 'email', template: { body: 'one' } },
      { delaySeconds: DAY, channel: 'email', template: { body: 'two' } },
    ],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
    ...overrides,
  };
}

async function insertRule(
  definition: RuleDefinition,
  projectId = PROJECT_A,
  status = 'active'
): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
    id,
    projectId,
    definition.name,
    status,
    JSON.stringify(definition)
  );
  return id;
}

function event(
  name: string,
  time: Date,
  properties: NormalizedEvent['properties'] = {},
  overrides: Partial<NormalizedEvent> = {}
): NormalizedEvent {
  return {
    eventId: randomUUID(),
    projectId: PROJECT_A,
    profileId: PROFILE,
    name,
    time,
    properties,
    ...overrides,
  };
}

interface EnrollmentRow {
  id: string;
  project_id: string;
  match_value: string;
  status: string;
  end_reason: string | null;
  trigger_time: Date;
  rule_snapshot: RuleDefinition;
}

function enrollments(): Promise<EnrollmentRow[]> {
  return sql.$queryRawUnsafe<EnrollmentRow[]>(
    `SELECT id::text, project_id, match_value, status, end_reason, trigger_time, rule_snapshot
     FROM marketing.enrollments ORDER BY match_value, created_at, trigger_time`
  );
}

function steps(
  enrollmentId?: string
): Promise<{ step_index: number; due_at: Date; status: string }[]> {
  return sql.$queryRawUnsafe(
    `SELECT step_index, due_at, status FROM marketing.steps
     WHERE $1::uuid IS NULL OR enrollment_id = $1::uuid
     ORDER BY enrollment_id, step_index`,
    enrollmentId ?? null
  );
}

const OVERLAP_ROUNDS = 20;
const OVERLAP_TEST_TIMEOUT_MS = 60_000;
const BLOCKED_SESSION_POLL_MS = 20;
const BLOCKED_SESSION_TIMEOUT_MS = 10_000;

// Holds the engine's transaction open after its work, just before commit, until release().
function gatedEngine() {
  const gate = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const gatedSql = new Proxy(sql, {
    get(target, prop) {
      if (prop !== '$transaction') {
        return Reflect.get(target, prop);
      }
      return (fn: (tx: unknown) => Promise<unknown>, options: unknown) =>
        target.$transaction(async (tx) => {
          const result = await fn(tx);
          commit.resolve();
          await gate.promise;
          return result;
        }, options as never);
    },
  });
  return {
    engine: createEngine({ sql: gatedSql, now: () => clock }),
    atCommit: commit.promise,
    release: () => gate.resolve(),
  };
}

async function waitForBlockedSession() {
  const deadline = Date.now() + BLOCKED_SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = await sql.$queryRawUnsafe<{ waiting: number }[]>(
      'SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted'
    );
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    await Bun.sleep(BLOCKED_SESSION_POLL_MS);
  }
  throw new Error('no session blocked on a lock');
}

async function insertReferenceSet(setKey: string, values: string[]) {
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.reference_sets (project_id, set_key, values) VALUES ($1, $2, $3::jsonb)',
    PROJECT_A,
    setKey,
    JSON.stringify(values)
  );
}

async function count(table: string): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM marketing.${table}`
  );
  return row?.count ?? 0;
}

async function onlyEnrollment(): Promise<EnrollmentRow> {
  const rows = await enrollments();
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(`expected exactly one enrollment, got ${rows.length}`);
  }
  return row;
}

function secondsAfter(time: Date, seconds: number): number {
  return time.getTime() + seconds * 1000;
}

describe('matchesTrigger', () => {
  it('requires the trigger name, every filter and the matchOn property', () => {
    const definition = rule({
      trigger: {
        event: 'purchase',
        filters: [{ property: 'plan', equals: '3' }],
      },
      matchOn: 'book_id',
    });
    const props = { plan: 3, book_id: BOOK_A };
    expect(
      matchesTrigger(definition, { name: 'purchase', properties: props })
    ).toBe(true);
    expect(
      matchesTrigger(definition, { name: 'opened', properties: props })
    ).toBe(false);
    expect(
      matchesTrigger(definition, {
        name: 'purchase',
        properties: { ...props, plan: 4 },
      })
    ).toBe(false);
    expect(
      matchesTrigger(definition, { name: 'purchase', properties: { plan: 3 } })
    ).toBe(false);
    expect(
      matchesTrigger(definition, {
        name: 'purchase',
        properties: { plan: 3, book_id: null },
      })
    ).toBe(false);
  });

  it('does not read inherited properties', () => {
    const definition = rule({ matchOn: 'constructor' });
    expect(
      matchesTrigger(definition, { name: 'purchase', properties: {} })
    ).toBe(false);
  });
});

describe('evaluateGoal', () => {
  const setGoal: Goal = {
    kind: 'set',
    event: 'section',
    property: 'section_id',
    setKey: 'k',
  };

  it('event goal is met exactly when a goal event was seen', () => {
    const goal: Goal = { kind: 'event', event: 'opened' };
    const facts = { goalEventSeen: true, seenValues: [], referenceSet: [] };
    expect(evaluateGoal(goal, facts)).toEqual({ met: true, missing: [] });
    expect(evaluateGoal(goal, { ...facts, goalEventSeen: false })).toEqual({
      met: false,
      missing: [],
    });
  });

  it('set goal reports the missing values and never completes on an empty set', () => {
    const facts = {
      goalEventSeen: true,
      seenValues: ['s1', 's2'],
      referenceSet: ['s1', 's2', 's3'],
    };
    expect(evaluateGoal(setGoal, facts)).toEqual({
      met: false,
      missing: ['s3'],
    });
    expect(
      evaluateGoal(setGoal, { ...facts, seenValues: ['s3', 's2', 's1'] })
    ).toEqual({
      met: true,
      missing: [],
    });
    expect(evaluateGoal(setGoal, { ...facts, referenceSet: [] })).toEqual({
      met: false,
      missing: [],
    });
  });

  it('inactivity goal is never met', () => {
    const goal: Goal = { kind: 'inactivity', excludeEvents: [] };
    expect(
      evaluateGoal(goal, {
        goalEventSeen: true,
        seenValues: [],
        referenceSet: [],
      })
    ).toEqual({
      met: false,
      missing: [],
    });
  });
});

describe('engine', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(async () => {
    clock = NOW;
    await resetMarketingTables();
  });
  afterAll(async () => {
    await resetMarketingTables();
    await sql.$disconnect();
  });

  it('trigger event enrolls the profile with step due_at = trigger_time + delaySeconds', async () => {
    const definition = rule();
    await insertRule(definition);
    const triggerTime = at(-10);
    await engine.handleEvent(event('purchase', triggerTime));

    const enrollment = await onlyEnrollment();
    expect(enrollment.status).toBe('active');
    expect(enrollment.match_value).toBe('');
    expect(enrollment.trigger_time.getTime()).toBe(triggerTime.getTime());
    expect(enrollment.rule_snapshot).toEqual(definition);
    const rows = await steps(enrollment.id);
    expect(
      rows.map((s) => [s.step_index, s.due_at.getTime(), s.status])
    ).toEqual([
      [0, secondsAfter(triggerTime, HOUR), 'pending'],
      [1, secondsAfter(triggerTime, DAY), 'pending'],
    ]);
  });

  it('a matching goal event completes the enrollment and cancels pending steps', async () => {
    await insertRule(rule());
    await engine.handleEvent(event('purchase', at(0)));
    await engine.handleEvent(event('opened', at(5)));

    const enrollment = await onlyEnrollment();
    expect(enrollment.status).toBe('completed');
    expect(enrollment.end_reason).toBe('goal');
    expect((await steps()).map((s) => s.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it('goal event for a different match value does not cancel', async () => {
    await insertRule(rule({ matchOn: 'book_id' }));
    await engine.handleEvent(event('purchase', at(0), { book_id: BOOK_A }));
    await engine.handleEvent(event('opened', at(5), { book_id: BOOK_B }));
    await engine.handleEvent(event('opened', at(6)));

    const enrollment = await onlyEnrollment();
    expect(enrollment.match_value).toBe(BOOK_A);
    expect(enrollment.status).toBe('active');
    expect((await steps()).map((s) => s.status)).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('two purchases of different books create two independent enrollments', async () => {
    await insertRule(rule({ matchOn: 'book_id' }));
    await engine.handleEvent(event('purchase', at(0), { book_id: BOOK_A }));
    await engine.handleEvent(event('purchase', at(1), { book_id: BOOK_B }));
    await engine.handleEvent(event('opened', at(5), { book_id: BOOK_B }));

    const rows = await enrollments();
    expect(rows.map((r) => [r.match_value, r.status])).toEqual([
      [BOOK_A, 'active'],
      [BOOK_B, 'completed'],
    ]);
    expect(await count('steps')).toBe(4);
  });

  it('numeric matchOn values match goal events as strings', async () => {
    await insertRule(rule({ matchOn: 'book_id' }));
    await engine.handleEvent(event('purchase', at(0), { book_id: 42 }));
    await engine.handleEvent(event('opened', at(5), { book_id: '42' }));

    const enrollment = await onlyEnrollment();
    expect(enrollment.match_value).toBe('42');
    expect(enrollment.status).toBe('completed');
  });

  it('trigger without the matchOn property does not enroll', async () => {
    await insertRule(rule({ matchOn: 'book_id' }));
    await engine.handleEvent(event('purchase', at(0), { other: 'x' }));

    expect(await count('enrollments')).toBe(0);
    expect(await count('events')).toBe(1);
  });

  it('a paused rule does not enroll', async () => {
    await insertRule(rule(), PROJECT_A, 'paused');
    await engine.handleEvent(event('purchase', at(0)));
    expect(await count('enrollments')).toBe(0);
  });

  it('event without a profile is never stored', async () => {
    await insertRule(rule());
    const normalized = normalizeEvent({
      projectId: PROJECT_A,
      event: {
        name: 'purchase',
        properties: {},
        timestamp: at(0).toISOString(),
      },
    });
    expect(normalized).toBeNull();
    if (normalized) {
      await engine.handleEvent(normalized);
    }
    expect(await count('events')).toBe(0);
    expect(await count('enrollments')).toBe(0);
  });

  it('REVIEW FOCUS out-of-order: goal event handled first, then the trigger with an earlier event_time than the goal → enrollment is created already completed and no step stays pending', async () => {
    await insertRule(rule({ matchOn: 'book_id' }));
    await engine.handleEvent(event('opened', at(5), { book_id: BOOK_A }));
    await engine.handleEvent(event('purchase', at(0), { book_id: BOOK_A }));

    const enrollment = await onlyEnrollment();
    expect(enrollment.status).toBe('completed');
    expect((await steps()).map((s) => s.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it('REVIEW FOCUS out-of-order: goal event with event_time earlier than the trigger_time does not complete the enrollment', async () => {
    await insertRule(rule());
    await engine.handleEvent(event('opened', at(-5)));
    await engine.handleEvent(event('purchase', at(0)));
    await engine.handleEvent(event('opened', at(-1)));

    const enrollment = await onlyEnrollment();
    expect(enrollment.status).toBe('active');
    expect((await steps()).map((s) => s.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(await engine.evaluateEnrollment(enrollment.id)).toEqual({
      met: false,
      missing: [],
    });
  });

  it('REVIEW FOCUS redelivery: handling the same eventId twice creates one enrollment and one set of steps', async () => {
    await insertRule(rule({ reentry: { enabled: true, cooldownSeconds: 0 } }));
    const trigger = event('purchase', at(0));
    await engine.handleEvent(trigger);
    await engine.handleEvent(trigger);
    await engine.handleEvents([trigger, trigger]);

    expect(await count('events')).toBe(1);
    expect(await count('enrollments')).toBe(1);
    expect(await count('steps')).toBe(2);
  });

  it('a redelivered goal event does not re-run goal effects', async () => {
    await insertRule(rule({ reentry: { enabled: true, cooldownSeconds: 0 } }));
    await engine.handleEvent(event('purchase', at(0)));
    const goal = event('opened', at(5));
    await engine.handleEvent(goal);
    await engine.handleEvent(event('purchase', at(10)));
    await engine.handleEvent(goal);

    expect((await enrollments()).map((r) => r.status).sort()).toEqual([
      'active',
      'completed',
    ]);
  });

  it('set goal: sections s1,s2 seen of {s1,s2,s3} does not complete; seeing s3 completes; missing is [s3] before', async () => {
    await insertRule(
      rule({
        matchOn: 'book_id',
        goal: {
          kind: 'set',
          event: 'section_opened',
          property: 'section_id',
          setKey: BOOK_A,
        },
      })
    );
    await sql.$executeRawUnsafe(
      'INSERT INTO marketing.reference_sets (project_id, set_key, values) VALUES ($1, $2, $3::jsonb)',
      PROJECT_A,
      BOOK_A,
      JSON.stringify(['s1', 's2', 's3'])
    );
    await engine.handleEvent(
      event('section_opened', at(-1), { book_id: BOOK_A, section_id: 's3' })
    );
    await engine.handleEvent(event('purchase', at(0), { book_id: BOOK_A }));
    await engine.handleEvent(
      event('section_opened', at(1), { book_id: BOOK_A, section_id: 's1' })
    );
    await engine.handleEvent(
      event('section_opened', at(2), { book_id: BOOK_A, section_id: 's2' })
    );
    await engine.handleEvent(
      event('section_opened', at(3), { book_id: BOOK_B, section_id: 's3' })
    );

    const enrollment = await onlyEnrollment();
    expect(enrollment.status).toBe('active');
    expect(await engine.evaluateEnrollment(enrollment.id)).toEqual({
      met: false,
      missing: ['s3'],
    });

    await engine.handleEvent(
      event('section_opened', at(4), { book_id: BOOK_A, section_id: 's3' })
    );
    expect((await onlyEnrollment()).status).toBe('completed');
    expect((await steps()).map((s) => s.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it('set goal whose reference set is missing or empty is never met', async () => {
    await insertRule(
      rule({
        goal: {
          kind: 'set',
          event: 'section_opened',
          property: 'section_id',
          setKey: 'none',
        },
      })
    );
    await engine.handleEvent(event('purchase', at(0)));
    await engine.handleEvent(
      event('section_opened', at(1), { section_id: 's1' })
    );
    const enrollment = await onlyEnrollment();
    expect(enrollment.status).toBe('active');
    expect(await engine.evaluateEnrollment(enrollment.id)).toEqual({
      met: false,
      missing: [],
    });

    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.reference_sets (project_id, set_key, values) VALUES ($1, 'none', '[]'::jsonb)`,
      PROJECT_A
    );
    await engine.handleEvent(
      event('section_opened', at(2), { section_id: 's2' })
    );
    expect((await onlyEnrollment()).status).toBe('active');
  });

  it('inactivity: a later activity event moves pending due_at forward by its delay from that event; an excluded event does not', async () => {
    await insertRule(
      rule({
        trigger: { event: 'app_opened' },
        goal: { kind: 'inactivity', excludeEvents: ['marketing_clicked'] },
      })
    );
    await engine.handleEvent(event('app_opened', at(0)));
    await engine.handleEvent(event('page_view', at(30)));
    await engine.handleEvent(event('marketing_clicked', at(60)));
    await engine.handleEvent(event('page_view', at(20)));

    const enrollment = await onlyEnrollment();
    expect(enrollment.status).toBe('active');
    expect((await steps()).map((s) => [s.due_at.getTime(), s.status])).toEqual([
      [secondsAfter(at(30), HOUR), 'pending'],
      [secondsAfter(at(30), DAY), 'pending'],
    ]);
  });

  it('inactivity: activity stored before the trigger arrived but later in event time debounces the new enrollment', async () => {
    await insertRule(
      rule({
        trigger: { event: 'app_opened' },
        goal: { kind: 'inactivity', excludeEvents: ['marketing_clicked'] },
      })
    );
    await engine.handleEvent(event('page_view', at(-5)));
    await engine.handleEvent(event('page_view', at(30)));
    await engine.handleEvent(event('marketing_clicked', at(60)));
    await engine.handleEvent(event('app_opened', at(0)));

    expect((await steps()).map((s) => s.due_at.getTime())).toEqual([
      secondsAfter(at(30), HOUR),
      secondsAfter(at(30), DAY),
    ]);
  });

  it('re-entry disabled: second trigger after completion creates nothing; enabled with cooldown elapsed creates a new enrollment', async () => {
    await insertRule(rule({ trigger: { event: 'signup' } }));
    await insertRule(
      rule({
        trigger: { event: 'purchase' },
        reentry: { enabled: true, cooldownSeconds: DAY },
      })
    );
    await engine.handleEvent(event('signup', at(0)));
    await engine.handleEvent(event('purchase', at(0)));
    await engine.handleEvent(event('opened', at(1)));
    expect((await enrollments()).map((r) => r.status)).toEqual([
      'completed',
      'completed',
    ]);

    await engine.handleEvent(event('signup', at(2)));
    await engine.handleEvent(event('purchase', at(2)));
    expect(await count('enrollments')).toBe(2);

    clock = new Date(secondsAfter(NOW, DAY + 1));
    await engine.handleEvent(event('signup', at(3)));
    await engine.handleEvent(event('purchase', at(3)));
    const rows = await enrollments();
    expect(rows).toHaveLength(3);
    expect(
      rows
        .filter((r) => r.status === 'active')
        .map((r) => r.rule_snapshot.trigger.event)
    ).toEqual(['purchase']);
  });

  it('a repeat trigger while an enrollment is active is ignored even with re-entry enabled', async () => {
    await insertRule(rule({ reentry: { enabled: true, cooldownSeconds: 0 } }));
    await engine.handleEvent(event('purchase', at(0)));
    await engine.handleEvent(event('purchase', at(1)));
    expect(await count('enrollments')).toBe(1);
  });

  it('set goal with matchOn: the reference set is keyed by the match value, so two books with different sets complete independently', async () => {
    await insertRule(
      rule({
        matchOn: 'item_id',
        goal: {
          kind: 'set',
          event: 'section_opened',
          property: 'section_id',
          setKey: 'item_id',
        },
      })
    );
    await insertReferenceSet(BOOK_A, ['a1', 'a2']);
    await insertReferenceSet(BOOK_B, ['b1']);
    await engine.handleEvent(event('purchase', at(0), { item_id: BOOK_A }));
    await engine.handleEvent(event('purchase', at(0), { item_id: BOOK_B }));
    await engine.handleEvent(
      event('section_opened', at(1), { item_id: BOOK_B, section_id: 'b1' })
    );
    await engine.handleEvent(
      event('section_opened', at(2), { item_id: BOOK_A, section_id: 'a1' })
    );

    let rows = await enrollments();
    expect(rows.map((r) => [r.match_value, r.status])).toEqual([
      [BOOK_A, 'active'],
      [BOOK_B, 'completed'],
    ]);
    const [bookA] = rows;
    expect(bookA && (await engine.evaluateEnrollment(bookA.id))).toEqual({
      met: false,
      missing: ['a2'],
    });

    await engine.handleEvent(
      event('section_opened', at(3), { item_id: BOOK_A, section_id: 'a2' })
    );
    rows = await enrollments();
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed']);
  });

  it('set goal uses the reference values snapshotted at enrollment; a registry edit only affects new enrollments', async () => {
    await insertRule(
      rule({
        goal: {
          kind: 'set',
          event: 'section_opened',
          property: 'section_id',
          setKey: 'k',
        },
      })
    );
    await insertReferenceSet('k', ['s1', 's2']);
    await engine.handleEvent(event('purchase', at(0), {}, { profileId: 'u1' }));
    await sql.$executeRawUnsafe(
      `UPDATE marketing.reference_sets SET values = '["s1"]'::jsonb WHERE project_id = $1 AND set_key = 'k'`,
      PROJECT_A
    );
    await engine.handleEvent(event('purchase', at(0), {}, { profileId: 'u2' }));
    await engine.handleEvent(
      event('section_opened', at(1), { section_id: 's1' }, { profileId: 'u1' })
    );
    await engine.handleEvent(
      event('section_opened', at(1), { section_id: 's1' }, { profileId: 'u2' })
    );

    const rows = await sql.$queryRawUnsafe<
      { id: string; profile_id: string; status: string; values: string[] }[]
    >(
      `SELECT id::text, profile_id, status, rule_snapshot->'referenceValues' AS values
       FROM marketing.enrollments ORDER BY profile_id`
    );
    expect(rows.map((r) => [r.profile_id, r.status, r.values])).toEqual([
      ['u1', 'active', ['s1', 's2']],
      ['u2', 'completed', ['s1']],
    ]);
    const [first] = rows;
    expect(first && (await engine.evaluateEnrollment(first.id))).toEqual({
      met: false,
      missing: ['s2'],
    });
  });

  it('a cancelled enrollment does not block re-entry even when re-entry is disabled', async () => {
    await insertRule(rule());
    await engine.handleEvent(event('purchase', at(0)));
    await sql.$executeRawUnsafe(
      `UPDATE marketing.enrollments SET status = 'cancelled'`
    );
    await engine.handleEvent(event('purchase', at(1)));

    expect((await enrollments()).map((r) => r.status).sort()).toEqual([
      'active',
      'cancelled',
    ]);
  });

  it('events more than MAX_FUTURE_SKEW_MS after now are dropped before storing', async () => {
    await insertRule(rule());
    const tooLate = new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS + MINUTE_MS);
    const justInside = new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS);
    await engine.handleEvents([
      event('purchase', tooLate),
      event('page_view', justInside),
    ]);
    await engine.handleEvent(
      event('purchase', tooLate, {}, { profileId: 'u2' })
    );

    expect(await count('events')).toBe(1);
    expect(await count('enrollments')).toBe(0);
  });

  it('PERF re-entry lookup in the enrollment insert uses enrollments_reentry_idx', async () => {
    const ruleId = randomUUID();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, match_value, status, trigger_time, created_at)
       SELECT gen_random_uuid(), $1, $2::uuid, '{}'::jsonb, 'u' || (g % 2000), 'm' || g, 'completed', now(), now()
       FROM generate_series(1, 20000) g`,
      PROJECT_A,
      ruleId
    );
    await sql.$executeRawUnsafe('ANALYZE marketing.enrollments');
    const plan = await sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN ${ENROLL_SQL}`,
        PROJECT_A,
        ruleId,
        JSON.stringify(rule()),
        'u7',
        'm7',
        NOW.toISOString(),
        NOW.toISOString(),
        true,
        0
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('enrollments_reentry_idx');
  });

  it('REVIEW race: a trigger blocked behind a batch that enrolls and completes the same key does not re-enroll when re-entry is disabled', async () => {
    await insertRule(rule());
    const held = gatedEngine();
    const runA = held.engine.handleEvents([
      event('purchase', at(0)),
      event('opened', at(5)),
    ]);
    await held.atCommit;
    const runB = engine.handleEvents([event('purchase', at(10))]);
    await waitForBlockedSession();
    held.release();
    await Promise.all([runA, runB]);

    expect((await enrollments()).map((r) => r.status)).toEqual(['completed']);
    expect((await steps()).map((s) => s.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it(
    'overlapping batches with opposite event-time order over the same two keys complete without deadlock',
    async () => {
      await insertRule(
        rule({ reentry: { enabled: true, cooldownSeconds: 0 } })
      );
      const rounds = Array.from(
        { length: OVERLAP_ROUNDS },
        (_, round) => round
      );
      for (const round of rounds) {
        const first = { profileId: `u1-${round}` };
        const second = { profileId: `u2-${round}` };
        await Promise.all([
          engine.handleEvents([
            event('purchase', at(0), {}, first),
            event('purchase', at(1), {}, second),
          ]),
          engine.handleEvents([
            event('purchase', at(0), {}, second),
            event('purchase', at(1), {}, first),
          ]),
        ]);
      }
      expect(await count('enrollments')).toBe(2 * OVERLAP_ROUNDS);
      expect(await count('steps')).toBe(4 * OVERLAP_ROUNDS);
    },
    OVERLAP_TEST_TIMEOUT_MS
  );

  it('a batch with one valid and one hostile event stores both, the hostile one sanitized', async () => {
    await insertRule(rule({ matchOn: 'book_id' }));
    await engine.handleEvents([
      event(
        'purch\u0000ase',
        at(0),
        { 'book\u0000_id': 'a\u0000b' },
        { profileId: 'u\uD800' }
      ),
      event('page_view', at(1), { note: 'fine 😀' }),
    ]);

    const rows = await sql.$queryRawUnsafe<
      { name: string; profile_id: string; properties: unknown }[]
    >(
      'SELECT name, profile_id, properties FROM marketing.events ORDER BY event_time'
    );
    expect(rows).toEqual([
      { name: 'purchase', profile_id: 'u�', properties: { book_id: 'ab' } },
      {
        name: 'page_view',
        profile_id: PROFILE,
        properties: { note: 'fine 😀' },
      },
    ]);
    expect((await onlyEnrollment()).match_value).toBe('ab');
  });

  it('a stored rule with an out-of-range delay is skipped without failing other projects in the batch', async () => {
    // Skipped (not enrolled): the stored definition fails zRuleDefinition, so the engine ignores the rule.
    await insertRule(
      rule({
        steps: [
          {
            delaySeconds: 3_000_000_000,
            channel: 'email',
            template: { body: 'x' },
          },
        ],
      })
    );
    await insertRule(rule(), PROJECT_B);
    await engine.handleEvents([
      event('purchase', at(0)),
      event('purchase', at(0), {}, { projectId: PROJECT_B }),
    ]);

    expect(await count('events')).toBe(2);
    expect((await enrollments()).map((r) => r.project_id)).toEqual([PROJECT_B]);
  });

  it('purgeOldEvents deletes events older than retention and keeps newer ones', async () => {
    await engine.handleEvents([
      event('page_view', new Date(secondsAfter(NOW, -31 * DAY))),
      event('page_view', new Date(secondsAfter(NOW, -29 * DAY))),
      event('page_view', at(0)),
    ]);
    expect(await engine.purgeOldEvents(30)).toBe(1);
    expect(await count('events')).toBe(2);
  });

  it('purgeOldEvents keeps an old event an active enrollment may still need and deletes one no enrollment needs', async () => {
    await insertRule(rule());
    const old = new Date(secondsAfter(NOW, -40 * DAY));
    await engine.handleEvents([
      event('purchase', old),
      event('page_view', new Date(secondsAfter(NOW, -31 * DAY))),
      event('page_view', old, {}, { profileId: 'no-enrollment' }),
    ]);
    expect((await onlyEnrollment()).status).toBe('active');
    expect(await engine.purgeOldEvents(30)).toBe(1);
    const left = await sql.$queryRawUnsafe<{ profile_id: string }[]>(
      'SELECT profile_id FROM marketing.events'
    );
    expect(left.map((row) => row.profile_id)).toEqual([PROFILE, PROFILE]);
  });

  it('purgeOldEvents clears several chunks of old rows in one run', async () => {
    const old = new Date(secondsAfter(NOW, -31 * DAY));
    await engine.handleEvents(
      Array.from({ length: 7 }, () => event('page_view', old))
    );
    expect(await engine.purgeOldEvents(30, { chunkSize: 2, pauseMs: 0 })).toBe(
      7
    );
    expect(await count('events')).toBe(0);
  });

  it('purgeOldEvents stops when its time budget is spent and the next run continues', async () => {
    const old = new Date(secondsAfter(NOW, -31 * DAY));
    await engine.handleEvents(
      Array.from({ length: 5 }, () => event('page_view', old))
    );
    let ticks = 0;
    // Every clock read moves a minute on, so the budget runs out after two chunks.
    const slowClock = createEngine({
      sql,
      now: () => new Date(NOW.getTime() + ticks++ * MINUTE_MS),
    });
    const options = { chunkSize: 1, pauseMs: 0, budgetMs: 2 * MINUTE_MS };
    expect(await slowClock.purgeOldEvents(30, options)).toBe(2);
    expect(await count('events')).toBe(3);
    expect(await engine.purgeOldEvents(30, { chunkSize: 1, pauseMs: 0 })).toBe(
      3
    );
  });

  it('PERF a purge chunk checks enrollments through an index and old events have an event_time index', async () => {
    const ruleId = await insertRule(rule());
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
       SELECT gen_random_uuid(), $1, $2::uuid, '{}'::jsonb, 'p' || g,
         CASE WHEN g % 2 = 0 THEN 'active' ELSE 'completed' END, now()
       FROM generate_series(1, 5000) g`,
      PROJECT_A,
      ruleId
    );
    await sql.$executeRawUnsafe(
      'ANALYZE marketing.enrollments, marketing.events'
    );
    const plan = await sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN ${PURGE_CHUNK_SQL}`,
        NOW.toISOString(),
        1
      );
      return rows.map((row) => Object.values(row).join(' ')).join('\n');
    });
    expect(plan).toContain('enrollments_reentry_idx');
    // On test-sized tables the planner may prefer another index; the purge needs this one at scale.
    const indexes = await sql.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'marketing' AND indexname = 'events_event_time_idx'`
    );
    expect(indexes.map((row) => row.indexdef)).toEqual([
      'CREATE INDEX events_event_time_idx ON marketing.events USING btree (event_time)',
    ]);
  });

  it("SECURITY cross-project isolation: an event for project B never enrolls, completes or debounces project A's enrollment even with the same profile id and event names", async () => {
    await insertRule(rule({ matchOn: 'book_id' }));
    await insertRule(
      rule({
        trigger: { event: 'app_opened' },
        goal: { kind: 'inactivity', excludeEvents: [] },
      })
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.reference_sets (project_id, set_key, values) VALUES ($1, 'k', '["s1"]'::jsonb)`,
      PROJECT_B
    );
    const inB = { projectId: PROJECT_B };
    await engine.handleEvent(event('opened', at(5), { book_id: BOOK_A }, inB));
    await engine.handleEvent(event('purchase', at(0), { book_id: BOOK_A }));
    await engine.handleEvent(event('app_opened', at(0)));
    await engine.handleEvent(
      event('purchase', at(1), { book_id: BOOK_B }, inB)
    );
    await engine.handleEvent(event('app_opened', at(1), {}, inB));
    await engine.handleEvent(event('opened', at(6), { book_id: BOOK_A }, inB));
    await engine.handleEvent(event('page_view', at(30), {}, inB));

    const rows = await enrollments();
    expect(rows.map((r) => [r.project_id, r.status])).toEqual([
      [PROJECT_A, 'active'],
      [PROJECT_A, 'active'],
    ]);
    const dueTimes = (await steps()).map((s) => s.due_at.getTime()).sort();
    expect(dueTimes).toEqual(
      [HOUR, DAY, HOUR, DAY].map((delay) => secondsAfter(at(0), delay)).sort()
    );
    for (const row of rows) {
      expect((await engine.evaluateEnrollment(row.id)).met).toBe(false);
    }
    expect(await engine.interestNames(PROJECT_B)).toEqual(new Set());
  });

  it('handleEvents(batch) writes N events in one transaction and a failing event rolls the whole batch back', async () => {
    await insertRule(rule());
    await engine.handleEvents([
      event('opened', at(5)),
      event('purchase', at(0)),
      event('page_view', at(1)),
    ]);
    expect(await count('events')).toBe(3);
    expect((await onlyEnrollment()).status).toBe('completed');

    await resetMarketingTables();
    await insertRule(rule());
    let enrollInserts = 0;
    const failOnSecondEnrollment = (tx: object) =>
      new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== '$queryRawUnsafe' || typeof value !== 'function') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (query: string, ...args: unknown[]) => {
            if (
              query.includes('INSERT INTO marketing.enrollments') &&
              ++enrollInserts === 2
            ) {
              throw new Error('injected failure');
            }
            return value.call(target, query, ...args);
          };
        },
      });
    const failingSql = new Proxy(sql, {
      get(target, prop) {
        if (prop !== '$transaction') {
          return Reflect.get(target, prop);
        }
        return (fn: (tx: object) => Promise<unknown>, options: unknown) =>
          target.$transaction(
            (tx) => fn(failOnSecondEnrollment(tx)),
            options as never
          );
      },
    });
    const failingEngine = createEngine({ sql: failingSql, now: () => clock });
    await expect(
      failingEngine.handleEvents([
        event('purchase', at(0), {}, { profileId: 'u1' }),
        event('purchase', at(1), {}, { profileId: 'u2' }),
      ])
    ).rejects.toThrow('injected failure');
    expect(enrollInserts).toBe(2);
    expect(await count('events')).toBe(0);
    expect(await count('enrollments')).toBe(0);
    expect(await count('steps')).toBe(0);
  });

  it('two concurrent handleEvents racing on the same enrollment key create one active enrollment', async () => {
    await insertRule(rule({ reentry: { enabled: true, cooldownSeconds: 0 } }));
    await Promise.all([
      engine.handleEvents([event('purchase', at(0))]),
      engine.handleEvents([event('purchase', at(1))]),
      engine.handleEvents([event('purchase', at(2))]),
    ]);
    expect(await count('events')).toBe(3);
    expect(await count('enrollments')).toBe(1);
    expect(await count('steps')).toBe(2);
  });

  it('interestNames returns trigger and goal event names of active rules, per project', async () => {
    await insertRule(
      rule({
        trigger: { event: 'signup' },
        goal: { kind: 'event', event: 'purchase' },
      })
    );
    await insertRule(
      rule({
        trigger: { event: 'content_opened' },
        goal: {
          kind: 'set',
          event: 'section_opened',
          property: 'section_id',
          setKey: 'k',
        },
      }),
      PROJECT_B
    );
    await insertRule(
      rule({ trigger: { event: 'paused_trigger' } }),
      PROJECT_A,
      'paused'
    );
    await insertRule(
      rule({
        trigger: { event: 'app_opened' },
        goal: { kind: 'inactivity', excludeEvents: [] },
      })
    );

    expect(await engine.interestNames(PROJECT_A)).toEqual(
      new Set(['signup', 'purchase', 'app_opened'])
    );
    expect(await engine.interestNames()).toEqual(
      new Set([
        'signup',
        'purchase',
        'app_opened',
        'content_opened',
        'section_opened',
      ])
    );
  });

  it('interestNames keeps the goal event of an enrollment whose rule was since edited', async () => {
    const ruleId = await insertRule(rule());
    await engine.handleEvent(event('purchase', at(0)));
    await sql.$executeRawUnsafe(
      'UPDATE marketing.rules SET definition = $2::jsonb, version = version + 1 WHERE id = $1::uuid',
      ruleId,
      JSON.stringify(rule({ goal: { kind: 'event', event: 'renamed_goal' } }))
    );
    expect(await engine.interestNames(PROJECT_A)).toEqual(
      new Set(['purchase', 'opened', 'renamed_goal'])
    );
  });

  it('PERF goal facts query uses the events lookup index', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.events (project_id, event_id, profile_id, name, properties, event_time)
       SELECT $1, 'e' || g, 'u' || (g % 500), 'section_opened', '{"section_id":"s1"}'::jsonb, now() - (g || ' seconds')::interval
       FROM generate_series(1, 20000) g`,
      PROJECT_A
    );
    await sql.$executeRawUnsafe('ANALYZE marketing.events');
    const plan = await sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN ${GOAL_FACTS_SQL}`,
        PROJECT_A,
        'u7',
        'section_opened',
        NOW.toISOString(),
        'book_id',
        BOOK_A,
        'section_id'
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('events_lookup_idx');
  });
});
