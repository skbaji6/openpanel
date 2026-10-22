import type { sql as nudgeSql } from '../db/client';
import type { NormalizedEvent } from '../events/normalize';
import type { Goal, RuleDefinition } from '../rules/rule.schema';

// Prisma's interactive transactions default to 5 s; a consumer batch can need longer.
const BATCH_TRANSACTION_TIMEOUT_MS = 60_000;
const MS_PER_DAY = 86_400_000;
// Events can be forged; a far-future time would push inactivity timers out indefinitely.
export const MAX_FUTURE_SKEW_MS = MS_PER_DAY;

type Sql = typeof nudgeSql;
type Queryable = Pick<Sql, '$queryRawUnsafe' | '$executeRawUnsafe'>;

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
  SELECT DISTINCT properties->>($7::text) AS value FROM nudge.events
  WHERE project_id = $1 AND profile_id = $2 AND name = $3
    AND event_time >= $4::timestamptz
    AND ($5::text IS NULL OR properties->>($5::text) = $6::text)`;

const INSERT_EVENTS_SQL = `
  INSERT INTO nudge.events (project_id, event_id, profile_id, name, properties, event_time)
  SELECT project_id, event_id, profile_id, name, properties, event_time
  FROM jsonb_to_recordset($1::jsonb) AS e(
    project_id text, event_id text, profile_id text, name text, properties jsonb, event_time timestamptz)
  ON CONFLICT (project_id, event_id) DO NOTHING
  RETURNING project_id, event_id`;

// Params: project, rule id, snapshot, profile, match value, trigger time, now, reentry enabled, cooldown seconds.
export const ENROLL_SQL = `
  WITH enrollment AS (
    INSERT INTO nudge.enrollments
      (id, project_id, rule_id, rule_snapshot, profile_id, match_value, status, trigger_time, created_at)
    SELECT gen_random_uuid(), $1, $2::uuid, $3::jsonb, $4, $5, 'active', $6::timestamptz, $7::timestamptz
    WHERE NOT EXISTS (
      SELECT 1 FROM nudge.enrollments
      WHERE project_id = $1 AND profile_id = $4 AND rule_id = $2::uuid AND match_value = $5
        AND (status = 'active'
             OR (status = 'completed' AND (NOT $8::boolean
                 OR created_at > $7::timestamptz - make_interval(secs => $9::int)))))
    ON CONFLICT (project_id, rule_id, profile_id, match_value) WHERE status = 'active' DO NOTHING
    RETURNING id, trigger_time
  ), new_steps AS (
    INSERT INTO nudge.steps (enrollment_id, step_index, due_at, status)
    SELECT enrollment.id, (step.ordinality - 1)::int,
           enrollment.trigger_time + make_interval(secs => (step.value->>'delaySeconds')::int), 'pending'
    FROM enrollment, jsonb_array_elements($3::jsonb->'steps') WITH ORDINALITY AS step
  )
  SELECT id::text FROM enrollment`;

const COMPLETE_SQL = `
  WITH done AS (
    UPDATE nudge.enrollments SET status = 'completed'
    WHERE id = $1::uuid AND status = 'active' RETURNING id
  )
  UPDATE nudge.steps SET status = 'cancelled'
  WHERE enrollment_id IN (SELECT id FROM done) AND status = 'pending'`;

// Params: project, profile, event name, event time.
const GOAL_CANDIDATES_SQL = `
  SELECT id::text FROM nudge.enrollments
  WHERE project_id = $1 AND profile_id = $2 AND status = 'active'
    AND trigger_time <= $4::timestamptz AND rule_snapshot->'goal'->>'event' = $3`;

const STEP_DELAY = `make_interval(secs => (e.rule_snapshot->'steps'->s.step_index->>'delaySeconds')::int)`;
const NOT_EXCLUDED = `NOT (COALESCE(e.rule_snapshot->'goal'->'excludeEvents', '[]'::jsonb) ?`;

// GREATEST keeps the debounce order-independent: an older event never pulls due_at back.
const DEBOUNCE_SQL = `
  UPDATE nudge.steps s SET due_at = GREATEST(s.due_at, $4::timestamptz + ${STEP_DELAY})
  FROM nudge.enrollments e
  WHERE s.enrollment_id = e.id AND s.status = 'pending'
    AND e.project_id = $1 AND e.profile_id = $2 AND e.status = 'active'
    AND e.rule_snapshot->'goal'->>'kind' = 'inactivity'
    AND ${NOT_EXCLUDED} $3::text)
    AND e.trigger_time <= $4::timestamptz`;

// Activity stored before the trigger arrived but later in event time counts too.
const DEBOUNCE_FROM_STORED_SQL = `
  UPDATE nudge.steps s SET due_at = GREATEST(s.due_at, activity.last + ${STEP_DELAY})
  FROM nudge.enrollments e
  CROSS JOIN LATERAL (
    SELECT max(ev.event_time) AS last FROM nudge.events ev
    WHERE ev.project_id = e.project_id AND ev.profile_id = e.profile_id
      AND ev.event_time >= e.trigger_time AND ${NOT_EXCLUDED} ev.name)
  ) activity
  WHERE e.id = $1::uuid AND s.enrollment_id = e.id AND s.status = 'pending'
    AND activity.last IS NOT NULL`;

const INTEREST_NAMES_SQL = `
  SELECT DISTINCT name FROM (
    SELECT definition->'trigger'->>'event' AS name FROM nudge.rules
    WHERE status = 'active' AND ($1::text IS NULL OR project_id = $1::text)
    UNION
    SELECT definition->'goal'->>'event' FROM nudge.rules
    WHERE status = 'active' AND ($1::text IS NULL OR project_id = $1::text)
    UNION
    SELECT rule_snapshot->'goal'->>'event' FROM nudge.enrollments
    WHERE status = 'active' AND ($1::text IS NULL OR project_id = $1::text)
  ) names WHERE name IS NOT NULL`;

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
    'SELECT values FROM nudge.reference_sets WHERE project_id = $1 AND set_key = $2',
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
     FROM nudge.enrollments WHERE id = $1::uuid`,
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
    const plausible = events.filter(
      (event) => event.time.getTime() <= latestAllowed
    );
    if (plausible.length === 0) {
      return;
    }
    const ordered = plausible.sort(
      (a, b) => a.time.getTime() - b.time.getTime()
    );
    await deps.sql.$transaction(
      async (tx) => {
        const fresh = await insertEvents(tx, ordered);
        const rulesByProject = new Map<string, RuleRow[]>();
        for (const event of ordered) {
          // delete() also skips a second copy of the same event within the batch
          if (!fresh.delete(eventKey(event.projectId, event.eventId))) {
            continue;
          }
          let rules = rulesByProject.get(event.projectId);
          if (!rules) {
            rules = await tx.$queryRawUnsafe<RuleRow[]>(
              `SELECT id::text, definition FROM nudge.rules
               WHERE project_id = $1 AND status = 'active'`,
              event.projectId
            );
            rulesByProject.set(event.projectId, rules);
          }
          await processEvent(tx, event, rules);
        }
      },
      { timeout: BATCH_TRANSACTION_TIMEOUT_MS }
    );
  }

  return {
    handleEvents,
    handleEvent: (event: NormalizedEvent) => handleEvents([event]),
    evaluateEnrollment: (enrollmentId: string) =>
      evaluate(deps.sql, enrollmentId),
    async purgeOldEvents(retentionDays: number): Promise<number> {
      const cutoff = new Date(now().getTime() - retentionDays * MS_PER_DAY);
      return await deps.sql.$executeRawUnsafe(
        'DELETE FROM nudge.events WHERE event_time < $1::timestamptz',
        cutoff.toISOString()
      );
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
