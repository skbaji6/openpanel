import { randomUUID } from 'node:crypto';
import type { Redis } from '@openpanel/redis';
import type { FilterTree } from '../audience/contract';
import {
  SourceAuthError,
  SourceBusyError,
  SourceProtocolError,
  SourceUnavailableError,
} from '../audience/errors';
import { withCampaignLane } from '../audience/lane';
import {
  type MaterializeJob,
  type MaterializeProgress,
  RestartAfterSendingError,
  runMaterialization,
} from '../audience/materialize';
import type { SourceResolver } from '../audience/resolver';
import type { AudienceSource } from '../audience/source';
import type { MarketingConfig } from '../config';
import type { Queryable, Sql } from '../engine/engine';
import { failCampaignIn } from './service';

const LEASE_MS = 60_000;
const LEASE_RENEW_MS = LEASE_MS / 3;
// About 10 minutes of renewals, so a hung source call cannot hold the lease for the life of the process.
const MAX_LEASE_RENEWALS = 30;
const LEASE_RENEW_CAP_MS = MAX_LEASE_RENEWALS * LEASE_RENEW_MS;
const RETRY_MS = 30_000;
// Bad credentials stay bad until an operator fixes them, so the campaign asks the source less often.
const AUTH_RETRY_MS = 300_000;
const MAX_ATTEMPTS = 5;
const LOG_PREFIX = 'marketing materialisation:';
const TRANSACTION = { timeout: 60_000, maxWait: 30_000 };

// Only the state the claim leaves behind matters to the dispatcher: it claims recipients
// only of campaigns with state 'running' AND materialize_state 'done', which the last page sets in its own commit.
const CLAIM = `UPDATE marketing.campaigns c SET materialize_lease_token = $2::uuid, materialize_lease_until = $3,
    materialize_state = 'in_progress', updated_at = $1
  WHERE c.id = (SELECT id FROM marketing.campaigns
    WHERE state IN ('running', 'paused') AND materialize_state IN ('not_started', 'in_progress')
      AND (materialize_retry_at IS NULL OR materialize_retry_at <= $1)
      AND (materialize_lease_until IS NULL OR materialize_lease_until <= $1)
    ORDER BY materialize_retry_at NULLS FIRST, started_at, id
    LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING c.id::text, c.project_id, c.audience_id::text, c.campaign_key, c.skip_previous_recipients,
    c.materialize_phase, c.materialize_cursor`;
const READ_AUDIENCE = `SELECT mode, filter, exclude_filter, snapshot_version
  FROM marketing.audiences WHERE id = $1::uuid`;
// The state check takes the row lock, so a cancel or fail either commits first (and this page rolls back)
// or waits for this page and then skips its rows: no pending recipient outlives a cancel.
const SAVE_PROGRESS = `UPDATE marketing.campaigns SET materialize_phase = $3, materialize_cursor = $4,
    materialize_lease_until = $5, materialize_error = NULL, updated_at = $6
  WHERE id = $1::uuid AND materialize_lease_token = $2::uuid AND state IN ('running', 'paused')`;
const MARK_DONE = `UPDATE marketing.campaigns SET materialize_state = 'done', materialize_phase = NULL,
    materialize_cursor = NULL, materialize_lease_token = NULL, materialize_lease_until = NULL,
    materialize_retry_at = NULL, materialize_error = NULL, updated_at = $3
  WHERE id = $1::uuid AND materialize_lease_token = $2::uuid AND state IN ('running', 'paused')`;
const SET_COUNTERS = `INSERT INTO marketing.campaign_counters (campaign_id, queued, skipped, updated_at)
  SELECT $1::uuid, count(*) FILTER (WHERE status = 'pending')::int,
    count(*) FILTER (WHERE status = 'skipped' AND reason = 'already_received')::int, $2
  FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid
  ON CONFLICT (campaign_id) DO UPDATE SET queued = EXCLUDED.queued,
    skipped = marketing.campaign_counters.skipped + EXCLUDED.skipped, updated_at = EXCLUDED.updated_at`;
const SOURCE_OK = `UPDATE marketing.audience_sources SET status = 'ok', status_at = $2
  WHERE project_id = $1 AND status IS DISTINCT FROM 'ok'`;
// Fenced on the token: a run that stopped hands the campaign straight to the next claimer.
const RELEASE_LEASE = `UPDATE marketing.campaigns SET materialize_lease_token = NULL, materialize_lease_until = NULL
  WHERE id = $1::uuid AND materialize_lease_token = $2::uuid`;
const RENEW_LEASE = `UPDATE marketing.campaigns SET materialize_lease_until = $3
  WHERE id = $1::uuid AND materialize_lease_token = $2::uuid`;
const IS_ACTIVE = `SELECT 1 FROM marketing.campaigns WHERE id = $1::uuid AND state IN ('running', 'paused')`;
// Releases the lease so the retry is claimable at once when due; transient source errors spend no attempt.
const RETRY_LATER = `UPDATE marketing.campaigns SET materialize_retry_at = $3, materialize_error = $4,
    materialize_attempts = materialize_attempts + $5::int,
    materialize_state = CASE WHEN materialize_attempts + $5::int >= $6::int THEN 'failed' ELSE materialize_state END,
    materialize_lease_token = NULL, materialize_lease_until = NULL, updated_at = $7
  WHERE id = $1::uuid AND materialize_lease_token = $2::uuid AND state IN ('running', 'paused')
  RETURNING materialize_state`;
const MARK_FAILED = `UPDATE marketing.campaigns SET materialize_state = 'failed', materialize_error = $3,
    materialize_lease_token = NULL, materialize_lease_until = NULL, updated_at = $4
  WHERE id = $1::uuid AND materialize_lease_token = $2::uuid`;
const SOURCE_AUTH_FAILED = `UPDATE marketing.audience_sources SET status = 'source_auth_failed', status_at = $2
  WHERE project_id = $1 AND status IS DISTINCT FROM 'source_auth_failed'`;

// A snapshot copy reads only the plugin's own tables, so it runs without an http source.
const SNAPSHOT_COPY_ONLY = new Proxy(
  {},
  {
    get: () => () =>
      Promise.reject(new Error('snapshot copy called the audience source')),
  }
) as AudienceSource;

interface Claimed {
  id: string;
  project_id: string;
  audience_id: string;
  campaign_key: string | null;
  skip_previous_recipients: boolean;
  materialize_phase: MaterializeProgress['phase'] | null;
  materialize_cursor: string | null;
}

interface ClaimedAudience {
  mode: 'dynamic' | 'snapshot';
  filter: FilterTree | null;
  exclude_filter: FilterTree | null;
  snapshot_version: number | null;
}

interface RunnerDeps {
  sql: Sql;
  sources: SourceResolver;
  redis: Redis;
  cfg: MarketingConfig;
  now: () => Date;
  // Shutdown: the run stops after the page in flight instead of finishing the whole audience.
  stopping?: () => boolean;
  leaseRenewMs?: number;
}

const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

async function buildJob(
  deps: RunnerDeps,
  claim: Claimed,
  token: string
): Promise<MaterializeJob> {
  const [audience] = await deps.sql.$queryRawUnsafe<ClaimedAudience[]>(
    READ_AUDIENCE,
    claim.audience_id
  );
  if (!audience) {
    throw new Error('campaign audience not found');
  }
  const fromSnapshot =
    audience.mode === 'snapshot' && audience.snapshot_version !== null
      ? {
          audienceId: claim.audience_id,
          snapshotVersion: audience.snapshot_version,
        }
      : null;
  return {
    jobId: claim.id,
    projectId: claim.project_id,
    audienceId: claim.audience_id,
    filter: audience.filter,
    excludeFilter: audience.exclude_filter,
    target: {
      kind: 'campaign',
      campaignId: claim.id,
      campaignKey: claim.campaign_key,
      skipPrevious: claim.skip_previous_recipients,
      fromSnapshot,
    },
    progress: claim.materialize_phase
      ? { phase: claim.materialize_phase, cursor: claim.materialize_cursor }
      : null,
    async saveProgress(tx: Queryable, next) {
      const now = deps.now();
      if (next === 'done') {
        const done = await tx.$executeRawUnsafe(
          MARK_DONE,
          claim.id,
          token,
          now
        );
        if (done === 1) {
          await tx.$executeRawUnsafe(SET_COUNTERS, claim.id, now);
          await tx.$executeRawUnsafe(SOURCE_OK, claim.project_id, now);
        }
        return done === 1;
      }
      const saved = await tx.$executeRawUnsafe(
        SAVE_PROGRESS,
        claim.id,
        token,
        next.phase,
        next.cursor,
        later(now, LEASE_MS),
        now
      );
      return saved === 1;
    },
  };
}

async function retryLater(
  deps: RunnerDeps,
  claim: Claimed,
  token: string,
  code: string,
  countsAsAttempt: boolean
): Promise<void> {
  const now = deps.now();
  const isAuth = code === 'source_auth_failed';
  const newlyAuthFailed = await deps.sql.$transaction(async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ materialize_state: string }[]>(
      RETRY_LATER,
      claim.id,
      token,
      later(now, isAuth ? AUTH_RETRY_MS : RETRY_MS),
      code,
      countsAsAttempt ? 1 : 0,
      MAX_ATTEMPTS,
      now
    );
    if (!row) {
      return false;
    }
    if (row.materialize_state === 'failed') {
      await failCampaignIn(tx, claim.id, 'materialize_failed', now);
    }
    return (
      isAuth &&
      (await tx.$executeRawUnsafe(
        SOURCE_AUTH_FAILED,
        claim.project_id,
        now
      )) === 1
    );
  }, TRANSACTION);
  if (newlyAuthFailed) {
    console.error(
      LOG_PREFIX,
      'audience source rejected the credentials, campaigns wait:',
      claim.project_id
    );
  }
}

async function failMaterialization(
  deps: RunnerDeps,
  claim: Claimed,
  token: string,
  reason: string
): Promise<void> {
  const now = deps.now();
  await deps.sql.$transaction(async (tx) => {
    const marked = await tx.$executeRawUnsafe(
      MARK_FAILED,
      claim.id,
      token,
      reason,
      now
    );
    if (marked === 1) {
      await failCampaignIn(tx, claim.id, reason, now);
    }
  }, TRANSACTION);
}

// Error text is written as a code only: upstream messages may carry anything.
function retryCode(error: unknown): string | null {
  if (
    error instanceof SourceUnavailableError ||
    error instanceof SourceBusyError
  ) {
    return 'source_unavailable';
  }
  if (error instanceof SourceAuthError) {
    return 'source_auth_failed';
  }
  if (error instanceof SourceProtocolError) {
    return 'source_protocol_error';
  }
  return null;
}

async function materialize(
  deps: RunnerDeps,
  claim: Claimed,
  token: string
): Promise<void> {
  try {
    const job = await buildJob(deps, claim, token);
    const copiesSnapshot =
      job.target.kind === 'campaign' && job.target.fromSnapshot !== null;
    const source = await deps.sources.forProject(claim.project_id);
    // A source switched to stored will not heal, so waiting would only hold the project's slot.
    if (!(source || copiesSnapshot)) {
      await failMaterialization(deps, claim, token, 'source_not_http');
      return;
    }
    const result = await runMaterialization(
      {
        sql: deps.sql,
        source: source
          ? withCampaignLane(source, {
              redis: deps.redis,
              projectId: claim.project_id,
              sourceConcurrency: deps.cfg.sourceConcurrency,
            })
          : SNAPSHOT_COPY_ONLY,
        shouldStop: async () =>
          Boolean(deps.stopping?.()) ||
          (await deps.sql.$queryRawUnsafe<unknown[]>(IS_ACTIVE, claim.id))
            .length === 0,
      },
      job
    );
    if (result.status !== 'done') {
      await deps.sql.$executeRawUnsafe(RELEASE_LEASE, claim.id, token);
    }
  } catch (error) {
    if (error instanceof RestartAfterSendingError) {
      await failMaterialization(
        deps,
        claim,
        token,
        'materialize_restart_after_sending'
      );
      return;
    }
    const code = retryCode(error);
    // Unclassified errors (a bug, the database) spend attempts like protocol errors, so they cannot loop forever.
    await retryLater(
      deps,
      claim,
      token,
      code ?? 'internal_error',
      code === null || error instanceof SourceProtocolError
    );
    if (code === null) {
      throw error;
    }
  }
}

// Renewed on a timer for the whole run: a wrapped source call (lane wait, retries, Retry-After) can outlast LEASE_MS.
function keepLease(deps: RunnerDeps, claim: Claimed, token: string) {
  const startedAt = deps.now().getTime();
  let pending = false;
  let renewing: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    if (deps.now().getTime() - startedAt >= LEASE_RENEW_CAP_MS) {
      clearInterval(timer);
      return;
    }
    if (pending) {
      return;
    }
    pending = true;
    // A failed renewal only risks a takeover, which the token fence on every write already handles.
    renewing = deps.sql
      .$executeRawUnsafe(
        RENEW_LEASE,
        claim.id,
        token,
        later(deps.now(), LEASE_MS)
      )
      .catch(() => undefined)
      .finally(() => {
        pending = false;
      });
  }, deps.leaseRenewMs ?? LEASE_RENEW_MS);
  return async () => {
    clearInterval(timer);
    await renewing;
  };
}

export async function runMaterializeTick(
  deps: RunnerDeps
): Promise<{ ran: number }> {
  const now = deps.now();
  const token = randomUUID();
  const [claim] = await deps.sql.$queryRawUnsafe<Claimed[]>(
    CLAIM,
    now,
    token,
    later(now, LEASE_MS)
  );
  if (!claim) {
    return { ran: 0 };
  }
  const stopRenewing = keepLease(deps, claim, token);
  try {
    await materialize(deps, claim, token);
  } finally {
    await stopRenewing();
  }
  return { ran: 1 };
}
