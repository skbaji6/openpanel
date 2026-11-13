import type { sql as marketingSql } from '../db/client';
import type { NormalizedEvent } from '../events/normalize';
import { sanitizeText } from '../events/sanitize';
import {
  type Goal,
  type RuleDefinition,
  zRuleDefinition,
} from '../rules/rule.schema';

// Prisma's interactive transactions default to 5 s; a consumer batch can need longer.
const BATCH_TRANSACTION_TIMEOUT_MS = 60_000;
// The default 2 s wait for a pooled connection is too short while the ticker holds the pool.
const BATCH_TRANSACTION_MAX_WAIT_MS = 30_000;
const MS_PER_DAY = 86_400_000;
// Events can be forged; a far-future time would push inactivity timers out indefinitely.
export const MAX_FUTURE_SKEW_MS = MS_PER_DAY;
// The purge works in short chunks so it never holds a long lock or a long transaction, and stops
// after a time budget so one run cannot occupy the database; the next hourly run continues.
const PURGE_DEFAULTS = { chunkSize: 10_000, pauseMs: 100, budgetMs: 600_000 };

export type Sql = typeof marketingSql;
export type Queryable = Pick<Sql, '$queryRawUnsafe' | '$executeRawUnsafe'>;

export interface GoalResult {
  met: boolean;
  missing: string[];
}

export interface GoalFacts {
  goalEventSeen: boolean;
  seenValues: string[];
  referenceSet: string[];
}

interface RuleRow {
  id: string;
  definition: RuleDefinition;
}

interface EnrollmentRow {
  project_id: string;
  profile_id: string;
  match_value: string;
  trigger_time: Date;
  rule_snapshot: RuleSnapshot;
}

// Reference values are frozen at enrollment so registry edits only affect new enrollments.
export type RuleSnapshot = RuleDefinition & { referenceValues?: string[] };

function propertyAsString(
  properties: NormalizedEvent['properties'],
  key: string
): string | null {
  const value = Object.hasOwn(properties, key) ? properties[key] : null;
  return value === null || value === undefined ? null : String(value);
}

export function matchesTrigger(
  definition: RuleDefinition,
  event: Pick<NormalizedEvent, 'name' | 'properties'>
): boolean {
  if (event.name !== definition.trigger.event) {
    return false;
  }
  const filtersMatch = (definition.trigger.filters ?? []).every(
    (filter) =>
      propertyAsString(event.properties, filter.property) === filter.equals
  );
  const hasMatchValue =
    !definition.matchOn ||
    propertyAsString(event.properties, definition.matchOn) !== null;
  return filtersMatch && hasMatchValue;
}

export function evaluateGoal(goal: Goal, facts: GoalFacts): GoalResult {
  if (goal.kind === 'event') {
    return { met: facts.goalEventSeen, missing: [] };
  }
  if (goal.kind === 'inactivity' || facts.referenceSet.length === 0) {
    return { met: false, missing: [] };
  }
  const seen = new Set(facts.seenValues);
  const missing = facts.referenceSet.filter((value) => !seen.has(value));
  return { met: missing.length === 0, missing };
}

// Params: project, profile, goal event, trigger time, matchOn (or null), match value, set property (or null).
export const GOAL_FACTS_SQL = `
  SELECT DISTINCT properties->>($7::text) AS value FROM marketing.events
  WHERE project_id = $1 AND profile_id = $2 AND name = $3
    AND event_time >= $4::timestamptz
    AND ($5::text IS NULL OR properties->>($5::text) = $6::text)`;

const INSERT_EVENTS_SQL = `
  INSERT INTO marketing.events (project_id, event_id, profile_id, name, properties, event_time)
  SELECT project_id, event_id, profile_id, name, properties, event_time
  FROM jsonb_to_recordset($1::jsonb) AS e(
    project_id text, event_id text, profile_id text, name text, properties jsonb, event_time timestamptz)
  ON CONFLICT (project_id, event_id) DO NOTHING
  RETURNING project_id, event_id`;

// Params: project, rule id, snapshot, profile, match value, trigger time, now, reentry enabled, cooldown seconds.
export const ENROLL_SQL = `
  WITH enrollment AS (
    INSERT INTO marketing.enrollments
      (id, project_id, rule_id, rule_snapshot, profile_id, match_value, status, trigger_time, created_at)
    SELECT gen_random_uuid(), $1, $2::uuid, $3::jsonb, $4, $5, 'active', $6::timestamptz, $7::timestamptz
    WHERE NOT EXISTS (
      SELECT 1 FROM marketing.enrollments
      WHERE project_id = $1 AND profile_id = $4 AND rule_id = $2::uuid AND match_value = $5
        AND (status = 'active'
             OR (status = 'completed' AND (NOT $8::boolean
                 OR created_at > $7::timestamptz - make_interval(secs => $9::double precision)))))
    ON CONFLICT (project_id, rule_id, profile_id, match_value) WHERE status = 'active' DO NOTHING
    RETURNING id, trigger_time
  ), new_steps AS (
    INSERT INTO marketing.steps (enrollment_id, step_index, due_at, scheduled_at, status)
    SELECT enrollment.id, (step.ordinality - 1)::int, scheduled.at, scheduled.at, 'pending'
    FROM enrollment, jsonb_array_elements($3::jsonb->'steps') WITH ORDINALITY AS step,
      LATERAL (SELECT enrollment.trigger_time
                 + make_interval(secs => (step.value->>'delaySeconds')::double precision) AS at) scheduled
  )
  SELECT id::text FROM enrollment`;

const COMPLETE_SQL = `
  WITH done AS (
    UPDATE marketing.enrollments SET status = 'completed', end_reason = 'goal'
    WHERE id = $1::uuid AND status = 'active' RETURNING id
  )
  UPDATE marketing.steps SET status = 'cancelled'
  WHERE enrollment_id IN (SELECT id FROM done) AND status = 'pending'`;

// Params: project, profile, event name, event time.
const GOAL_CANDIDATES_SQL = `
  SELECT id::text FROM marketing.enrollments
  WHERE project_id = $1 AND profile_id = $2 AND status = 'active'
    AND trigger_time <= $4::timestamptz AND rule_snapshot->'goal'->>'event' = $3`;

const STEP_DELAY = `make_interval(secs => (e.rule_snapshot->'steps'->s.step_index->>'delaySeconds')::double precision)`;
const NOT_EXCLUDED = `NOT (COALESCE(e.rule_snapshot->'goal'->'excludeEvents', '[]'::jsonb) ?`;

// GREATEST keeps the debounce order-independent: an older event never pulls due_at back.
// A debounce moves the schedule itself, so scheduled_at (what expiry measures from) moves with it.
const DEBOUNCE_SQL = `
  UPDATE marketing.steps s SET due_at = GREATEST(s.due_at, $4::timestamptz + ${STEP_DELAY}),
    scheduled_at = GREATEST(COALESCE(s.scheduled_at, s.due_at), $4::timestamptz + ${STEP_DELAY})
  FROM marketing.enrollments e
  WHERE s.enrollment_id = e.id AND s.status = 'pending'
    AND e.project_id = $1 AND e.profile_id = $2 AND e.status = 'active'
    AND e.rule_snapshot->'goal'->>'kind' = 'inactivity'
    AND ${NOT_EXCLUDED} $3::text)
    AND e.trigger_time <= $4::timestamptz`;

// Activity stored before the trigger arrived but later in event time counts too.
const DEBOUNCE_FROM_STORED_SQL = `
  UPDATE marketing.steps s SET due_at = GREATEST(s.due_at, activity.last + ${STEP_DELAY}),
    scheduled_at = GREATEST(COALESCE(s.scheduled_at, s.due_at), activity.last + ${STEP_DELAY})
  FROM marketing.enrollments e
  CROSS JOIN LATERAL (
    SELECT max(ev.event_time) AS last FROM marketing.events ev
    WHERE ev.project_id = e.project_id AND ev.profile_id = e.profile_id
      AND ev.event_time >= e.trigger_time AND ${NOT_EXCLUDED} ev.name)
  ) activity
  WHERE e.id = $1::uuid AND s.enrollment_id = e.id AND s.status = 'pending'
    AND activity.last IS NOT NULL`;

const INTEREST_NAMES_SQL = `
  SELECT DISTINCT name FROM (
    SELECT definition->'trigger'->>'event' AS name FROM marketing.rules
    WHERE status = 'active' AND ($1::text IS NULL OR project_id = $1::text)
    UNION
    SELECT definition->'goal'->>'event' FROM marketing.rules
    WHERE status = 'active' AND ($1::text IS NULL OR project_id = $1::text)
    UNION
    SELECT rule_snapshot->'goal'->>'event' FROM marketing.enrollments
    WHERE status = 'active' AND ($1::text IS NULL OR project_id = $1::text)
  ) names WHERE name IS NOT NULL`;

// Every engine write (enroll, complete, debounce) is scoped to one (project, profile).
// Locking those keys first gives each statement a snapshot that sees committed enrollments,
// and taking them in hash order keeps overlapping batches from deadlocking each other.
const LOCK_PROFILES_SQL = `
  SELECT count(pg_advisory_xact_lock(key_hash))::int AS locked FROM (
    SELECT DISTINCT hashtextextended(profile_key, 0) AS key_hash
    FROM jsonb_array_elements_text($1::jsonb) AS profile_key
    ORDER BY key_hash
  ) ordered_keys`;

const RULES_LOCK_KEY = 'marketing:rules';

// Params: cutoff, chunk size. An event at or after an active enrollment's trigger can still decide
// its goal or debounce, so it outlives the retention window until that enrollment ends.
export const PURGE_CHUNK_SQL = `
  DELETE FROM marketing.events WHERE ctid IN (
    SELECT ev.ctid FROM marketing.events ev
    WHERE ev.event_time < $1::timestamptz
      AND NOT EXISTS (SELECT 1 FROM marketing.enrollments e
        WHERE e.project_id = ev.project_id AND e.profile_id = ev.profile_id
          AND e.status = 'active' AND e.trigger_time <= ev.event_time)
    LIMIT $2::int)`;

export type PurgeOptions = typeof PURGE_DEFAULTS;

// Params of chunkSql: cutoff, chunk size. Returns the rows deleted before the work ran out or the budget did.
export async function deleteInChunks(
  db: Queryable,
  chunkSql: string,
  cutoff: Date,
  options: Partial<PurgeOptions> = {},
  now: () => Date = () => new Date()
): Promise<number> {
  const { chunkSize, pauseMs, budgetMs } = { ...PURGE_DEFAULTS, ...options };
  const started = now().getTime();
  let total = 0;
  for (;;) {
    const deleted = await db.$executeRawUnsafe(
      chunkSql,
      cutoff.toISOString(),
      chunkSize
    );
    total += deleted;
    const done = deleted < chunkSize;
    const outOfBudget = now().getTime() - started >= budgetMs;
    if (done || outOfBudget) {
      return total;
    }
    await Bun.sleep(pauseMs);
  }
}

// Batches hold it shared while they read rules and enroll; stopping a rule takes it exclusively first,
// so no batch that saw the rule active commits after the stop. Always taken before profile locks.
export async function lockRules(
  db: Queryable,
  mode: 'shared' | 'exclusive'
): Promise<void> {
  const lockFunction =
    mode === 'shared'
      ? 'pg_advisory_xact_lock_shared'
      : 'pg_advisory_xact_lock';
  await db.$executeRawUnsafe(
    `SELECT ${lockFunction}(hashtextextended($1, 0))`,
    RULES_LOCK_KEY
  );
}

// The ticker takes the same lock before changing steps or enrollments, so the two never deadlock.
export async function lockProfiles(
  db: Queryable,
  keys: { projectId: string; profileId: string }[]
): Promise<void> {
  const profileKeys = keys.map((key) =>
    JSON.stringify([key.projectId, key.profileId])
  );
  await db.$queryRawUnsafe(LOCK_PROFILES_SQL, JSON.stringify(profileKeys));
}

function sanitizeEvent(event: NormalizedEvent): NormalizedEvent {
  const properties: NormalizedEvent['properties'] = {};
  for (const [key, value] of Object.entries(event.properties)) {
    properties[sanitizeText(key)] =
      typeof value === 'string' ? sanitizeText(value) : value;
  }
  return {
    ...event,
    eventId: sanitizeText(event.eventId),
    projectId: sanitizeText(event.projectId),
    profileId: sanitizeText(event.profileId),
    name: sanitizeText(event.name),
    properties,
  };
}

// A stored rule that no longer passes the schema (e.g. written around the API) is skipped, not fatal for the batch.
async function loadActiveRules(
  db: Queryable,
  projectId: string
): Promise<RuleRow[]> {
  const rows = await db.$queryRawUnsafe<{ id: string; definition: unknown }[]>(
    `SELECT id::text, definition FROM marketing.rules
     WHERE project_id = $1 AND status = 'active'`,
    projectId
  );
  return rows.flatMap((row) => {
    const parsed = zRuleDefinition.safeParse(row.definition);
    return parsed.success ? [{ id: row.id, definition: parsed.data }] : [];
  });
}

function eventKey(projectId: string, eventId: string): string {
  return JSON.stringify([projectId, eventId]);
}

async function insertEvents(
  db: Queryable,
  events: NormalizedEvent[]
): Promise<Set<string>> {
  const rows = events.map((event) => ({
    project_id: event.projectId,
    event_id: event.eventId,
    profile_id: event.profileId,
    name: event.name,
    properties: event.properties,
    event_time: event.time.toISOString(),
  }));
  const inserted = await db.$queryRawUnsafe<
    { project_id: string; event_id: string }[]
  >(INSERT_EVENTS_SQL, JSON.stringify(rows));
  return new Set(inserted.map((row) => eventKey(row.project_id, row.event_id)));
}

// With matchOn, the registry is keyed by the match value (one set per book); otherwise by setKey.
export function referenceSetKey(
  definition: RuleDefinition,
  goal: Extract<Goal, { kind: 'set' }>,
  matchValue: string
): string {
  return definition.matchOn ? matchValue : goal.setKey;
}

async function loadReferenceSet(
  db: Queryable,
  projectId: string,
  setKey: string
): Promise<string[]> {
  const [row] = await db.$queryRawUnsafe<{ values: unknown }[]>(
    'SELECT values FROM marketing.reference_sets WHERE project_id = $1 AND set_key = $2',
    projectId,
    setKey
  );
  const values = Array.isArray(row?.values) ? row.values : [];
  return [...new Set(values.map(String))];
}

async function evaluate(
  db: Queryable,
  enrollmentId: string
): Promise<GoalResult> {
  const [enrollment] = await db.$queryRawUnsafe<EnrollmentRow[]>(
    `SELECT project_id, profile_id, match_value, trigger_time, rule_snapshot
     FROM marketing.enrollments WHERE id = $1::uuid`,
    enrollmentId
  );
  if (!enrollment) {
    throw new Error(`enrollment ${enrollmentId} not found`);
  }
  const { goal, matchOn } = enrollment.rule_snapshot;
  if (goal.kind === 'inactivity') {
    return evaluateGoal(goal, {
      goalEventSeen: false,
      seenValues: [],
      referenceSet: [],
    });
  }
  const setProperty = goal.kind === 'set' ? goal.property : null;
  const rows = await db.$queryRawUnsafe<{ value: string | null }[]>(
    GOAL_FACTS_SQL,
    enrollment.project_id,
    enrollment.profile_id,
    goal.event,
    enrollment.trigger_time.toISOString(),
    matchOn ?? null,
    enrollment.match_value,
    setProperty
  );
  return evaluateGoal(goal, {
    goalEventSeen: rows.length > 0,
    seenValues: rows.flatMap((row) => (row.value === null ? [] : [row.value])),
    referenceSet: enrollment.rule_snapshot.referenceValues ?? [],
  });
}

async function completeIfMet(db: Queryable, enrollmentId: string) {
  const { met } = await evaluate(db, enrollmentId);
  if (met) {
    await db.$executeRawUnsafe(COMPLETE_SQL, enrollmentId);
  }
}

export function createEngine(deps: { sql: Sql; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  async function enroll(
    db: Queryable,
    rule: RuleRow,
    event: NormalizedEvent
  ): Promise<string | undefined> {
    const { definition } = rule;
    const matchValue = definition.matchOn
      ? (propertyAsString(event.properties, definition.matchOn) ?? '')
      : '';
    const { goal } = definition;
    const snapshot: RuleSnapshot =
      goal.kind === 'set'
        ? {
            ...definition,
            referenceValues: await loadReferenceSet(
              db,
              event.projectId,
              referenceSetKey(definition, goal, matchValue)
            ),
          }
        : definition;
    const [row] = await db.$queryRawUnsafe<{ id: string }[]>(
      ENROLL_SQL,
      event.projectId,
      rule.id,
      JSON.stringify(snapshot),
      event.profileId,
      matchValue,
      event.time.toISOString(),
      now().toISOString(),
      definition.reentry.enabled,
      definition.reentry.cooldownSeconds
    );
    return row?.id;
  }

  async function processEvent(
    db: Queryable,
    event: NormalizedEvent,
    rules: RuleRow[]
  ) {
    for (const rule of rules) {
      if (!matchesTrigger(rule.definition, event)) {
        continue;
      }
      const enrollmentId = await enroll(db, rule, event);
      if (!enrollmentId) {
        continue;
      }
      if (rule.definition.goal.kind === 'inactivity') {
        await db.$executeRawUnsafe(DEBOUNCE_FROM_STORED_SQL, enrollmentId);
      } else {
        await completeIfMet(db, enrollmentId);
      }
    }
    const time = event.time.toISOString();
    const candidates = await db.$queryRawUnsafe<{ id: string }[]>(
      GOAL_CANDIDATES_SQL,
      event.projectId,
      event.profileId,
      event.name,
      time
    );
    for (const candidate of candidates) {
      await completeIfMet(db, candidate.id);
    }
    await db.$executeRawUnsafe(
      DEBOUNCE_SQL,
      event.projectId,
      event.profileId,
      event.name,
      time
    );
  }

  async function handleEvents(events: NormalizedEvent[]): Promise<void> {
    const latestAllowed = now().getTime() + MAX_FUTURE_SKEW_MS;
    const ordered = events
      .filter((event) => event.time.getTime() <= latestAllowed)
      .map(sanitizeEvent)
      .sort((a, b) => a.time.getTime() - b.time.getTime());
    if (ordered.length === 0) {
      return;
    }
    await deps.sql.$transaction(
      async (tx) => {
        await lockRules(tx, 'shared');
        await lockProfiles(tx, ordered);
        const fresh = await insertEvents(tx, ordered);
        const rulesByProject = new Map<string, RuleRow[]>();
        for (const event of ordered) {
          // delete() also skips a second copy of the same event within the batch
          if (!fresh.delete(eventKey(event.projectId, event.eventId))) {
            continue;
          }
          let rules = rulesByProject.get(event.projectId);
          if (!rules) {
            rules = await loadActiveRules(tx, event.projectId);
            rulesByProject.set(event.projectId, rules);
          }
          await processEvent(tx, event, rules);
        }
      },
      {
        timeout: BATCH_TRANSACTION_TIMEOUT_MS,
        maxWait: BATCH_TRANSACTION_MAX_WAIT_MS,
      }
    );
  }

  return {
    handleEvents,
    handleEvent: (event: NormalizedEvent) => handleEvents([event]),
    evaluateEnrollment: (enrollmentId: string) =>
      evaluate(deps.sql, enrollmentId),
    purgeOldEvents(
      retentionDays: number,
      options: Partial<PurgeOptions> = {}
    ): Promise<number> {
      const cutoff = new Date(now().getTime() - retentionDays * MS_PER_DAY);
      return deleteInChunks(deps.sql, PURGE_CHUNK_SQL, cutoff, options, now);
    },
    async interestNames(projectId?: string): Promise<Set<string>> {
      const rows = await deps.sql.$queryRawUnsafe<{ name: string }[]>(
        INTEREST_NAMES_SQL,
        projectId ?? null
      );
      return new Set(rows.map((row) => row.name));
    },
  };
}
