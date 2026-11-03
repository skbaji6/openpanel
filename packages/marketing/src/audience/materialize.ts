import { zIdentifier } from '../api/routes-sync';
import type { Queryable, Sql } from '../engine/engine';
import { type FilterTree, MAX_ID_CONDITION_VALUES } from './contract';
import { buildSourceFilter, MAX_SNAPSHOT_IDS } from './definition';
import { SourceProtocolError } from './errors';
import type { AudienceSource } from './source';

const DEFAULT_PAGE_SIZE = 1000;
// The 20,000-id include list goes in one statement, which can outlast Prisma's 5 s default.
const PAGE_TRANSACTION = { timeout: 60_000, maxWait: 30_000 };

export type MaterializePhase =
  | 'exclusions'
  | 'members'
  | 'includes'
  | 'snapshot_copy';

export interface MaterializeProgress {
  phase: MaterializePhase;
  cursor: string | null;
}

export type MaterializeTarget =
  | {
      kind: 'campaign';
      campaignId: string;
      campaignKey: string | null;
      skipPrevious: boolean;
      fromSnapshot: { audienceId: string; snapshotVersion: number } | null;
    }
  | { kind: 'snapshot'; audienceId: string; snapshotVersion: number };

export interface MaterializeJob {
  jobId: string;
  projectId: string;
  audienceId: string;
  filter: FilterTree | null;
  excludeFilter: FilterTree | null;
  target: MaterializeTarget;
  // null, or exclusions with a null cursor, is a fresh start: the target and staging rows of earlier attempts are wiped.
  progress: MaterializeProgress | null;
  saveProgress(
    tx: Queryable,
    next: MaterializeProgress | 'done',
    inserted: number
  ): Promise<boolean>;
}

export type MaterializeResult =
  | { status: 'done'; total: number }
  | { status: 'stopped' }
  | { status: 'lost_claim' };

interface MaterializeDeps {
  sql: Sql;
  source: AudienceSource;
  pageSize?: number;
  shouldStop?: () => Promise<boolean>;
}

class LostClaim extends Error {}
class SnapshotTooLarge extends Error {}

const FRESH_START: MaterializeProgress = { phase: 'exclusions', cursor: null };

const WIPE_STAGING =
  'DELETE FROM marketing.materialize_exclusions WHERE job_id = $1::uuid';
const STAGE_EXCLUDE_LIST = `INSERT INTO marketing.materialize_exclusions (job_id, profile_id)
  SELECT $1::uuid, profile_id FROM marketing.audience_ids
  WHERE audience_id = $2::uuid AND list = 'exclude' ORDER BY profile_id
  ON CONFLICT DO NOTHING`;
const STAGE_PAGE = `INSERT INTO marketing.materialize_exclusions (job_id, profile_id)
  SELECT $1::uuid, id FROM unnest($2::text[]) AS page(id) ORDER BY id
  ON CONFLICT DO NOTHING`;
const PUSHABLE_EXCLUDES = `SELECT profile_id FROM marketing.materialize_exclusions
  WHERE job_id = $1::uuid ORDER BY profile_id LIMIT ${MAX_ID_CONDITION_VALUES + 1}`;

// Candidate sets: each yields column id and takes exactly $1 and $2, so writers number theirs from $3.
const PAGE_MINUS_EXCLUSIONS = `SELECT DISTINCT id FROM unnest($1::text[]) AS page(id)
  WHERE NOT EXISTS (SELECT 1 FROM marketing.materialize_exclusions e WHERE e.job_id = $2::uuid AND e.profile_id = page.id)`;
const INCLUDES_MINUS_EXCLUSIONS = `SELECT profile_id AS id FROM marketing.audience_ids i
  WHERE i.audience_id = $1::uuid AND i.list = 'include'
  AND NOT EXISTS (SELECT 1 FROM marketing.materialize_exclusions e WHERE e.job_id = $2::uuid AND e.profile_id = i.profile_id)`;
const SNAPSHOT_IDS = `SELECT profile_id AS id FROM marketing.audience_snapshot_ids
  WHERE audience_id = $1::uuid AND snapshot_version = $2::int`;

// Sorted inserts keep two concurrent runs of one job from deadlocking on each other's rows.
const insertRecipients = (candidates: string) => `
  INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status, reason)
  SELECT $3::uuid, c.id, $4::text,
    CASE WHEN c.received THEN 'skipped' ELSE 'pending' END,
    CASE WHEN c.received THEN 'already_received' END
  FROM (
    SELECT candidate.id, $5::boolean AND EXISTS (
      SELECT 1 FROM marketing.campaigns earlier
      JOIN marketing.campaign_recipients r ON r.campaign_id = earlier.id AND r.profile_id = candidate.id
      WHERE earlier.project_id = $4::text AND earlier.campaign_key = $6::text AND earlier.id <> $3::uuid
        AND r.status IN ('sent', 'uncertain')
    ) AS received
    FROM (${candidates}) AS candidate
  ) AS c
  ORDER BY c.id
  ON CONFLICT DO NOTHING`;
const insertSnapshotIds = (candidates: string) => `
  INSERT INTO marketing.audience_snapshot_ids (audience_id, snapshot_version, profile_id)
  SELECT $3::uuid, $4::int, c.id FROM (${candidates}) AS c ORDER BY c.id
  ON CONFLICT DO NOTHING`;

function writeCandidates(
  tx: Queryable,
  job: MaterializeJob,
  candidates: string,
  params: [unknown, unknown]
): Promise<number> {
  const { target } = job;
  if (target.kind === 'snapshot') {
    return tx.$executeRawUnsafe(
      insertSnapshotIds(candidates),
      ...params,
      target.audienceId,
      target.snapshotVersion
    );
  }
  return tx.$executeRawUnsafe(
    insertRecipients(candidates),
    ...params,
    target.campaignId,
    job.projectId,
    target.skipPrevious,
    target.campaignKey
  );
}

const SENDING_STARTED = `SELECT 1 FROM marketing.campaign_recipients
  WHERE campaign_id = $1::uuid AND status IN ('sending', 'sent', 'uncertain') LIMIT 1`;

// A restart rebuilds the target, so rows of an earlier attempt cannot outlive a definition change.
async function clearTarget(
  tx: Queryable,
  target: MaterializeTarget
): Promise<void> {
  if (target.kind === 'snapshot') {
    await tx.$executeRawUnsafe(
      'DELETE FROM marketing.audience_snapshot_ids WHERE audience_id = $1::uuid AND snapshot_version = $2::int',
      target.audienceId,
      target.snapshotVersion
    );
    return;
  }
  const started = await tx.$queryRawUnsafe<unknown[]>(
    SENDING_STARTED,
    target.campaignId
  );
  if (started.length > 0) {
    throw new Error('materialisation restart after sending began');
  }
  await tx.$executeRawUnsafe(
    'DELETE FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid',
    target.campaignId
  );
}

async function countTarget(
  tx: Queryable,
  target: MaterializeTarget
): Promise<number> {
  const [row] =
    target.kind === 'snapshot'
      ? await tx.$queryRawUnsafe<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM marketing.audience_snapshot_ids WHERE audience_id = $1::uuid AND snapshot_version = $2::int',
          target.audienceId,
          target.snapshotVersion
        )
      : await tx.$queryRawUnsafe<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid',
          target.campaignId
        );
  return row?.n ?? 0;
}

export async function runMaterialization(
  deps: MaterializeDeps,
  job: MaterializeJob
): Promise<MaterializeResult> {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const { target } = job;
  const fromSnapshot = target.kind === 'campaign' ? target.fromSnapshot : null;
  const afterExclusions: MaterializeProgress = {
    phase: job.filter ? 'members' : 'includes',
    cursor: null,
  };
  let pushableExcludes: string[] | null | undefined;
  let total = 0;

  // Inserts, the cap check and the claim check commit together or not at all.
  function commit(
    next: MaterializeProgress | 'done',
    write: (tx: Queryable) => Promise<number>
  ): Promise<void> {
    return deps.sql.$transaction(async (tx) => {
      const inserted = await write(tx);
      const overCap =
        target.kind === 'snapshot' &&
        inserted > 0 &&
        (await countTarget(tx, target)) > MAX_SNAPSHOT_IDS;
      if (overCap) {
        throw new SnapshotTooLarge();
      }
      if (next === 'done') {
        await tx.$executeRawUnsafe(WIPE_STAGING, job.jobId);
        total = await countTarget(tx, target);
      }
      if (!(await job.saveProgress(tx, next, inserted))) {
        throw new LostClaim();
      }
    }, PAGE_TRANSACTION);
  }

  // Per stream: the exclude filter and the filter page through different id sequences.
  const seenCursors = {
    exclusions: new Set<string>(),
    members: new Set<string>(),
  };

  async function fetchPage(
    filter: FilterTree,
    cursor: string | null,
    seen: Set<string>
  ) {
    if (cursor !== null) {
      seen.add(cursor);
    }
    const page = await deps.source.members({
      filter,
      ...(cursor === null ? {} : { cursor }),
      limit: pageSize,
      fields: 'id',
    });
    if (page.nextCursor !== null && seen.has(page.nextCursor)) {
      throw new SourceProtocolError('cursor_not_advancing');
    }
    const ids = page.members.map((member) => member.id);
    if (!ids.every((id) => zIdentifier.safeParse(id).success)) {
      throw new SourceProtocolError('invalid_member_id');
    }
    return { ids, nextCursor: page.nextCursor };
  }

  // Staging is fixed once the exclusions phase ends, so one read serves every members page.
  async function loadPushableExcludes(): Promise<string[] | null> {
    if (pushableExcludes === undefined) {
      const rows = await deps.sql.$queryRawUnsafe<{ profile_id: string }[]>(
        PUSHABLE_EXCLUDES,
        job.jobId
      );
      pushableExcludes =
        rows.length <= MAX_ID_CONDITION_VALUES
          ? rows.map((row) => row.profile_id)
          : null;
    }
    return pushableExcludes;
  }

  async function exclusionsStep(
    cursor: string | null
  ): Promise<MaterializeProgress> {
    const page = job.excludeFilter
      ? await fetchPage(job.excludeFilter, cursor, seenCursors.exclusions)
      : null;
    const next: MaterializeProgress = page?.nextCursor
      ? { phase: 'exclusions', cursor: page.nextCursor }
      : afterExclusions;
    await commit(next, async (tx) => {
      if (cursor === null) {
        await clearTarget(tx, target);
        await tx.$executeRawUnsafe(WIPE_STAGING, job.jobId);
        await tx.$executeRawUnsafe(
          STAGE_EXCLUDE_LIST,
          job.jobId,
          job.audienceId
        );
      }
      if (page) {
        await tx.$executeRawUnsafe(STAGE_PAGE, job.jobId, page.ids);
      }
      return 0;
    });
    return next;
  }

  async function membersStep(
    cursor: string | null
  ): Promise<MaterializeProgress> {
    if (!job.filter) {
      throw new Error('members phase without a filter');
    }
    const { filter } = buildSourceFilter(
      job.filter,
      await loadPushableExcludes()
    );
    const page = await fetchPage(filter, cursor, seenCursors.members);
    const next: MaterializeProgress = page.nextCursor
      ? { phase: 'members', cursor: page.nextCursor }
      : { phase: 'includes', cursor: null };
    await commit(next, (tx) =>
      writeCandidates(tx, job, PAGE_MINUS_EXCLUSIONS, [page.ids, job.jobId])
    );
    return next;
  }

  async function step(
    progress: MaterializeProgress
  ): Promise<MaterializeProgress | 'done'> {
    switch (progress.phase) {
      case 'exclusions':
        return await exclusionsStep(progress.cursor);
      case 'members':
        return await membersStep(progress.cursor);
      case 'includes':
        await commit('done', (tx) =>
          writeCandidates(tx, job, INCLUDES_MINUS_EXCLUSIONS, [
            job.audienceId,
            job.jobId,
          ])
        );
        return 'done';
      case 'snapshot_copy': {
        if (!fromSnapshot) {
          throw new Error('snapshot_copy phase without a snapshot');
        }
        await commit('done', async (tx) => {
          await clearTarget(tx, target);
          return await writeCandidates(tx, job, SNAPSHOT_IDS, [
            fromSnapshot.audienceId,
            fromSnapshot.snapshotVersion,
          ]);
        });
        return 'done';
      }
      default:
        throw new Error('unknown materialize phase');
    }
  }

  // An oversized snapshot leaves no rows at its version and no staging, and the job restarts fresh.
  async function discardSnapshot(): Promise<void> {
    if (target.kind !== 'snapshot') {
      return;
    }
    await deps.sql.$transaction(async (tx) => {
      await clearTarget(tx, target);
      await tx.$executeRawUnsafe(WIPE_STAGING, job.jobId);
      if (!(await job.saveProgress(tx, FRESH_START, 0))) {
        throw new LostClaim();
      }
    }, PAGE_TRANSACTION);
  }

  let progress: MaterializeProgress =
    job.progress ??
    (fromSnapshot ? { phase: 'snapshot_copy', cursor: null } : FRESH_START);
  try {
    for (;;) {
      const next = await step(progress);
      if (next === 'done') {
        return { status: 'done', total };
      }
      progress = next;
      if (await deps.shouldStop?.()) {
        return { status: 'stopped' };
      }
    }
  } catch (error) {
    if (error instanceof SnapshotTooLarge) {
      try {
        await discardSnapshot();
      } catch (cleanupError) {
        if (cleanupError instanceof LostClaim) {
          return { status: 'lost_claim' };
        }
        throw cleanupError;
      }
      throw new SourceProtocolError('snapshot_too_large');
    }
    if (error instanceof LostClaim) {
      return { status: 'lost_claim' };
    }
    throw error;
  }
}
