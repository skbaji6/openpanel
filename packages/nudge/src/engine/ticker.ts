import { decryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import { getAdapter } from '../channels/registry';
import type {
  ChannelAdapter,
  Recipient,
  RenderedMessage,
  SendResult,
} from '../channels/types';
import type { NudgeConfig } from '../config';
import { redactSecrets } from '../redact';
import type { Step } from '../rules/rule.schema';
import { renderTemplate } from '../template/render';
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

const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 60_000;
// Total mark budget is about 0.5 s; leaseSeconds must exceed the adapter's own send timeout
// (at most 30 s) plus this budget, or a slow send can be reclaimed and sent twice.
const MARK_RETRY_DELAYS_MS = [100, 400];
// A locked write may wait on the engine's profile lock, which a consumer batch holds for up to 60 s.
const LOCKED_TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
const LOG_PREFIX = 'nudge ticker:';
// Shorter config strings (flags, ports) would blank out unrelated words in the log.
const MIN_SECRET_LENGTH = 4;

type Engine = ReturnType<typeof createEngine>;

export interface TickDeps {
  sql: Sql;
  engine: Engine;
  now: () => Date;
  cfg: NudgeConfig;
  renderUnsubscribeUrl: (
    projectId: string,
    profileId: string,
    channel: string
  ) => string;
}

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
}

const zCaps = z
  .object({
    max: z.number().int().nonnegative(),
    periodSeconds: z.number().int().positive(),
  })
  .nullable();
const zQuietHours = z
  .object({ start: z.string(), end: z.string(), timezone: z.string() })
  .nullable();

const ACTIVE = `EXISTS (SELECT 1 FROM nudge.enrollments ae JOIN nudge.rules ar ON ar.id = ae.rule_id
  WHERE ae.id = s.enrollment_id AND ae.status = 'active' AND ar.status = 'active')`;
// Steps go out in order: a step is claimable only once every earlier step of its enrollment is final.
const EARLIER_STEPS_FINAL = `NOT EXISTS (SELECT 1 FROM nudge.steps earlier
  WHERE earlier.enrollment_id = s.enrollment_id AND earlier.step_index < s.step_index
    AND earlier.status IN ('pending', 'sending'))`;

// Params: now. Expired leases of ended enrollments or inactive rules are cancelled, never resent.
// Set-based without the profile lock: it only touches 'sending' rows, which the engine never writes.
const CANCEL_ORPHANED_SQL = `
  UPDATE nudge.steps s SET status = 'cancelled', outcome = '{"reason":"inactive"}',
    lease_until = NULL, sent_at = NULL
  WHERE s.status = 'sending' AND s.lease_until < $1::timestamptz AND NOT ${ACTIVE}`;

// Params: now, latest claimable due_at (now - grace), batch size, lease end.
// Both arms walk a partial index; the joins keep paused rules and ended enrollments out of the batch.
export const CLAIM_SQL = `
  WITH expired AS (
    SELECT s.enrollment_id, s.step_index FROM nudge.steps s
    JOIN nudge.enrollments e ON e.id = s.enrollment_id AND e.status = 'active'
    JOIN nudge.rules r ON r.id = e.rule_id AND r.status = 'active'
    WHERE s.status = 'sending' AND s.lease_until < $1::timestamptz
    ORDER BY s.lease_until LIMIT $3::int
    FOR UPDATE OF s SKIP LOCKED
  ), due AS (
    SELECT s.enrollment_id, s.step_index FROM nudge.steps s
    JOIN nudge.enrollments e ON e.id = s.enrollment_id AND e.status = 'active'
    JOIN nudge.rules r ON r.id = e.rule_id AND r.status = 'active'
    WHERE s.status = 'pending' AND s.due_at <= $2::timestamptz AND ${EARLIER_STEPS_FINAL}
    ORDER BY s.due_at LIMIT $3::int
    FOR UPDATE OF s SKIP LOCKED
  ), picked AS (
    SELECT DISTINCT ON (enrollment_id) enrollment_id, step_index
    FROM (SELECT * FROM expired UNION ALL SELECT * FROM due) candidates
    ORDER BY enrollment_id, step_index
  )
  UPDATE nudge.steps s
  SET status = 'sending', lease_until = $4::timestamptz, attempt = s.attempt + 1
  FROM (SELECT * FROM picked LIMIT $3::int) chosen
  WHERE s.enrollment_id = chosen.enrollment_id AND s.step_index = chosen.step_index
  RETURNING s.enrollment_id::text, s.step_index, s.attempt`;

// Params: enrollment id, step index.
const CONTEXT_SQL = `
  WITH en AS (
    SELECT e.*, e.rule_snapshot->'steps'->$2::int->>'channel' AS channel
    FROM nudge.enrollments e WHERE e.id = $1::uuid
  )
  SELECT en.project_id, en.profile_id, en.rule_id::text, en.rule_snapshot,
    c.email, c.attributes,
    EXISTS (SELECT 1 FROM nudge.opt_outs o
            WHERE o.project_id = en.project_id AND o.profile_id = en.profile_id
              AND o.channel = en.channel) AS opted_out,
    ARRAY (SELECT d.token FROM nudge.devices d
           WHERE d.project_id = en.project_id AND d.profile_id = en.profile_id
           ORDER BY d.token) AS device_tokens,
    ps.caps, ps.quiet_hours, cc.config_encrypted,
    (SELECT ev.properties FROM nudge.events ev
     WHERE ev.project_id = en.project_id AND ev.profile_id = en.profile_id
       AND ev.name = en.rule_snapshot->'trigger'->>'event'
       AND ev.event_time = en.trigger_time
       AND (en.rule_snapshot->>'matchOn' IS NULL
            OR ev.properties->>(en.rule_snapshot->>'matchOn') = en.match_value)
     ORDER BY ev.event_id LIMIT 1) AS trigger_properties
  FROM en
  LEFT JOIN nudge.contacts c ON c.project_id = en.project_id AND c.profile_id = en.profile_id
  LEFT JOIN nudge.project_settings ps ON ps.project_id = en.project_id
  LEFT JOIN nudge.channel_configs cc ON cc.project_id = en.project_id AND cc.channel = en.channel`;

// Every write is fenced by status and attempt: a tick whose lease was reclaimed changes nothing.
const OWNED = `s.enrollment_id = $1::uuid AND s.step_index = $2::int AND s.status = 'sending' AND s.attempt = $3::int`;

// Params: enrollment, step, attempt, status, outcome, sent_at. One statement, no profile lock,
// so a send's result is recorded even while the engine holds the profile.
export const MARK_SQL = `
  UPDATE nudge.steps s SET status = $4, outcome = $5::jsonb, sent_at = $6::timestamptz, lease_until = NULL
  WHERE ${OWNED}`;

// Params: enrollment, step, attempt, now, new lease end.
const EXTEND_LEASE_SQL = `
  UPDATE nudge.steps s SET lease_until = $5::timestamptz
  WHERE ${OWNED} AND s.lease_until > $4::timestamptz AND ${ACTIVE}`;

// Params: enrollment, step, attempt.
const CANCEL_IF_INACTIVE_SQL = `
  UPDATE nudge.steps s SET status = 'cancelled', outcome = '{"reason":"inactive"}',
    lease_until = NULL, sent_at = NULL
  WHERE ${OWNED} AND NOT ${ACTIVE}`;

// Params: enrollment, step, attempt.
const GOAL_MET_SQL = `
  WITH step AS (
    UPDATE nudge.steps s SET status = 'cancelled', outcome = '{"reason":"goal_met"}',
      lease_until = NULL, sent_at = NULL
    WHERE ${OWNED} RETURNING s.enrollment_id
  ), rest AS (
    UPDATE nudge.steps SET status = 'cancelled'
    WHERE enrollment_id = $1::uuid AND status = 'pending' RETURNING 1
  ), done AS (
    UPDATE nudge.enrollments SET status = 'completed'
    WHERE id = $1::uuid AND status = 'active' RETURNING 1
  )
  SELECT count(*)::int AS updated FROM step`;

// Params: enrollment, step, attempt, due_at, outcome, attempts to give back.
// Under an enrollment that ended meanwhile the step is cancelled instead of orphaned as pending.
const REQUEUE_SQL = `
  UPDATE nudge.steps s SET
    status = CASE WHEN e.status = 'active' THEN 'pending' ELSE 'cancelled' END,
    due_at = $4::timestamptz, outcome = $5::jsonb,
    attempt = s.attempt - $6::int, lease_until = NULL, sent_at = NULL
  FROM nudge.enrollments e
  WHERE e.id = s.enrollment_id AND ${OWNED}
  RETURNING s.status`;

// A reserved step carries sent_at while it is still sending, so concurrent sends count against the cap.
const RESERVE_SQL = `UPDATE nudge.steps s SET sent_at = $4::timestamptz WHERE ${OWNED}`;

const PROFILE_OF_SQL = `
  SELECT project_id AS "projectId", profile_id AS "profileId"
  FROM nudge.enrollments WHERE id = $1::uuid`;

const COMPLETE_IF_DONE_SQL = `
  UPDATE nudge.enrollments e SET status = 'completed'
  WHERE e.id = $1::uuid AND e.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM nudge.steps s
                    WHERE s.enrollment_id = e.id AND s.status IN ('pending', 'sending'))`;

// Params: batch size. Heals completions that failed after a step's final mark.
const UNFINISHED_COMPLETIONS_SQL = `
  SELECT e.id::text FROM nudge.enrollments e
  WHERE e.status = 'active'
    AND EXISTS (SELECT 1 FROM nudge.steps s WHERE s.enrollment_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM nudge.steps s
                    WHERE s.enrollment_id = e.id AND s.status IN ('pending', 'sending'))
  LIMIT $1::int`;

// Params: project, profile, tokens. Scoped to the recipient so an adapter result cannot touch other profiles.
const DELETE_INVALID_TOKENS_SQL = `
  DELETE FROM nudge.devices
  WHERE project_id = $1 AND profile_id = $2 AND token = ANY($3::text[])`;

const CAP_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

// Params: project, profile, channel, window start, enrollment, step.
const CAP_COUNT_SQL = `
  SELECT count(*)::int AS n FROM nudge.enrollments e
  JOIN nudge.steps s ON s.enrollment_id = e.id
  WHERE e.project_id = $1 AND e.profile_id = $2
    AND e.rule_snapshot->'steps'->s.step_index->>'channel' = $3
    AND s.status IN ('sent', 'sending') AND s.sent_at > $4::timestamptz
    AND NOT (s.enrollment_id = $5::uuid AND s.step_index = $6::int)`;

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
  >('SELECT lag, updated_at FROM nudge.consumer_state WHERE id = 1');
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
  const tickStart = deps.now();
  if (!lagAllowsSending(await readLagState(sql), tickStart, cfg)) {
    return result;
  }
  await sql.$executeRawUnsafe(CANCEL_ORPHANED_SQL, tickStart.toISOString());
  const unfinished = await sql.$queryRawUnsafe<{ id: string }[]>(
    UNFINISHED_COMPLETIONS_SQL,
    cfg.claimBatch
  );
  for (const { id } of unfinished) {
    await completeIfDone(sql, id);
  }
  const claims = await sql.$queryRawUnsafe<Claim[]>(
    CLAIM_SQL,
    tickStart.toISOString(),
    new Date(tickStart.getTime() - cfg.graceSeconds * 1000).toISOString(),
    cfg.claimBatch,
    new Date(tickStart.getTime() + cfg.leaseSeconds * 1000).toISOString()
  );
  await runPool(claims, cfg.sendConcurrency, async (claim) => {
    const outcome = await processClaim(deps, claim);
    if (outcome !== 'lost') {
      result[outcome]++;
    }
  });
  return result;
}

function stepLabel(claim: Claim) {
  return `step ${claim.enrollment_id}:${claim.step_index}`;
}

// Throws on a failure before the adapter is called; nothing has been sent then, so a retry is safe.
async function processClaim(deps: TickDeps, claim: Claim): Promise<Outcome> {
  const step = createStepWriter(deps, claim);
  try {
    if (claim.attempt > MAX_ATTEMPTS) {
      return await step.finish('failed', 'max_attempts');
    }
    return await deliver(deps, claim, step);
  } catch (error) {
    const reason = redactSecrets(error, []);
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

  async function mark(
    status: 'sent' | 'skipped' | 'failed',
    reason: string | null
  ): Promise<number> {
    const sentAt = status === 'sent' ? deps.now().toISOString() : null;
    for (const delay of [...MARK_RETRY_DELAYS_MS, null]) {
      try {
        return await deps.sql.$executeRawUnsafe(
          MARK_SQL,
          ...owned,
          status,
          outcomeJson(reason),
          sentAt
        );
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
    await completeIfDone(deps.sql, claim.enrollment_id);
    return status;
  }

  async function requeue(
    dueAt: Date,
    reason: string | null,
    giveBackAttempt: boolean
  ): Promise<Outcome> {
    const [row] = await underProfileLock(deps.sql, claim.enrollment_id, (tx) =>
      tx.$queryRawUnsafe<{ status: string }[]>(
        REQUEUE_SQL,
        ...owned,
        dueAt.toISOString(),
        outcomeJson(reason),
        giveBackAttempt ? 1 : 0
      )
    );
    if (!row) {
      return 'lost';
    }
    return row.status === 'pending' ? 'postponed' : 'skipped';
  }

  return {
    owned,
    finish,
    postpone: (dueAt: Date) => requeue(dueAt, null, true),
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
      const cancelled = await deps.sql.$executeRawUnsafe(
        CANCEL_IF_INACTIVE_SQL,
        ...owned
      );
      return cancelled ? 'skipped' : 'lost';
    },
    // Reserves a cap slot, or marks the step skipped when the cap is used up.
    reserveUnderCap(args: {
      projectId: string;
      profileId: string;
      channel: string;
      caps: { max: number; periodSeconds: number };
      now: Date;
    }): Promise<Outcome | true> {
      const { projectId, profileId, channel, caps, now } = args;
      return underProfileLock(
        deps.sql,
        claim.enrollment_id,
        async (tx): Promise<Outcome | true> => {
          await tx.$executeRawUnsafe(
            CAP_LOCK_SQL,
            JSON.stringify([projectId, profileId, channel])
          );
          const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(
            CAP_COUNT_SQL,
            projectId,
            profileId,
            channel,
            new Date(now.getTime() - caps.periodSeconds * 1000).toISOString(),
            claim.enrollment_id,
            claim.step_index
          );
          if (!capAllows(row?.n ?? 0, caps)) {
            const skipped = await tx.$executeRawUnsafe(
              MARK_SQL,
              ...owned,
              'skipped',
              outcomeJson('cap'),
              null
            );
            if (!skipped) {
              return 'lost';
            }
            await tx.$executeRawUnsafe(
              COMPLETE_IF_DONE_SQL,
              claim.enrollment_id
            );
            return 'skipped';
          }
          const reserved = await tx.$executeRawUnsafe(
            RESERVE_SQL,
            ...owned,
            now.toISOString()
          );
          return reserved ? true : 'lost';
        }
      );
    },
  };
}

type StepWriter = ReturnType<typeof createStepWriter>;

function loadConfig(
  adapter: ChannelAdapter<unknown>,
  encrypted: string,
  encryptionKey: string
): { ok: true; config: unknown; secrets: string[] } | { ok: false } {
  try {
    const raw = decryptCredential(encryptionKey, encrypted);
    const parsed = adapter.configSchema.safeParse(JSON.parse(raw));
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
  const { channel, template } = stepDef;
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

function skipReason(stepDef: Step, context: StepContext): string | null {
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
  step: StepWriter
): Promise<Outcome> {
  const [context] = await deps.sql.$queryRawUnsafe<StepContext[]>(
    CONTEXT_SQL,
    claim.enrollment_id,
    claim.step_index
  );
  if (!context) {
    return 'lost';
  }
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
    return await step.postpone(nextAllowedTime(now, quietHours));
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
  const loaded = loadConfig(
    adapter,
    context.config_encrypted,
    deps.cfg.encryptionKey
  );
  if (!loaded.ok) {
    return await step.finish('skipped', 'invalid_channel_config');
  }

  const caps = zCaps.parse(context.caps ?? null);
  if (caps) {
    const reserved = await step.reserveUnderCap({
      projectId: context.project_id,
      profileId: context.profile_id,
      channel: stepDef.channel,
      caps,
      now,
    });
    if (reserved !== true) {
      return reserved;
    }
  }

  const message = render(stepDef, context, goal, {
    projectId: context.project_id,
    enrollmentId: claim.enrollment_id,
    ruleId: context.rule_id,
    stepIndex: claim.step_index,
  });
  const recipient: Recipient = {
    profileId: context.profile_id,
    ...(context.email ? { email: context.email } : {}),
    deviceTokens: context.device_tokens,
    attributes: isRecord(context.attributes) ? context.attributes : {},
  };
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
      reason: error instanceof Error ? error.message : String(error),
    }));
  // Marked first: pruning must not eat into the lease budget between the send and its mark.
  const outcome = await recordSendResult(
    claim,
    step,
    sendResult,
    loaded.secrets
  );
  await pruneInvalidTokens(deps.sql, context, sendResult.invalidTokens);
  return outcome;
}

// Best effort and never thrown: a throw would reach processClaim, which retries the already sent step.
async function pruneInvalidTokens(
  sql: Sql,
  context: StepContext,
  tokens: string[] | undefined
): Promise<void> {
  if (!tokens?.length) {
    return;
  }
  try {
    await sql.$executeRawUnsafe(
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
