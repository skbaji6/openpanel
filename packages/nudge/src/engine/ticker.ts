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
// A mark may wait on the engine's profile lock, which a consumer batch holds for up to 60 s.
const MARK_TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
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
    WHERE s.status = 'pending' AND s.due_at <= $2::timestamptz
    ORDER BY s.due_at LIMIT $3::int
    FOR UPDATE OF s SKIP LOCKED
  ), picked AS (
    SELECT * FROM (SELECT * FROM expired UNION ALL SELECT * FROM due) candidates
    LIMIT $3::int
  )
  UPDATE nudge.steps s
  SET status = 'sending', lease_until = $4::timestamptz, attempt = s.attempt + 1
  FROM picked
  WHERE s.enrollment_id = picked.enrollment_id AND s.step_index = picked.step_index
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

// Every mark is fenced by status and attempt: a tick whose lease expired and was reclaimed changes nothing.
const OWNED = `enrollment_id = $1::uuid AND step_index = $2::int AND status = 'sending' AND attempt = $3::int`;

// Params: enrollment, step, attempt, status, outcome, sent_at.
// The NOT EXISTS sees the statement's snapshot, where this step is still 'sending', hence the step_index filter.
const FINISH_SQL = `
  WITH step AS (
    UPDATE nudge.steps SET status = $4, outcome = $5::jsonb, sent_at = $6::timestamptz, lease_until = NULL
    WHERE ${OWNED} RETURNING enrollment_id
  ), done AS (
    UPDATE nudge.enrollments e SET status = 'completed'
    WHERE e.id IN (SELECT enrollment_id FROM step) AND e.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM nudge.steps s
                      WHERE s.enrollment_id = e.id AND s.step_index <> $2::int
                        AND s.status IN ('pending', 'sending'))
    RETURNING e.id
  )
  SELECT count(*)::int AS updated FROM step`;

const GOAL_MET_SQL = `
  WITH step AS (
    UPDATE nudge.steps SET status = 'cancelled', outcome = '{"reason":"goal_met"}', lease_until = NULL
    WHERE ${OWNED} RETURNING enrollment_id
  ), rest AS (
    UPDATE nudge.steps SET status = 'cancelled'
    WHERE enrollment_id = $1::uuid AND status = 'pending' RETURNING 1
  ), done AS (
    UPDATE nudge.enrollments SET status = 'completed'
    WHERE id = $1::uuid AND status = 'active' RETURNING 1
  )
  SELECT count(*)::int AS updated FROM step`;

// Params: enrollment, step, attempt, due_at, outcome. A postponed step gets its attempt back.
const REQUEUE_SQL = `
  UPDATE nudge.steps SET status = 'pending', due_at = $4::timestamptz, outcome = $5::jsonb,
    attempt = attempt - $6::int, lease_until = NULL, sent_at = NULL
  WHERE ${OWNED}`;

// A reserved step carries sent_at while it is still sending, so concurrent sends count against the cap.
const RESERVE_SQL = `UPDATE nudge.steps SET sent_at = $4::timestamptz WHERE ${OWNED}`;

const PROFILE_OF_SQL = `
  SELECT project_id AS "projectId", profile_id AS "profileId"
  FROM nudge.enrollments WHERE id = $1::uuid`;

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

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { sql, cfg } = deps;
  const result: TickResult = { sent: 0, skipped: 0, postponed: 0, failed: 0 };
  const tickStart = deps.now();
  if (!lagAllowsSending(await readLagState(sql), tickStart, cfg)) {
    return result;
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

function stepLabel(claim: Claim) {
  return `step ${claim.enrollment_id}:${claim.step_index}`;
}

function createStepWriter(deps: TickDeps, claim: Claim) {
  const owned = [claim.enrollment_id, claim.step_index, claim.attempt];

  async function underProfileLock<T>(
    work: (tx: Queryable) => Promise<T>
  ): Promise<T> {
    return await deps.sql.$transaction(async (tx) => {
      const keys = await tx.$queryRawUnsafe<
        { projectId: string; profileId: string }[]
      >(PROFILE_OF_SQL, claim.enrollment_id);
      await lockProfiles(tx, keys);
      return await work(tx);
    }, MARK_TRANSACTION);
  }

  async function finish(
    status: 'sent' | 'skipped' | 'failed',
    reason: string | null,
    tx?: Queryable
  ): Promise<Outcome> {
    const run = async (db: Queryable) => {
      const [row] = await db.$queryRawUnsafe<{ updated: number }[]>(
        FINISH_SQL,
        ...owned,
        status,
        reason === null ? null : JSON.stringify({ reason }),
        status === 'sent' ? deps.now().toISOString() : null
      );
      return row?.updated ? status : 'lost';
    };
    return tx ? await run(tx) : await underProfileLock(run);
  }

  async function requeue(
    dueAt: Date,
    reason: string | null,
    giveBackAttempt: boolean
  ): Promise<Outcome> {
    const updated = await deps.sql.$executeRawUnsafe(
      REQUEUE_SQL,
      ...owned,
      dueAt.toISOString(),
      reason === null ? null : JSON.stringify({ reason }),
      giveBackAttempt ? 1 : 0
    );
    return updated ? 'postponed' : 'lost';
  }

  return {
    underProfileLock,
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
      const [row] = await underProfileLock((tx) =>
        tx.$queryRawUnsafe<{ updated: number }[]>(GOAL_MET_SQL, ...owned)
      );
      return row?.updated ? 'skipped' : 'lost';
    },
    owned,
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
  const now = deps.now();
  const quietHours = zQuietHours.parse(context.quiet_hours ?? null);
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
    const reserved = await reserveUnderCap(claim, step, {
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

  if (sendResult.ok) {
    return await step.finish('sent', null);
  }
  const reason = redactSecrets(sendResult.reason, loaded.secrets);
  console.error(LOG_PREFIX, stepLabel(claim), 'send failed:', reason);
  return sendResult.retryable
    ? await step.retry(reason)
    : await step.finish('failed', reason);
}

async function reserveUnderCap(
  claim: Claim,
  step: StepWriter,
  args: {
    projectId: string;
    profileId: string;
    channel: string;
    caps: { max: number; periodSeconds: number };
    now: Date;
  }
): Promise<Outcome | true> {
  const { projectId, profileId, channel, caps, now } = args;
  return await step.underProfileLock(async (tx): Promise<Outcome | true> => {
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
      return await step.finish('skipped', 'cap', tx);
    }
    const reserved = await tx.$executeRawUnsafe(
      RESERVE_SQL,
      ...step.owned,
      now.toISOString()
    );
    return reserved ? true : 'lost';
  });
}
