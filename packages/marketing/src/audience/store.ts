import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../api/http';
import type { Queryable, Sql } from '../engine/engine';
import {
  type FilterTree,
  MAX_ID_CONDITION_VALUES,
  type Schema,
} from './contract';
import {
  type AudienceDefinition,
  checkAudienceInput,
  MAX_LIST_IDS,
  type zAudienceInput,
  type zIdListChange,
} from './definition';
import {
  SourceAuthError,
  SourceBusyError,
  SourceProtocolError,
  SourceUnavailableError,
} from './errors';
import { runMaterialization } from './materialize';
import type { AudienceSource } from './source';

type AudienceInput = z.infer<typeof zAudienceInput>;
type IdListChange = z.infer<typeof zIdListChange>;
type IdList = IdListChange['list'];

export interface AudienceRow {
  id: string;
  projectId: string;
  name: string;
  mode: 'dynamic' | 'snapshot';
  filter: FilterTree | null;
  excludeFilter: FilterTree | null;
  includeCount: number;
  excludeCount: number;
  version: number;
  snapshotVersion: number | null;
  snapshotCount: number | null;
  snapshotAt: string | null;
  schemaCheckedAt: string | null;
  inUse: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface StoreContext {
  projectId: string;
  userId: string;
}

interface StoreDeps {
  sql: Sql;
  source: (projectId: string) => Promise<AudienceSource | null>;
  now: () => Date;
  // Freezes page the whole audience, so they go through the campaign lane and cannot starve journeys.
  laneFor?: (projectId: string, source: AudienceSource) => AudienceSource;
}

interface DbRow {
  id: string;
  project_id: string;
  name: string;
  mode: 'dynamic' | 'snapshot';
  filter: FilterTree | null;
  exclude_filter: FilterTree | null;
  include_count: number;
  exclude_count: number;
  version: number;
  snapshot_version: number | null;
  snapshot_count: number | null;
  snapshot_at: Date | null;
  schema_checked_at: Date | null;
  in_use: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface LockedRow {
  mode: 'dynamic' | 'snapshot';
  filter: FilterTree | null;
  exclude_filter: FilterTree | null;
  version: number;
  snapshot_version: number | null;
}

const TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
const SCHEMA_CHECK_TIMEOUT_MS = 2000;
const MAX_ID_PAGE = 1000;
const zAudienceId = z.uuid();

const IN_USE = `EXISTS (SELECT 1 FROM marketing.campaigns c
  WHERE c.audience_id = a.id AND c.state IN ('scheduled', 'running', 'paused'))`;
const listCount = (
  list: IdList
) => `(SELECT count(*)::int FROM marketing.audience_ids i
  WHERE i.audience_id = a.id AND i.list = '${list}')`;
const SELECT_ROWS = `SELECT a.id::text, a.project_id, a.name, a.mode, a.filter, a.exclude_filter,
  ${listCount('include')} AS include_count, ${listCount('exclude')} AS exclude_count,
  a.version, a.snapshot_version, a.snapshot_count, a.snapshot_at, a.schema_checked_at,
  ${IN_USE} AS in_use, a.created_by, a.created_at, a.updated_at
  FROM marketing.audiences a WHERE a.project_id = $1`;
const LOCK_ROW = `SELECT a.mode, a.filter, a.exclude_filter, a.version, a.snapshot_version
  FROM marketing.audiences a WHERE a.id = $1::uuid AND a.project_id = $2 FOR UPDATE`;
// A separate statement after the lock: under READ COMMITTED it sees campaigns committed while the lock was awaited.
const IN_USE_AFTER_LOCK = `SELECT ${IN_USE} AS in_use FROM marketing.audiences a WHERE a.id = $1::uuid`;
// A freeze page commits only while the definition it materialises is still the saved one.
// Serialises the page transactions of every freeze of one audience: they share the audience's staging rows.
const FREEZE_PAGE_LOCK = `SELECT pg_advisory_xact_lock(hashtext('marketing:audience-freeze:' || $1))::text AS locked`;
const DEFINITION_UNCHANGED =
  'SELECT 1 FROM marketing.audiences WHERE id = $1::uuid AND version = $2 FOR SHARE';
const ANY_CAMPAIGN =
  'SELECT 1 FROM marketing.campaigns WHERE audience_id = $1::uuid LIMIT 1';
const WIPE_STAGING =
  'DELETE FROM marketing.materialize_exclusions WHERE job_id = $1::uuid';
const DISCARD_UNFROZEN = `DELETE FROM marketing.audience_snapshot_ids s USING marketing.audiences a
  WHERE a.id = s.audience_id AND s.audience_id = $1::uuid AND s.snapshot_version = $2
  AND a.snapshot_version IS DISTINCT FROM $2`;

const toIso = (date: Date | null) => date?.toISOString() ?? null;

function toRow(row: DbRow): AudienceRow {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    mode: row.mode,
    filter: row.filter,
    excludeFilter: row.exclude_filter,
    includeCount: row.include_count,
    excludeCount: row.exclude_count,
    version: row.version,
    snapshotVersion: row.snapshot_version,
    snapshotCount: row.snapshot_count,
    snapshotAt: toIso(row.snapshot_at),
    schemaCheckedAt: toIso(row.schema_checked_at),
    inUse: row.in_use,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const isSourceError = (error: unknown) =>
  error instanceof SourceUnavailableError ||
  error instanceof SourceBusyError ||
  error instanceof SourceAuthError ||
  error instanceof SourceProtocolError;

export function sourceHttpError(error: unknown): unknown {
  if (
    error instanceof SourceUnavailableError ||
    error instanceof SourceBusyError
  ) {
    return new HttpError(503, 'source_unavailable');
  }
  if (error instanceof SourceAuthError) {
    return new HttpError(409, 'source_auth_failed');
  }
  if (error instanceof SourceProtocolError) {
    return error.message === 'snapshot_too_large'
      ? new HttpError(409, 'snapshot_too_large')
      : new HttpError(502, 'source_protocol_error');
  }
  return error;
}

function assertId(id: string) {
  if (!zAudienceId.safeParse(id).success) {
    throw new HttpError(404, 'not_found');
  }
}

export function createAudienceStore(deps: StoreDeps) {
  const { sql } = deps;

  async function fetchRow(tx: Queryable, ctx: StoreContext, id: string) {
    assertId(id);
    const [row] = await tx.$queryRawUnsafe<DbRow[]>(
      `${SELECT_ROWS} AND a.id = $2::uuid`,
      ctx.projectId,
      id
    );
    if (!row) {
      throw new HttpError(404, 'not_found');
    }
    return toRow(row);
  }

  // Holding the row lock until commit keeps the id cap and the in-use check true against concurrent edits and campaign starts.
  async function lockEditable(
    tx: Queryable,
    ctx: StoreContext,
    id: string,
    expectedVersion: number | null
  ): Promise<LockedRow> {
    assertId(id);
    const [row] = await tx.$queryRawUnsafe<LockedRow[]>(
      LOCK_ROW,
      id,
      ctx.projectId
    );
    if (!row) {
      throw new HttpError(404, 'not_found');
    }
    const [usage] = await tx.$queryRawUnsafe<{ in_use: boolean }[]>(
      IN_USE_AFTER_LOCK,
      id
    );
    if (usage?.in_use) {
      throw new HttpError(409, 'audience_in_use');
    }
    if (expectedVersion !== null && row.version !== expectedVersion) {
      throw new HttpError(409, 'version_conflict');
    }
    return row;
  }

  async function bumpVersion(tx: Queryable, id: string) {
    await tx.$executeRawUnsafe(
      'UPDATE marketing.audiences SET version = version + 1, updated_at = $2 WHERE id = $1::uuid',
      id,
      deps.now()
    );
  }

  // Saving never waits on the API: an unreachable source only downgrades the check to structural.
  async function liveSchema(projectId: string): Promise<Schema | null> {
    const source = await deps.source(projectId);
    if (!source) {
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SCHEMA_CHECK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([source.schema(), timedOut]);
    } catch (error) {
      if (isSourceError(error)) {
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkInput(projectId: string, input: AudienceInput) {
    const schema = await liveSchema(projectId);
    const checked = checkAudienceInput(input, schema);
    if (!checked.ok) {
      throw new HttpError(
        400,
        'invalid_filter',
        checked.errors.map((message) => ({ path: '', message }))
      );
    }
    return {
      filter: checked.filter,
      excludeFilter: checked.excludeFilter,
      schemaCheckedAt: schema ? deps.now() : null,
    };
  }

  const jsonOrNull = (filter: FilterTree | null) =>
    filter === null ? null : JSON.stringify(filter);

  async function switchSnapshot(
    ctx: StoreContext,
    id: string,
    version: number,
    total: number,
    beginPage: (tx: Queryable) => Promise<void>
  ) {
    return await sql.$transaction(async (tx) => {
      await beginPage(tx);
      await lockEditable(tx, ctx, id, version);
      await tx.$executeRawUnsafe(
        `UPDATE marketing.audiences SET snapshot_version = $2, snapshot_count = $3, snapshot_at = $4, updated_at = $4
         WHERE id = $1::uuid`,
        id,
        version,
        total,
        deps.now()
      );
      await tx.$executeRawUnsafe(
        'DELETE FROM marketing.audience_snapshot_ids WHERE audience_id = $1::uuid AND snapshot_version <> $2',
        id,
        version
      );
      return await fetchRow(tx, ctx, id);
    }, TRANSACTION);
  }

  async function materializeSnapshot(
    source: AudienceSource,
    ctx: StoreContext,
    id: string,
    locked: LockedRow,
    jobId: string,
    beginPage: (tx: Queryable) => Promise<void>
  ): Promise<number> {
    const result = await runMaterialization(
      { sql, source: deps.laneFor?.(ctx.projectId, source) ?? source },
      {
        jobId,
        projectId: ctx.projectId,
        audienceId: id,
        filter: locked.filter,
        excludeFilter: locked.exclude_filter,
        target: {
          kind: 'snapshot',
          audienceId: id,
          snapshotVersion: locked.version,
        },
        progress: null,
        beginPage,
        saveProgress: async (tx) =>
          (
            await tx.$queryRawUnsafe<unknown[]>(
              DEFINITION_UNCHANGED,
              id,
              locked.version
            )
          ).length === 1,
      }
    );
    if (result.status !== 'done') {
      throw new HttpError(409, 'version_conflict');
    }
    return result.total;
  }

  return {
    async create(
      ctx: StoreContext,
      input: AudienceInput
    ): Promise<AudienceRow> {
      const checked = await checkInput(ctx.projectId, input);
      const id = randomUUID();
      const now = deps.now();
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.audiences (id, project_id, name, mode, filter, exclude_filter, schema_checked_at, created_by, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $9)`,
        id,
        ctx.projectId,
        input.name,
        input.mode,
        jsonOrNull(checked.filter),
        jsonOrNull(checked.excludeFilter),
        checked.schemaCheckedAt,
        ctx.userId,
        now
      );
      return await fetchRow(sql, ctx, id);
    },

    async update(
      ctx: StoreContext,
      id: string,
      input: AudienceInput,
      expectedVersion: number
    ): Promise<AudienceRow> {
      assertId(id);
      const checked = await checkInput(ctx.projectId, input);
      return await sql.$transaction(async (tx) => {
        await lockEditable(tx, ctx, id, expectedVersion);
        await tx.$executeRawUnsafe(
          `UPDATE marketing.audiences SET name = $2, mode = $3, filter = $4::jsonb, exclude_filter = $5::jsonb,
             schema_checked_at = $6 WHERE id = $1::uuid`,
          id,
          input.name,
          input.mode,
          jsonOrNull(checked.filter),
          jsonOrNull(checked.excludeFilter),
          checked.schemaCheckedAt
        );
        await bumpVersion(tx, id);
        return await fetchRow(tx, ctx, id);
      }, TRANSACTION);
    },

    async changeIds(
      ctx: StoreContext,
      id: string,
      change: IdListChange,
      expectedVersion: number
    ): Promise<AudienceRow> {
      return await sql.$transaction(async (tx) => {
        await lockEditable(tx, ctx, id, expectedVersion);
        if (change.clear) {
          await tx.$executeRawUnsafe(
            'DELETE FROM marketing.audience_ids WHERE audience_id = $1::uuid AND list = $2',
            id,
            change.list
          );
        }
        if (change.remove?.length) {
          await tx.$executeRawUnsafe(
            'DELETE FROM marketing.audience_ids WHERE audience_id = $1::uuid AND list = $2 AND profile_id = ANY($3::text[])',
            id,
            change.list,
            change.remove
          );
        }
        if (change.add?.length) {
          await tx.$executeRawUnsafe(
            `INSERT INTO marketing.audience_ids (audience_id, list, profile_id)
             SELECT $1::uuid, $2, profile_id FROM unnest($3::text[]) AS added(profile_id) ORDER BY profile_id
             ON CONFLICT DO NOTHING`,
            id,
            change.list,
            change.add
          );
        }
        const row = await fetchRow(tx, ctx, id);
        const size =
          change.list === 'include' ? row.includeCount : row.excludeCount;
        if (size > MAX_LIST_IDS) {
          throw new HttpError(400, 'ids_limit');
        }
        await bumpVersion(tx, id);
        return await fetchRow(tx, ctx, id);
      }, TRANSACTION);
    },

    async listIds(
      ctx: StoreContext,
      id: string,
      list: IdList,
      cursor: string | null,
      limit: number
    ): Promise<{ ids: string[]; nextCursor: string | null }> {
      await fetchRow(sql, ctx, id);
      const pageSize = Math.min(
        MAX_ID_PAGE,
        Math.max(1, Math.trunc(limit) || 1)
      );
      const rows = await sql.$queryRawUnsafe<{ profile_id: string }[]>(
        `SELECT profile_id FROM marketing.audience_ids
         WHERE audience_id = $1::uuid AND list = $2 AND ($3::text IS NULL OR profile_id > $3)
         ORDER BY profile_id LIMIT $4`,
        id,
        list,
        cursor,
        pageSize + 1
      );
      const ids = rows.slice(0, pageSize).map((row) => row.profile_id);
      return {
        ids,
        nextCursor: rows.length > pageSize ? (ids.at(-1) ?? null) : null,
      };
    },

    get(ctx: StoreContext, id: string): Promise<AudienceRow> {
      return fetchRow(sql, ctx, id);
    },

    async list(ctx: StoreContext): Promise<AudienceRow[]> {
      const rows = await sql.$queryRawUnsafe<DbRow[]>(
        `${SELECT_ROWS} ORDER BY a.updated_at DESC, a.id`,
        ctx.projectId
      );
      return rows.map(toRow);
    },

    async remove(ctx: StoreContext, id: string): Promise<void> {
      await sql.$transaction(async (tx) => {
        await lockEditable(tx, ctx, id, null);
        // Campaign history keeps its audience (ON DELETE RESTRICT), so any referencing campaign blocks the delete.
        if (
          (await tx.$queryRawUnsafe<unknown[]>(ANY_CAMPAIGN, id)).length > 0
        ) {
          throw new HttpError(409, 'audience_in_use');
        }
        await tx.$executeRawUnsafe(
          'DELETE FROM marketing.audiences WHERE id = $1::uuid',
          id
        );
      }, TRANSACTION);
    },

    async freeze(
      ctx: StoreContext,
      id: string,
      // Throws when this freeze no longer holds its lock; checked at the start of every page and of the switch.
      fence?: () => Promise<void>
    ): Promise<AudienceRow> {
      const locked = await sql.$transaction(
        (tx) => lockEditable(tx, ctx, id, null),
        TRANSACTION
      );
      if (locked.mode !== 'snapshot') {
        throw new HttpError(409, 'not_snapshot');
      }
      // Re-materialising the version already frozen would first wipe the rows a campaign may be reading.
      if (locked.snapshot_version === locked.version) {
        return await fetchRow(sql, ctx, id);
      }
      const source = await deps.source(ctx.projectId);
      if (!source) {
        throw new HttpError(409, 'source_not_http');
      }
      // Keyed by the audience, so a crashed freeze's staging rows are wiped by the next freeze's fresh start.
      const jobId = id;
      let fenceLost = false;
      // Under the page lock, so a newer freeze's fresh start either ran before this check (which then fails) or waits for this page and wipes it.
      const beginPage = async (tx: Queryable) => {
        await tx.$queryRawUnsafe(FREEZE_PAGE_LOCK, id);
        try {
          await fence?.();
        } catch (error) {
          fenceLost = true;
          throw error;
        }
      };
      try {
        const total = await materializeSnapshot(
          source,
          ctx,
          id,
          locked,
          jobId,
          beginPage
        );
        return await switchSnapshot(ctx, id, locked.version, total, beginPage);
      } catch (error) {
        // The freeze that holds the lock now uses these staging and snapshot rows; its own fresh start wipes them.
        if (!fenceLost) {
          await sql.$executeRawUnsafe(WIPE_STAGING, jobId);
          await sql.$executeRawUnsafe(DISCARD_UNFROZEN, id, locked.version);
        }
        throw sourceHttpError(error);
      }
    },

    async listMembership(
      ctx: StoreContext,
      id: string,
      profileId: string
    ): Promise<{ included: boolean; excludedByList: boolean }> {
      await fetchRow(sql, ctx, id);
      const rows = await sql.$queryRawUnsafe<{ list: IdList }[]>(
        'SELECT list FROM marketing.audience_ids WHERE audience_id = $1::uuid AND profile_id = $2',
        id,
        profileId
      );
      return {
        included: rows.some((row) => row.list === 'include'),
        excludedByList: rows.some((row) => row.list === 'exclude'),
      };
    },

    // Tells "never configured" from "configured as stored"; the resolver returns null for both.
    async hasSourceRow(projectId: string): Promise<boolean> {
      const rows = await sql.$queryRawUnsafe<unknown[]>(
        'SELECT 1 FROM marketing.audience_sources WHERE project_id = $1',
        projectId
      );
      return rows.length > 0;
    },

    async definition(
      ctx: StoreContext,
      id: string
    ): Promise<AudienceDefinition & { excludeCount: number }> {
      const row = await fetchRow(sql, ctx, id);
      // Counted separately from the row, so a concurrent edit can disagree; countAudience flags that as approximate.
      const excludeIds =
        row.excludeCount > MAX_ID_CONDITION_VALUES
          ? null
          : (
              await sql.$queryRawUnsafe<{ profile_id: string }[]>(
                `SELECT profile_id FROM marketing.audience_ids
                 WHERE audience_id = $1::uuid AND list = 'exclude' ORDER BY profile_id LIMIT ${MAX_ID_CONDITION_VALUES + 1}`,
                id
              )
            ).map((entry) => entry.profile_id);
      return {
        filter: row.filter,
        excludeFilter: row.excludeFilter,
        includeCount: row.includeCount,
        excludeIds,
        excludeCount: row.excludeCount,
      };
    },
  };
}
