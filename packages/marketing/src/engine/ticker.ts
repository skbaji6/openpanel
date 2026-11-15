import { decryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import {
  type LookupChannel,
  type LookupEntry,
  MAX_LOOKUP_IDS,
} from '../audience/contract';
import {
  SourceAuthError,
  SourceBusyError,
  SourceUnavailableError,
} from '../audience/errors';
import type { AudienceSource } from '../audience/source';
import { getAdapter } from '../channels/registry';
import { LEASE_MARGIN_MS, SEND_TIMEOUT_MS } from '../channels/timeouts';
import type {
  ChannelAdapter,
  ChannelId,
  Recipient,
  RenderedMessage,
  SendResult,
} from '../channels/types';
import type { MarketingConfig } from '../config';
import { redactSecrets } from '../redact';
import type { Step } from '../rules/rule.schema';
import { renderTemplate } from '../template/render';
import { filterLiveTokens, recordDeadTokens } from './dead-tokens';
import {
  type createEngine,
  type GoalResult,
  lockProfiles,
  type Queryable,
  type RuleSnapshot,
  type Sql,
} from './engine';
import {
  capAllows,
  inQuietHours,
  lagAllowsSending,
  nextAllowedTime,
} from './gates';
import {
  capLockKey,
  countRecentSends,
  deleteLedger,
  type EffectiveCap,
  effectiveCap,
  ledgerRef,
  lockCap,
} from './ledger';
import { gatherLookupBatch } from './lookup-batch';

const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 60_000;
// Short, so journeys resume soon after the source recovers, yet a down source does not spin every tick.
const SOURCE_BACKOFF_MS = 30_000;
// A step that waited behind lookups is sent only if its lease still covers a full send and its mark.
const MIN_LEASE_LEFT_MS = SEND_TIMEOUT_MS + LEASE_MARGIN_MS;
// The reason comes from the owner's API, so only a short code is recorded.
const UNREACHABLE_REASON = /^[a-z0-9_.-]{1,64}$/;
const EXPIRED_REASON = 'expired';
const NO_LIVE_TOKEN_REASON = 'unreachable:no_live_token';
// Total mark budget is about 0.5 s; leaseSeconds must exceed the adapter's own send timeout
// (at most 30 s) plus this budget, or a slow send can be reclaimed and sent twice.
const MARK_RETRY_DELAYS_MS = [100, 400];
// A locked write may wait on the engine's profile lock, which a consumer batch holds for up to 60 s.
const LOCKED_TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
const LOG_PREFIX = 'marketing ticker:';
// Shorter config strings (flags, ports) would blank out unrelated words in the log.
const MIN_SECRET_LENGTH = 4;
// The sweep only heals completions whose best-effort write failed, so it need not run every tick.
export const HEAL_SWEEP_INTERVAL_MS = 60_000;
export const LAG_WARN_INTERVAL_MS = 60_000;

type Engine = ReturnType<typeof createEngine>;

export interface TickDeps {
  sql: Sql;
  engine: Engine;
  now: () => Date;
  cfg: MarketingConfig;
  renderUnsubscribeUrl: (
    projectId: string,
    profileId: string,
    channel: string
  ) => string;
  // Shared across ticks by the worker; without it every tick sweeps and warns.
  state?: TickState;
  logger?: Pick<Console, 'warn'>;
  // Without it every project uses its stored contact rows.
  sources?: { forProject(projectId: string): Promise<AudienceSource | null> };
}

const ALL_STORED: NonNullable<TickDeps['sources']> = {
  forProject: () => Promise.resolve(null),
};

export function createTickState() {
  return {
    lastSweepAt: Number.NEGATIVE_INFINITY,
    lastLagWarnAt: Number.NEGATIVE_INFINITY,
  };
}

export type TickState = ReturnType<typeof createTickState>;

export interface TickResult {
  sent: number;
  skipped: number;
  postponed: number;
  failed: number;
}

type Outcome = keyof TickResult | 'lost';

interface Claim {
  enrollment_id: string;
  step_index: number;
  attempt: number;
  is_last: boolean;
  project_id: string;
  profile_id: string;
  channel: ChannelId | null;
  lease_until: Date;
  scheduled_at: Date;
}

interface LookupItem {
  projectId: string;
  profileId: string;
  claim: Claim;
  source: AudienceSource;
}

interface StepContext {
  project_id: string;
  profile_id: string;
  rule_id: string;
  rule_snapshot: RuleSnapshot;
  email: string | null;
  attributes: unknown;
  opted_out: boolean;
  device_tokens: string[];
  caps: unknown;
  quiet_hours: unknown;
  config_encrypted: string | null;
  trigger_properties: unknown;
  // Set only for an http source whose lookup said the person must not be messaged.
  lookup_skip?: string | null;
}

export const zCaps = z
  .object({
    max: z.number().int().nonnegative(),
    periodSeconds: z.number().int().positive(),
    scope: z.enum(['channel', 'all']).optional(),
  })
  .nullable();
const zQuietHours = z
  .object({ start: z.string(), end: z.string(), timezone: z.string() })
  .nullable();

const ACTIVE = `EXISTS (SELECT 1 FROM marketing.enrollments ae JOIN marketing.rules ar ON ar.id = ae.rule_id
  WHERE ae.id = s.enrollment_id AND ae.status = 'active' AND ar.status = 'active')`;
// Steps go out in order: a step is claimable only once every earlier step of its enrollment is final.
const EARLIER_STEPS_FINAL = `NOT EXISTS (SELECT 1 FROM marketing.steps earlier
  WHERE earlier.enrollment_id = s.enrollment_id AND earlier.step_index < s.step_index
    AND earlier.status IN ('pending', 'sending'))`;

// A step's ledger row; built the same way as in the 0015 backfill.
const STEP_REF = `'step:' || s.enrollment_id::text || ':' || s.step_index`;
// Appended to a statement whose changed CTE returns the refs of steps that are no longer a send.
const DROP_LEDGER = `dropped AS (
    DELETE FROM marketing.send_ledger l USING changed WHERE l.source_ref = changed.ref RETURNING 1
  )`;

// Params: now. Expired leases of ended enrollments or inactive rules are cancelled, never resent.
// Set-based without the profile lock: it only touches 'sending' rows, which the engine never writes.
const CANCEL_ORPHANED_SQL = `
  WITH changed AS (
    UPDATE marketing.steps s SET status = 'cancelled', outcome = '{"reason":"inactive"}',
      lease_until = NULL, sent_at = NULL
    WHERE s.status = 'sending' AND s.lease_until < $1::timestamptz AND NOT ${ACTIVE}
    RETURNING ${STEP_REF} AS ref
  ), ${DROP_LEDGER}
  SELECT count(*)::int AS updated FROM changed`;

// Params: now, latest claimable due_at (now - grace), batch size, lease end.
// Both arms walk a partial index; the joins keep paused rules and ended enrollments out of the batch.
export const CLAIM_SQL = `
  WITH expired AS (
    SELECT s.enrollment_id, s.step_index FROM marketing.steps s
    JOIN marketing.enrollments e ON e.id = s.enrollment_id AND e.status = 'active'
    JOIN marketing.rules r ON r.id = e.rule_id AND r.status = 'active'
    WHERE s.status = 'sending' AND s.lease_until < $1::timestamptz
    ORDER BY s.lease_until LIMIT $3::int
    FOR UPDATE OF s SKIP LOCKED
  ), due AS (
    SELECT s.enrollment_id, s.step_index FROM marketing.steps s
    JOIN marketing.enrollments e ON e.id = s.enrollment_id AND e.status = 'active'
    JOIN marketing.rules r ON r.id = e.rule_id AND r.status = 'active'
    WHERE s.status = 'pending' AND s.due_at <= $2::timestamptz AND ${EARLIER_STEPS_FINAL}
    ORDER BY s.due_at LIMIT $3::int
    FOR UPDATE OF s SKIP LOCKED
  ), picked AS (
    SELECT DISTINCT ON (enrollment_id) enrollment_id, step_index
    FROM (SELECT * FROM expired UNION ALL SELECT * FROM due) candidates
    ORDER BY enrollment_id, step_index
  )
  UPDATE marketing.steps s
  SET status = 'sending', lease_until = $4::timestamptz, attempt = s.attempt + 1
  FROM (SELECT * FROM picked LIMIT $3::int) chosen
  JOIN marketing.enrollments ce ON ce.id = chosen.enrollment_id
  WHERE s.enrollment_id = chosen.enrollment_id AND s.step_index = chosen.step_index
  RETURNING s.enrollment_id::text, s.step_index, s.attempt,
    NOT EXISTS (SELECT 1 FROM marketing.steps later
                WHERE later.enrollment_id = s.enrollment_id AND later.step_index > s.step_index) AS is_last,
    ce.project_id, ce.profile_id, ce.rule_snapshot->'steps'->s.step_index->>'channel' AS channel,
    s.lease_until, COALESCE(s.scheduled_at, s.due_at) AS scheduled_at`;

// Params: enrollment id, step index.
const CONTEXT_SQL = `
  WITH en AS (
    SELECT e.*, e.rule_snapshot->'steps'->$2::int->>'channel' AS channel
    FROM marketing.enrollments e WHERE e.id = $1::uuid
  )
  SELECT en.project_id, en.profile_id, en.rule_id::text, en.rule_snapshot,
    c.email, c.attributes,
    EXISTS (SELECT 1 FROM marketing.opt_outs o
            WHERE o.project_id = en.project_id AND o.profile_id = en.profile_id
              AND o.channel = en.channel) AS opted_out,
    ARRAY (SELECT d.token FROM marketing.devices d
           WHERE d.project_id = en.project_id AND d.profile_id = en.profile_id
           ORDER BY d.token) AS device_tokens,
    ps.caps, ps.quiet_hours, cc.config_encrypted,
    (SELECT ev.properties FROM marketing.events ev
     WHERE ev.project_id = en.project_id AND ev.profile_id = en.profile_id
       AND ev.name = en.rule_snapshot->'trigger'->>'event'
       AND ev.event_time = en.trigger_time
       AND (en.rule_snapshot->>'matchOn' IS NULL
            OR ev.properties->>(en.rule_snapshot->>'matchOn') = en.match_value)
     ORDER BY ev.event_id LIMIT 1) AS trigger_properties
  FROM en
  LEFT JOIN marketing.contacts c ON c.project_id = en.project_id AND c.profile_id = en.profile_id
  LEFT JOIN marketing.project_settings ps ON ps.project_id = en.project_id
  LEFT JOIN marketing.channel_configs cc ON cc.project_id = en.project_id AND cc.channel = en.channel`;

// Params: enrollment id, step index. For an http source the contact fields come from the lookup;
// opted_out stays because the email unsubscribe link and the do-not-contact list hold for both sources.
const CONTEXT_NO_CONTACT_SQL = `
  WITH en AS (
    SELECT e.*, e.rule_snapshot->'steps'->$2::int->>'channel' AS channel
    FROM marketing.enrollments e WHERE e.id = $1::uuid
  )
  SELECT en.project_id, en.profile_id, en.rule_id::text, en.rule_snapshot,
    EXISTS (SELECT 1 FROM marketing.opt_outs o
            WHERE o.project_id = en.project_id AND o.profile_id = en.profile_id
              AND o.channel = en.channel) AS opted_out,
    ps.caps, ps.quiet_hours, cc.config_encrypted,
    (SELECT ev.properties FROM marketing.events ev
     WHERE ev.project_id = en.project_id AND ev.profile_id = en.profile_id
       AND ev.name = en.rule_snapshot->'trigger'->>'event'
       AND ev.event_time = en.trigger_time
       AND (en.rule_snapshot->>'matchOn' IS NULL
            OR ev.properties->>(en.rule_snapshot->>'matchOn') = en.match_value)
     ORDER BY ev.event_id LIMIT 1) AS trigger_properties
  FROM en
  LEFT JOIN marketing.project_settings ps ON ps.project_id = en.project_id
  LEFT JOIN marketing.channel_configs cc ON cc.project_id = en.project_id AND cc.channel = en.channel`;

// Params: project, status, now. Writes only on a change, so a healthy source costs no row update.
const SOURCE_STATUS_SQL = `
  UPDATE marketing.audience_sources SET status = $2, status_at = $3::timestamptz
  WHERE project_id = $1 AND status IS DISTINCT FROM $2`;

// Every write is fenced by status and attempt: a tick whose lease was reclaimed changes nothing.
const OWNED = `s.enrollment_id = $1::uuid AND s.step_index = $2::int AND s.status = 'sending' AND s.attempt = $3::int`;

// Params: enrollment, step, attempt, status, outcome, sent_at. One statement, no profile lock,
// so a send's result is recorded even while the engine holds the profile. A sent step keeps its
// ledger row, stamped with the mark time; any other final status takes it out of the cap count.
export const MARK_SQL = `
  WITH marked AS (
    UPDATE marketing.steps s SET status = $4, outcome = $5::jsonb, sent_at = $6::timestamptz, lease_until = NULL
    WHERE ${OWNED}
    RETURNING ${STEP_REF} AS ref, s.status
  ), kept AS (
    UPDATE marketing.send_ledger l SET sent_at = $6::timestamptz
    FROM marked WHERE l.source_ref = marked.ref AND marked.status = 'sent' RETURNING 1
  ), changed AS (
    SELECT ref FROM marked WHERE status <> 'sent'
  ), ${DROP_LEDGER}
  SELECT count(*)::int AS updated FROM marked`;

// Params: enrollment, step, attempt, now, new lease end.
const EXTEND_LEASE_SQL = `
  UPDATE marketing.steps s SET lease_until = $5::timestamptz
  WHERE ${OWNED} AND s.lease_until > $4::timestamptz AND ${ACTIVE}`;

// Params: enrollment, step, attempt. Runs after the reservation, so it also releases the cap slot.
const CANCEL_IF_INACTIVE_SQL = `
  WITH changed AS (
    UPDATE marketing.steps s SET status = 'cancelled', outcome = '{"reason":"inactive"}',
      lease_until = NULL, sent_at = NULL
    WHERE ${OWNED} AND NOT ${ACTIVE}
    RETURNING ${STEP_REF} AS ref
  ), ${DROP_LEDGER}
  SELECT count(*)::int AS updated FROM changed`;

// Params: enrollment, step, attempt.
const GOAL_MET_SQL = `
  WITH changed AS (
    UPDATE marketing.steps s SET status = 'cancelled', outcome = '{"reason":"goal_met"}',
      lease_until = NULL, sent_at = NULL
    WHERE ${OWNED} RETURNING ${STEP_REF} AS ref
  ), ${DROP_LEDGER}, rest AS (
    UPDATE marketing.steps SET status = 'cancelled'
    WHERE enrollment_id = $1::uuid AND status = 'pending' RETURNING 1
  ), done AS (
    UPDATE marketing.enrollments SET status = 'completed', end_reason = 'goal'
    WHERE id = $1::uuid AND status = 'active' RETURNING 1
  )
  SELECT count(*)::int AS updated FROM changed`;

// Params: enrollment, step, attempt, due_at, outcome, attempts to give back, whether due_at is a new schedule.
// Under an enrollment that ended meanwhile the step is cancelled instead of orphaned as pending.
// A retry or source deferral keeps scheduled_at, so a step the source keeps deferring still expires.
const REQUEUE_SQL = `
  UPDATE marketing.steps s SET
    status = CASE WHEN e.status = 'active' THEN 'pending' ELSE 'cancelled' END,
    due_at = $4::timestamptz,
    scheduled_at = CASE WHEN $7::boolean THEN $4::timestamptz ELSE COALESCE(s.scheduled_at, s.due_at) END,
    outcome = $5::jsonb,
    attempt = s.attempt - $6::int, lease_until = NULL, sent_at = NULL
  FROM marketing.enrollments e
  WHERE e.id = s.enrollment_id AND ${OWNED}
  RETURNING s.status`;

// Params: enrollment, step, attempt, now, cap lock key, project, profile, channel. A reserved step
// carries sent_at and its ledger row while it is still sending, so concurrent sends count against
// every cap. One statement, so an uncapped send costs no interactive transaction; the cap lock is
// held until it commits, so a sender counting under that lock sees this row or waits for it.
const RESERVE_SQL = `
  WITH cap_lock AS (
    SELECT pg_advisory_xact_lock(hashtextextended($5, 0))
  ), reserved AS (
    UPDATE marketing.steps s SET sent_at = $4::timestamptz
    WHERE ${OWNED} AND EXISTS (SELECT 1 FROM cap_lock)
    RETURNING ${STEP_REF} AS ref
  ), recorded AS (
    INSERT INTO marketing.send_ledger (source_ref, project_id, profile_id, channel, sent_at)
    SELECT ref, $6, $7, $8, $4::timestamptz FROM reserved
    ON CONFLICT (source_ref) DO UPDATE SET sent_at = EXCLUDED.sent_at
    RETURNING 1
  )
  SELECT count(*)::int AS updated FROM reserved`;

const PROFILE_OF_SQL = `
  SELECT project_id AS "projectId", profile_id AS "profileId"
  FROM marketing.enrollments WHERE id = $1::uuid`;

const COMPLETE_IF_DONE_SQL = `
  UPDATE marketing.enrollments e SET status = 'completed', end_reason = 'exhausted'
  WHERE e.id = $1::uuid AND e.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM marketing.steps s
                    WHERE s.enrollment_id = e.id AND s.status IN ('pending', 'sending'))`;

// Params: batch size. Heals completions that failed after a step's final mark.
const UNFINISHED_COMPLETIONS_SQL = `
  SELECT e.id::text FROM marketing.enrollments e
  WHERE e.status = 'active'
    AND EXISTS (SELECT 1 FROM marketing.steps s WHERE s.enrollment_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM marketing.steps s
                    WHERE s.enrollment_id = e.id AND s.status IN ('pending', 'sending'))
  LIMIT $1::int`;

// Params: project, profile, tokens. Scoped to the recipient so an adapter result cannot touch other profiles.
const DELETE_INVALID_TOKENS_SQL = `
  DELETE FROM marketing.devices
  WHERE project_id = $1 AND profile_id = $2 AND token = ANY($3::text[])`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Every string in the config is treated as a secret, including those inside embedded JSON (service accounts).
function secretsOf(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) {
        return [value, ...secretsOf(parsed)];
      }
    } catch {
      // not JSON
    }
    return [value];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(secretsOf);
  }
  return [];
}

function outcomeJson(reason: string | null): string | null {
  return reason === null ? null : JSON.stringify({ reason });
}

async function runPool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

async function readLagState(sql: Sql) {
  const [row] = await sql.$queryRawUnsafe<
    { lag: bigint | number; updated_at: Date }[]
  >('SELECT lag, updated_at FROM marketing.consumer_state WHERE id = 1');
  return row ? { lag: Number(row.lag), updatedAt: row.updated_at } : null;
}

async function underProfileLock<T>(
  sql: Sql,
  enrollmentId: string,
  work: (tx: Queryable) => Promise<T>
): Promise<T> {
  return await sql.$transaction(async (tx) => {
    const keys = await tx.$queryRawUnsafe<
      { projectId: string; profileId: string }[]
    >(PROFILE_OF_SQL, enrollmentId);
    await lockProfiles(tx, keys);
    return await work(tx);
  }, LOCKED_TRANSACTION);
}

// Best effort: a failure here is healed by the sweep at the start of the next tick.
async function completeIfDone(sql: Sql, enrollmentId: string): Promise<void> {
  try {
    await underProfileLock(sql, enrollmentId, (tx) =>
      tx.$executeRawUnsafe(COMPLETE_IF_DONE_SQL, enrollmentId)
    );
  } catch (error) {
    console.error(
      LOG_PREFIX,
      `completing enrollment ${enrollmentId}:`,
      redactSecrets(error, [])
    );
  }
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { sql, cfg } = deps;
  const result: TickResult = { sent: 0, skipped: 0, postponed: 0, failed: 0 };
  const state = deps.state ?? createTickState();
  const tickStart = deps.now();
  const lagState = await readLagState(sql);
  if (!lagAllowsSending(lagState, tickStart, cfg)) {
    warnLagGateClosed(deps, state, lagState, tickStart);
    return result;
  }
  await sql.$queryRawUnsafe(CANCEL_ORPHANED_SQL, tickStart.toISOString());
  if (tickStart.getTime() - state.lastSweepAt >= HEAL_SWEEP_INTERVAL_MS) {
    state.lastSweepAt = tickStart.getTime();
    const unfinished = await sql.$queryRawUnsafe<{ id: string }[]>(
      UNFINISHED_COMPLETIONS_SQL,
      cfg.claimBatch
    );
    for (const { id } of unfinished) {
      await completeIfDone(sql, id);
    }
  }
  // Refills share the tick's claim budget, so a tick never claims more than claimBatch steps.
  let claimBudget = cfg.claimBatch;
  const claimDue = async (now: Date) => {
    if (claimBudget <= 0) {
      return [];
    }
    const claims = await sql.$queryRawUnsafe<Claim[]>(
      CLAIM_SQL,
      now.toISOString(),
      new Date(now.getTime() - cfg.graceSeconds * 1000).toISOString(),
      claimBudget,
      new Date(now.getTime() + cfg.leaseSeconds * 1000).toISOString()
    );
    claimBudget -= claims.length;
    return await expireLate(claims, now);
  };
  const count = (outcome: Outcome) => {
    if (outcome !== 'lost') {
      result[outcome]++;
    }
  };
  // A step this late would surprise its recipient, so it ends before any lookup or send.
  const expireLate = async (claims: Claim[], now: Date) => {
    const latestAllowed = now.getTime() - cfg.maxLatenessSeconds * 1000;
    const onTime: Claim[] = [];
    for (const claim of claims) {
      if (new Date(claim.scheduled_at).getTime() >= latestAllowed) {
        onTime.push(claim);
        continue;
      }
      try {
        count(
          await createStepWriter(deps, claim).finish('skipped', EXPIRED_REASON)
        );
      } catch (error) {
        console.error(LOG_PREFIX, stepLabel(claim), redactSecrets(error, []));
      }
    }
    return onTime;
  };
  const send = async ({
    claim,
    entry,
  }: {
    claim: Claim;
    entry?: LookupEntry;
  }) => count(await processClaim(deps, claim, entry));
  // A lookup can take longer than the lease; sending then could race the replica that reclaims it.
  const sendIfLeaseLeft = async (item: {
    claim: Claim;
    entry?: LookupEntry;
  }) => {
    const leaseLeftMs =
      new Date(item.claim.lease_until).getTime() - deps.now().getTime();
    if (leaseLeftMs >= MIN_LEASE_LEFT_MS) {
      return await send(item);
    }
    try {
      count(await createStepWriter(deps, item.claim).postpone(deps.now()));
    } catch (error) {
      console.error(
        LOG_PREFIX,
        stepLabel(item.claim),
        redactSecrets(error, [])
      );
    }
  };

  const routing = createSourceRouting(deps, count);
  const first = await routing.split(await claimDue(tickStart));
  const laterStored: Claim[] = [];
  // Stored steps go out while http steps wait for their lookup batch to fill.
  const [, groups] = await Promise.all([
    runPool(
      first.stored.map((claim) => ({ claim })),
      cfg.sendConcurrency,
      send
    ),
    gatherLookupBatch(first.lookups, {
      maxBatch: MAX_LOOKUP_IDS,
      windowMs: cfg.lookupWindowMs,
      now: Date.now,
      sleep: (ms) => Bun.sleep(ms),
      // A failed refill only ends the wait early; the steps already claimed still go out.
      refill: async () => {
        try {
          const more = await routing.split(await claimDue(deps.now()));
          laterStored.push(...more.stored);
          return more.lookups;
        } catch (error) {
          console.error(LOG_PREFIX, 'refill claim:', redactSecrets(error, []));
          return [];
        }
      },
    }),
  ]);
  const lookedUp = await Promise.all(groups.map(routing.lookUp));
  await routing.recordHealthy();
  await runPool(
    [...laterStored.map((claim) => ({ claim })), ...lookedUp.flat()],
    cfg.sendConcurrency,
    sendIfLeaseLeft
  );
  return result;
}

function lookupChannel(channel: ChannelId | null): LookupChannel {
  return channel === null || channel === 'webhook' ? 'none' : channel;
}

async function setSourceStatus(
  deps: TickDeps,
  projectId: string,
  status: 'ok' | 'source_auth_failed' | 'source_error'
): Promise<void> {
  try {
    await deps.sql.$executeRawUnsafe(
      SOURCE_STATUS_SQL,
      projectId,
      status,
      deps.now().toISOString()
    );
  } catch (error) {
    console.error(
      LOG_PREFIX,
      'recording the audience source status:',
      redactSecrets(error, [])
    );
  }
}

// Splits claims by audience source and runs the lookups; looked-up contact fields live only in the returned items.
function createSourceRouting(
  deps: TickDeps,
  count: (outcome: Outcome) => void
) {
  const sources = deps.sources ?? ALL_STORED;
  const resolved = new Map<string, Promise<AudienceSource | null>>();
  const loggedProjects = new Set<string>();
  // A project is ok only if every one of its lookups this tick succeeded, so mixed channels cannot flap.
  const healthyProjects = new Set<string>();
  const failedProjects = new Set<string>();

  function sourceFor(projectId: string) {
    let source = resolved.get(projectId);
    if (!source) {
      source = sources.forProject(projectId);
      resolved.set(projectId, source);
    }
    return source;
  }

  // A source failure is never the step's fault: it goes back to pending without spending an attempt.
  async function deferAll(
    projectId: string,
    claims: Claim[],
    error: unknown
  ): Promise<void> {
    failedProjects.add(projectId);
    // Down or busy is transient and says nothing about the setup, so only these are shown.
    const transient =
      error instanceof SourceUnavailableError ||
      error instanceof SourceBusyError;
    if (error instanceof SourceAuthError) {
      await setSourceStatus(deps, projectId, 'source_auth_failed');
    } else if (!transient) {
      await setSourceStatus(deps, projectId, 'source_error');
    }
    if (!loggedProjects.has(projectId)) {
      loggedProjects.add(projectId);
      console.error(
        LOG_PREFIX,
        'audience source failed, its steps wait:',
        redactSecrets(error, [])
      );
    }
    const reason =
      error instanceof SourceAuthError
        ? 'source_auth_failed'
        : 'source_unavailable';
    const dueAt = new Date(deps.now().getTime() + SOURCE_BACKOFF_MS);
    await runPool(claims, deps.cfg.sendConcurrency, async (claim) => {
      try {
        count(
          await createStepWriter(deps, claim).deferForSource(dueAt, reason)
        );
      } catch (markError) {
        console.error(
          LOG_PREFIX,
          stepLabel(claim),
          redactSecrets(markError, [])
        );
      }
    });
  }

  return {
    async recordHealthy() {
      for (const projectId of healthyProjects) {
        if (!failedProjects.has(projectId)) {
          await setSourceStatus(deps, projectId, 'ok');
        }
      }
    },

    async split(claims: Claim[]) {
      const stored: Claim[] = [];
      const lookups: LookupItem[] = [];
      const byProject = Map.groupBy(claims, (claim) => claim.project_id);
      for (const [projectId, group] of byProject) {
        let source: AudienceSource | null;
        try {
          source = await sourceFor(projectId);
        } catch (error) {
          await deferAll(projectId, group, error);
          continue;
        }
        if (!source) {
          stored.push(...group);
          continue;
        }
        for (const claim of group) {
          lookups.push({
            projectId,
            profileId: claim.profile_id,
            claim,
            source,
          });
        }
      }
      return { stored, lookups };
    },

    // A group holds one project's steps; it gets one lookup per channel.
    async lookUp(group: LookupItem[]) {
      const ready: { claim: Claim; entry: LookupEntry }[] = [];
      const [head] = group;
      if (!head) {
        return ready;
      }
      const { source, projectId } = head;
      const byChannel = Map.groupBy(group, (item) =>
        lookupChannel(item.claim.channel)
      );
      for (const [channel, items] of byChannel) {
        try {
          const entries = await source.lookup(
            items.map((item) => item.profileId),
            channel
          );
          const byId = new Map(entries.map((entry) => [entry.id, entry]));
          healthyProjects.add(projectId);
          for (const { claim, profileId } of items) {
            const entry = byId.get(profileId) ?? {
              id: profileId,
              status: 'not_found' as const,
            };
            ready.push({ claim, entry });
          }
        } catch (error) {
          await deferAll(
            projectId,
            items.map((item) => item.claim),
            error
          );
        }
      }
      return ready;
    },
  };
}

function warnLagGateClosed(
  deps: TickDeps,
  state: TickState,
  lagState: Awaited<ReturnType<typeof readLagState>>,
  now: Date
): void {
  // No state yet is normal for the first seconds after startup; the lag reporter logs its own failures.
  if (!lagState || now.getTime() - state.lastLagWarnAt < LAG_WARN_INTERVAL_MS) {
    return;
  }
  state.lastLagWarnAt = now.getTime();
  const detail = `consumer lag ${lagState.lag} (threshold ${deps.cfg.maxLag}), state ${Math.round((now.getTime() - lagState.updatedAt.getTime()) / 1000)} s old`;
  (deps.logger ?? console).warn(
    LOG_PREFIX,
    redactSecrets(`sending paused: ${detail}`, [])
  );
}

function stepLabel(claim: Claim) {
  return `step ${claim.enrollment_id}:${claim.step_index}`;
}

// Throws on a failure before the adapter is called; nothing has been sent then, so a retry is safe.
async function processClaim(
  deps: TickDeps,
  claim: Claim,
  entry?: LookupEntry
): Promise<Outcome> {
  const step = createStepWriter(deps, claim);
  // Filled as soon as contact fields are in memory, so any throw below is redacted against them.
  const known = entry ? entryValues(entry) : [];
  try {
    if (claim.attempt > MAX_ATTEMPTS) {
      return await step.finish('failed', 'max_attempts');
    }
    return await deliver(deps, claim, step, entry, known);
  } catch (error) {
    const reason = redactSecrets(error, longestFirst(known));
    console.error(LOG_PREFIX, stepLabel(claim), reason);
    try {
      return await step.retry(reason);
    } catch (markError) {
      console.error(LOG_PREFIX, stepLabel(claim), redactSecrets(markError, []));
      return 'lost';
    }
  }
}

function createStepWriter(deps: TickDeps, claim: Claim) {
  const owned = [claim.enrollment_id, claim.step_index, claim.attempt];
  const stepRef = ledgerRef.step(claim.enrollment_id, claim.step_index);

  async function mark(
    status: 'sent' | 'skipped' | 'failed',
    reason: string | null
  ): Promise<number> {
    const sentAt = status === 'sent' ? deps.now().toISOString() : null;
    for (const delay of [...MARK_RETRY_DELAYS_MS, null]) {
      try {
        const [row] = await deps.sql.$queryRawUnsafe<{ updated: number }[]>(
          MARK_SQL,
          ...owned,
          status,
          outcomeJson(reason),
          sentAt
        );
        return row?.updated ?? 0;
      } catch (error) {
        if (delay === null) {
          throw error;
        }
        await Bun.sleep(delay);
      }
    }
    return 0;
  }

  async function finish(
    status: 'sent' | 'skipped' | 'failed',
    reason: string | null
  ): Promise<Outcome> {
    const updated = await mark(status, reason);
    if (!updated) {
      return 'lost';
    }
    // Later steps of an active enrollment stay pending until claimed in order, and every path that
    // finalizes them early also ends the enrollment; the sweep heals anything else.
    if (claim.is_last) {
      await completeIfDone(deps.sql, claim.enrollment_id);
    }
    return status;
  }

  async function requeue(
    dueAt: Date,
    reason: string | null,
    giveBackAttempt: boolean,
    reschedule = false
  ): Promise<Outcome> {
    const [row] = await underProfileLock(
      deps.sql,
      claim.enrollment_id,
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ status: string }[]>(
          REQUEUE_SQL,
          ...owned,
          dueAt.toISOString(),
          outcomeJson(reason),
          giveBackAttempt ? 1 : 0,
          reschedule
        );
        if (rows.length > 0) {
          await deleteLedger(tx, [stepRef]);
        }
        return rows;
      }
    );
    if (!row) {
      return 'lost';
    }
    return row.status === 'pending' ? 'postponed' : 'skipped';
  }

  async function skipForCap(tx: Queryable): Promise<Outcome> {
    const [row] = await tx.$queryRawUnsafe<{ updated: number }[]>(
      MARK_SQL,
      ...owned,
      'skipped',
      outcomeJson('cap'),
      null
    );
    if (!row?.updated) {
      return 'lost';
    }
    await tx.$executeRawUnsafe(COMPLETE_IF_DONE_SQL, claim.enrollment_id);
    return 'skipped';
  }

  return {
    owned,
    finish,
    postpone: (dueAt: Date) => requeue(dueAt, null, true),
    // Quiet hours set a deliberate new send time, which is not lateness.
    reschedule: (dueAt: Date) => requeue(dueAt, null, true, true),
    deferForSource: (dueAt: Date, reason: string) =>
      requeue(dueAt, reason, true),
    retry(reason: string): Promise<Outcome> {
      if (claim.attempt >= MAX_ATTEMPTS) {
        return finish('failed', reason);
      }
      const dueAt = new Date(
        deps.now().getTime() + RETRY_BACKOFF_MS * claim.attempt
      );
      return requeue(dueAt, reason, false);
    },
    async goalMet(): Promise<Outcome> {
      const [row] = await underProfileLock(
        deps.sql,
        claim.enrollment_id,
        (tx) =>
          tx.$queryRawUnsafe<{ updated: number }[]>(GOAL_MET_SQL, ...owned)
      );
      return row?.updated ? 'skipped' : 'lost';
    },
    // Anything but true means do not send: the lease was taken over ('lost'),
    // or the enrollment or rule ended and the step was cancelled ('skipped').
    async extendLease(now: Date): Promise<true | Outcome> {
      const leaseEnd = new Date(now.getTime() + deps.cfg.leaseSeconds * 1000);
      const extended = await deps.sql.$executeRawUnsafe(
        EXTEND_LEASE_SQL,
        ...owned,
        now.toISOString(),
        leaseEnd.toISOString()
      );
      if (extended) {
        return true;
      }
      const [cancelled] = await deps.sql.$queryRawUnsafe<{ updated: number }[]>(
        CANCEL_IF_INACTIVE_SQL,
        ...owned
      );
      return cancelled?.updated ? 'skipped' : 'lost';
    },
    // Writes the step's ledger row, or marks the step skipped when the cap is used up. Runs for
    // uncapped projects too: a campaign's cap, or a cap added later, must see every journey send.
    reserve(args: {
      projectId: string;
      profileId: string;
      channel: string;
      cap: EffectiveCap | null;
      now: Date;
    }): Promise<Outcome | true> {
      const { projectId, profileId, channel, cap, now } = args;
      const lock = {
        projectId,
        profileId,
        channel,
        scope: cap?.scope ?? 'channel',
      } as const;
      const reserveAndRecord = async (
        db: Queryable
      ): Promise<Outcome | true> => {
        const [row] = await db.$queryRawUnsafe<{ updated: number }[]>(
          RESERVE_SQL,
          ...owned,
          now.toISOString(),
          capLockKey(lock),
          projectId,
          profileId,
          channel
        );
        return row?.updated ? true : 'lost';
      };
      // An uncapped send must not wait behind a consumer batch holding the engine's profile lock;
      // only a cap skip, which may complete the enrollment, needs it.
      if (!cap) {
        return reserveAndRecord(deps.sql);
      }
      return underProfileLock(
        deps.sql,
        claim.enrollment_id,
        async (tx): Promise<Outcome | true> => {
          await lockCap(tx, lock);
          const counts = await countRecentSends(tx, {
            projectId,
            profileIds: [profileId],
            channel: cap.scope === 'all' ? null : channel,
            since: new Date(now.getTime() - cap.periodSeconds * 1000),
            excludeRefs: [stepRef],
          });
          if (!capAllows(counts.get(profileId) ?? 0, cap)) {
            return await skipForCap(tx);
          }
          return await reserveAndRecord(tx);
        }
      );
    },
  };
}

type StepWriter = ReturnType<typeof createStepWriter>;

export function loadChannelConfig(
  schema: z.ZodType<unknown>,
  encrypted: string,
  encryptionKey: string
): { ok: true; config: unknown; secrets: string[] } | { ok: false } {
  try {
    const raw = decryptCredential(encryptionKey, encrypted);
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success
      ? {
          ok: true,
          config: parsed.data,
          secrets: [raw, ...secretsOf(parsed.data)].filter(
            (secret) => secret.length >= MIN_SECRET_LENGTH
          ),
        }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function render(
  stepDef: Step,
  template: { subject?: string; body: string },
  context: StepContext,
  goal: GoalResult,
  meta: RenderedMessage['meta']
): RenderedMessage {
  const vars = {
    profile: isRecord(context.attributes) ? context.attributes : {},
    event: isRecord(context.trigger_properties)
      ? context.trigger_properties
      : {},
    missing: goal.missing,
    allowedEventProps: context.rule_snapshot.allowedEventProps,
  };
  const { channel } = stepDef;
  const heading =
    template.subject === undefined
      ? undefined
      : renderTemplate(template.subject, vars, { mode: 'text' });
  const body = renderTemplate(template.body, vars, {
    mode: channel === 'email' ? 'html' : 'text',
  });
  return channel === 'push'
    ? { title: heading, body, meta }
    : { subject: heading, body, meta };
}

export function lookupSkipReason(entry: LookupEntry): string | null {
  if (entry.status === 'ok') {
    return null;
  }
  if (entry.status === 'unreachable') {
    const reason = UNREACHABLE_REASON.test(entry.reason ?? '')
      ? entry.reason
      : 'unknown';
    return `unreachable:${reason}`;
  }
  return entry.status;
}

async function loadContext(
  deps: TickDeps,
  claim: Claim,
  entry: LookupEntry | undefined
): Promise<StepContext | undefined> {
  if (!entry) {
    const [context] = await deps.sql.$queryRawUnsafe<StepContext[]>(
      CONTEXT_SQL,
      claim.enrollment_id,
      claim.step_index
    );
    return context;
  }
  const [row] = await deps.sql.$queryRawUnsafe<
    Omit<StepContext, 'email' | 'attributes' | 'device_tokens'>[]
  >(CONTEXT_NO_CONTACT_SQL, claim.enrollment_id, claim.step_index);
  if (!row) {
    return row;
  }
  const looked = entry.devices?.map((device) => device.token) ?? [];
  const deviceTokens =
    claim.channel === 'push'
      ? await filterLiveTokens(
          deps.sql,
          claim.project_id,
          looked,
          deps.cfg.encryptionKey
        )
      : looked;
  const allDead = looked.length > 0 && deviceTokens.length === 0;
  return {
    ...row,
    email: entry.email ?? null,
    attributes: entry.traits ?? {},
    device_tokens: deviceTokens,
    lookup_skip:
      lookupSkipReason(entry) ?? (allDead ? NO_LIVE_TOKEN_REASON : null),
  };
}

function skipReason(stepDef: Step, context: StepContext): string | null {
  if (context.lookup_skip) {
    return context.lookup_skip;
  }
  if (context.opted_out) {
    return 'opted_out';
  }
  if (stepDef.channel === 'email' && !context.email) {
    return 'no_email';
  }
  if (stepDef.channel === 'push' && context.device_tokens.length === 0) {
    return 'no_device';
  }
  return null;
}

async function deliver(
  deps: TickDeps,
  claim: Claim,
  step: StepWriter,
  entry: LookupEntry | undefined,
  known: string[]
): Promise<Outcome> {
  const context = await loadContext(deps, claim, entry);
  if (!context) {
    return 'lost';
  }
  const recipient = recipientOf(context);
  known.push(...recipientValues(recipient));
  const stepDef = context.rule_snapshot.steps[claim.step_index];
  if (!stepDef) {
    return await step.finish('failed', 'step_missing');
  }

  const goal = await deps.engine.evaluateEnrollment(claim.enrollment_id);
  if (goal.met) {
    return await step.goalMet();
  }
  const skip = skipReason(stepDef, context);
  if (skip) {
    return await step.finish('skipped', skip);
  }
  const quietHours = zQuietHours.parse(context.quiet_hours ?? null);
  const now = deps.now();
  if (inQuietHours(now, quietHours)) {
    return await step.reschedule(nextAllowedTime(now, quietHours));
  }

  let adapter: ChannelAdapter<unknown>;
  try {
    adapter = getAdapter(stepDef.channel);
  } catch {
    return await step.finish('skipped', 'channel_unavailable');
  }
  if (!context.config_encrypted) {
    return await step.finish('skipped', 'channel_not_configured');
  }
  const loaded = loadChannelConfig(
    adapter.configSchema,
    context.config_encrypted,
    deps.cfg.encryptionKey
  );
  if (!loaded.ok) {
    return await step.finish('skipped', 'invalid_channel_config');
  }

  const template = stepDef.template;
  if (template?.body === undefined) {
    return await step.finish('skipped', 'no_message');
  }

  const reserved = await step.reserve({
    projectId: context.project_id,
    profileId: context.profile_id,
    channel: stepDef.channel,
    cap: effectiveCap(null, zCaps.parse(context.caps ?? null)),
    now,
  });
  if (reserved !== true) {
    return reserved;
  }

  const message = render(
    stepDef,
    { ...template, body: template.body },
    context,
    goal,
    {
      projectId: context.project_id,
      enrollmentId: claim.enrollment_id,
      ruleId: context.rule_id,
      stepIndex: claim.step_index,
    }
  );
  const leased = await step.extendLease(deps.now());
  if (leased !== true) {
    return leased;
  }
  // No transaction or row lock is held here: the lease alone owns the step during the call.
  const sendResult: SendResult = await Promise.resolve()
    .then(() =>
      adapter.send(message, recipient, loaded.config, {
        idempotencyKey: `${claim.enrollment_id}:${claim.step_index}`,
        unsubscribeUrl: deps.renderUnsubscribeUrl(
          context.project_id,
          context.profile_id,
          stepDef.channel
        ),
      })
    )
    .catch((error: unknown) => ({
      ok: false as const,
      retryable: true,
      reason: redactSecrets(error, recipientValues(recipient)),
    }));
  // Marked first: pruning must not eat into the lease budget between the send and its mark.
  const outcome = await recordSendResult(claim, step, sendResult, [
    ...loaded.secrets,
    ...recipientValues(recipient),
  ]);
  await forgetInvalidTokens(
    deps,
    context,
    entry !== undefined,
    sendResult.invalidTokens
  );
  return outcome;
}

// Attribute values shorter than this (a country code, "5") would garble messages without hiding anything.
const MIN_REDACTED_ATTRIBUTE_LENGTH = 3;

// An adapter's error text can echo who it was sending to; those values must not reach logs or the step row.
// Longest first, so "Asha Rao" goes before "Asha" and no half of a name survives.
function recipientOf(context: StepContext): Recipient {
  return {
    profileId: context.profile_id,
    ...(context.email ? { email: context.email } : {}),
    deviceTokens: context.device_tokens,
    attributes: isRecord(context.attributes) ? context.attributes : {},
  };
}

export function entryValues(entry: LookupEntry): string[] {
  const values = recipientValues({
    profileId: entry.id,
    ...(entry.email ? { email: entry.email } : {}),
    deviceTokens: entry.devices?.map((device) => device.token) ?? [],
    attributes: entry.traits ?? {},
  });
  return entry.phone ? [...values, entry.phone] : values;
}

function longestFirst(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function recipientValues(recipient: Recipient): string[] {
  const attributeValues = Object.values(recipient.attributes).filter(
    (value): value is string =>
      typeof value === 'string' && value.length >= MIN_REDACTED_ATTRIBUTE_LENGTH
  );
  const email = recipient.email
    ? [recipient.email, recipient.email.toLowerCase()]
    : [];
  return [...email, ...recipient.deviceTokens, ...attributeValues]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
}

// Best effort and never thrown: a throw would reach processClaim, which retries the already sent step.
// An http project has no device rows, so its invalid tokens are remembered as hashes instead.
async function forgetInvalidTokens(
  deps: TickDeps,
  context: StepContext,
  fromSource: boolean,
  tokens: string[] | undefined
): Promise<void> {
  if (!tokens?.length) {
    return;
  }
  try {
    if (fromSource) {
      await recordDeadTokens(
        deps.sql,
        context.project_id,
        tokens,
        deps.cfg.encryptionKey
      );
      return;
    }
    await deps.sql.$executeRawUnsafe(
      DELETE_INVALID_TOKENS_SQL,
      context.project_id,
      context.profile_id,
      tokens
    );
  } catch (error) {
    console.error(
      LOG_PREFIX,
      'pruning invalid device tokens:',
      redactSecrets(error, tokens)
    );
  }
}

// After the adapter was called the step is never requeued because a mark failed: it stays
// 'sending' until its lease expires and is then reclaimed. That reclaim is the at-least-once
// risk for channels without idempotency; the idempotency key covers the rest.
async function recordSendResult(
  claim: Claim,
  step: StepWriter,
  sendResult: SendResult,
  secrets: string[]
): Promise<Outcome> {
  try {
    if (sendResult.ok) {
      return await step.finish('sent', null);
    }
    const reason = redactSecrets(sendResult.reason, secrets);
    console.error(LOG_PREFIX, stepLabel(claim), 'send failed:', reason);
    return sendResult.retryable
      ? await step.retry(reason)
      : await step.finish('failed', reason);
  } catch (error) {
    console.error(
      LOG_PREFIX,
      stepLabel(claim),
      'recording the send result failed:',
      redactSecrets(error, secrets)
    );
    return 'lost';
  }
}
