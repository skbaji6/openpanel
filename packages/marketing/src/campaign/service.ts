import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../api/http';
import { zIdentifier } from '../api/routes-sync';
import { type AudienceCount, countAudience } from '../audience/builder';
import type { FilterTree } from '../audience/contract';
import { checkAudienceInput } from '../audience/definition';
import type { AudienceSource } from '../audience/source';
import { type createAudienceStore, sourceHttpError } from '../audience/store';
import { getChannelSettings, PROVIDER_CHANNELS } from '../channels/settings';
import type { MarketingConfig } from '../config';
import type { Queryable, Sql } from '../engine/engine';
import {
  type CampaignDraft,
  type CampaignPatch,
  zCampaignFields,
} from './definition';
import { daysNeeded, remainingQuota } from './pacing';
import { zonedTimeToUtc } from './schedule-time';
import {
  type CampaignAction,
  type CampaignState,
  fromStates,
  nextState,
  TERMINAL_STATES,
} from './state';

const TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
const MS_PER_MINUTE = 60_000;
const PREVIEW_TTL_MS = 15 * MS_PER_MINUTE;
const TEST_SEND_WINDOW_MS = 60 * MS_PER_MINUTE;
const MAX_TEST_SENDS_PER_WINDOW = 10;
const UNIQUE_VIOLATION = '23505';
const ONE_ACTIVE_KEY = 'Key (project_id)=';
const TERMINAL = new Set<CampaignState>(TERMINAL_STATES);
const PREVIEWABLE = new Set<CampaignState>(['draft', 'scheduled']);
const zCampaignId = z.uuid();

interface Counters {
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  uncertain: number;
}

interface CountPreview extends AudienceCount {
  campaignVersion: number;
  audienceVersion: number;
}

export interface CampaignRow {
  id: string;
  projectId: string;
  name: string;
  state: CampaignState;
  stateReason: string | null;
  channel: CampaignDraft['channel'];
  template: unknown;
  audienceId: string | null;
  audienceVersion: number | null;
  campaignKey: string | null;
  skipPreviousRecipients: boolean;
  sendKind: 'now' | 'scheduled' | null;
  sendAt: string | null;
  sendAtLocal: string | null;
  timezone: string;
  ifLateMinutes: number;
  quietHoursOverride: unknown;
  frequencyCap: unknown;
  confirmThreshold: number;
  countPreview: CountPreview | null;
  materializeState: 'not_started' | 'in_progress' | 'done' | 'failed';
  materializePhase: string | null;
  materializeCursor: string | null;
  materializeLeaseToken: string | null;
  materializeLeaseUntil: string | null;
  materializeRetryAt: string | null;
  materializeError: string | null;
  materializeAttempts: number;
  templateVersion: number | null;
  dispatchError: string | null;
  dispatchRetryAt: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counters: Counters;
}

interface CampaignContext {
  projectId: string;
  userId: string;
}

export interface Confirmation {
  count: number;
  channel: string;
  spreadOverDays?: boolean;
}

interface CampaignDeps {
  sql: Sql;
  cfg: MarketingConfig;
  audiences: ReturnType<typeof createAudienceStore>;
  source: (projectId: string) => Promise<AudienceSource | null>;
  now: () => Date;
  channelReady?: (
    projectId: string,
    channel: string,
    template: unknown
  ) => Promise<string | null>;
  pinTemplate?: (
    tx: Queryable,
    projectId: string,
    channel: string,
    template: unknown
  ) => Promise<number | null>;
}

interface LockedAudience {
  mode: 'dynamic' | 'snapshot';
  filter: FilterTree | null;
  exclude_filter: FilterTree | null;
  version: number;
  snapshot_version: number | null;
}

const SELECT_ROWS = `SELECT c.id::text, c.project_id, c.name, c.state, c.state_reason, c.channel, c.template,
  c.audience_id::text, c.audience_version, c.campaign_key, c.skip_previous_recipients, c.send_kind, c.send_at,
  c.send_at_local, c.timezone, c.if_late_minutes, c.quiet_hours_override, c.frequency_cap, c.confirm_threshold,
  c.count_preview, c.materialize_state, c.materialize_phase, c.materialize_cursor,
  c.materialize_lease_token::text, c.materialize_lease_until, c.materialize_retry_at, c.materialize_error,
  c.materialize_attempts, c.template_version, c.dispatch_error, c.dispatch_retry_at, c.version, c.created_by, c.created_at, c.updated_at, c.started_at, c.finished_at,
  json_build_object('queued', COALESCE(n.queued, 0), 'sent', COALESCE(n.sent, 0), 'failed', COALESCE(n.failed, 0),
    'skipped', COALESCE(n.skipped, 0), 'uncertain', COALESCE(n.uncertain, 0)) AS counters
  FROM marketing.campaigns c LEFT JOIN marketing.campaign_counters n ON n.campaign_id = c.id
  WHERE c.project_id = $1`;
const LOCK_CAMPAIGN = `SELECT state, version FROM marketing.campaigns
  WHERE id = $1::uuid AND project_id = $2 FOR UPDATE`;
const LOCK_AUDIENCE =
  'SELECT 1 FROM marketing.audiences WHERE id = $1::uuid AND project_id = $2 FOR UPDATE';
// Read after the lock in its own statement, so it sees an edit committed while the lock was awaited.
const READ_AUDIENCE = `SELECT mode, filter, exclude_filter, version, snapshot_version
  FROM marketing.audiences WHERE id = $1::uuid AND project_id = $2`;
const SKIP_UNSENT_RECIPIENTS = `WITH skipped AS (
    UPDATE marketing.campaign_recipients SET status = 'skipped', reason = $3, lease_token = NULL, lease_until = NULL, updated_at = $2
    WHERE campaign_id = $1::uuid AND status IN ('pending', 'leased') RETURNING 1
  )
  INSERT INTO marketing.campaign_counters (campaign_id, skipped, updated_at)
  SELECT $1::uuid, count(*)::int, $2 FROM skipped
  ON CONFLICT (campaign_id) DO UPDATE
  SET skipped = marketing.campaign_counters.skipped + EXCLUDED.skipped, updated_at = EXCLUDED.updated_at`;
// The materialiser stages exclusions under the campaign id; no foreign key removes them.
const WIPE_STAGING =
  'DELETE FROM marketing.materialize_exclusions WHERE job_id = $1::uuid';
const COMPLETE_IF_DONE = `UPDATE marketing.campaigns c SET state = 'completed', finished_at = $2, updated_at = $2
  WHERE c.id = $1::uuid AND c.state = ANY($3::text[]) AND c.materialize_state = 'done'
  AND NOT EXISTS (SELECT 1 FROM marketing.campaign_recipients r
    WHERE r.campaign_id = c.id AND r.status IN ('pending', 'leased', 'sending'))`;

const camelCase = (key: string) =>
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

function toRow(row: Record<string, unknown>): CampaignRow {
  const entries = Object.entries(row).map(([key, value]) => [
    camelCase(key),
    value instanceof Date ? value.toISOString() : value,
  ]);
  const campaign = Object.fromEntries(entries) as CampaignRow;
  // The dispatcher stamps the retry time on every claim to rotate campaigns; only an error means it is waiting.
  if (!campaign.dispatchError) {
    campaign.dispatchRetryAt = null;
  }
  return campaign;
}

// Prisma's raw errors drop the constraint name; the detail names the key, and only the one-active index is keyed on project_id alone.
export function isOneActiveViolation(error: unknown): boolean {
  const meta = (error as { meta?: { code?: string; message?: string } } | null)
    ?.meta;
  return (
    meta?.code === UNIQUE_VIOLATION &&
    (meta.message ?? '').startsWith(ONE_ACTIVE_KEY)
  );
}

async function endUnsentRecipients(
  tx: Queryable,
  campaignId: string,
  now: Date,
  reason: string
): Promise<void> {
  await tx.$executeRawUnsafe(SKIP_UNSENT_RECIPIENTS, campaignId, now, reason);
  await tx.$executeRawUnsafe(WIPE_STAGING, campaignId);
}

// Takes the caller's transaction, so a runner can record its own state in the same commit.
export async function failCampaignIn(
  tx: Queryable,
  campaignId: string,
  reason: string,
  now: Date
): Promise<void> {
  const failed = await tx.$executeRawUnsafe(
    `UPDATE marketing.campaigns SET state = 'failed', state_reason = $2, finished_at = $3, updated_at = $3
     WHERE id = $1::uuid AND state = ANY($4::text[])`,
    campaignId,
    reason,
    now,
    fromStates('fail')
  );
  if (failed === 1) {
    await endUnsentRecipients(tx, campaignId, now, 'failed');
  }
}

function assertId(id: string) {
  if (!zCampaignId.safeParse(id).success) {
    throw new HttpError(404, 'not_found');
  }
}

function parseDraft(input: unknown) {
  const parsed = zCampaignFields.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_campaign',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }))
    );
  }
  return parsed.data;
}

const defaultChannelReady = async (_projectId: string, channel: string) =>
  PROVIDER_CHANNELS.has(channel) ? 'channel_not_ready' : null;

export function createCampaignService(deps: CampaignDeps) {
  const { sql } = deps;
  const channelReady = deps.channelReady ?? defaultChannelReady;

  async function fetchRow(
    db: Queryable,
    ctx: CampaignContext,
    id: string
  ): Promise<CampaignRow> {
    assertId(id);
    const [row] = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `${SELECT_ROWS} AND c.id = $2::uuid`,
      ctx.projectId,
      id
    );
    if (!row) {
      throw new HttpError(404, 'not_found');
    }
    return toRow(row);
  }

  async function lockCampaign(db: Queryable, ctx: CampaignContext, id: string) {
    assertId(id);
    const [row] = await db.$queryRawUnsafe<
      { state: CampaignState; version: number }[]
    >(LOCK_CAMPAIGN, id, ctx.projectId);
    if (!row) {
      throw new HttpError(404, 'not_found');
    }
    return row;
  }

  async function assertAudienceInProject(
    db: Queryable,
    ctx: CampaignContext,
    audienceId: string | null | undefined
  ) {
    if (!audienceId) {
      return;
    }
    const found = await db.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM marketing.audiences WHERE id = $1::uuid AND project_id = $2',
      audienceId,
      ctx.projectId
    );
    if (found.length === 0) {
      throw new HttpError(400, 'invalid_audience');
    }
  }

  // One fenced update per transition: a concurrent change of state makes it match nothing.
  async function transition(
    db: Queryable,
    ctx: CampaignContext,
    id: string,
    action: CampaignAction,
    set: Record<string, unknown> = {},
    to?: CampaignState
  ) {
    assertId(id);
    const from = fromStates(action);
    const targets = new Set(from.map((state) => nextState(state, action)));
    if (targets.size !== 1) {
      throw new Error(`action ${action} has no single target state`);
    }
    const target = to ?? nextState(from[0] as CampaignState, action);
    const columns = Object.keys(set);
    const assignments = columns
      .map((column, i) => `, ${column} = $${i + 6}`)
      .join('');
    const updated = await db.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET state = $3, updated_at = $4${assignments}
       WHERE id = $1::uuid AND project_id = $2 AND state = ANY($5::text[])`,
      id,
      ctx.projectId,
      target,
      deps.now(),
      from,
      ...Object.values(set)
    );
    if (updated === 0) {
      await fetchRow(db, ctx, id);
      throw new HttpError(409, 'invalid_transition');
    }
  }

  async function sourceFor(projectId: string) {
    const source = await deps.source(projectId);
    if (!source) {
      throw new HttpError(409, 'source_not_http');
    }
    return source;
  }

  async function checkFilters(projectId: string, audience: LockedAudience) {
    if (!(audience.filter || audience.exclude_filter)) {
      return;
    }
    const source = await sourceFor(projectId);
    const schema = await source.schema().catch((error: unknown) => {
      throw sourceHttpError(error);
    });
    const checked = checkAudienceInput(
      {
        name: '',
        mode: audience.mode,
        filter: audience.filter,
        excludeFilter: audience.exclude_filter,
      },
      schema
    );
    if (!checked.ok) {
      throw new HttpError(
        409,
        'invalid_filter',
        checked.errors.map((message) => ({ path: '', message }))
      );
    }
  }

  function checkPreview(
    campaign: CampaignRow,
    audience: LockedAudience,
    confirm: Confirmation | undefined
  ) {
    const preview = campaign.countPreview;
    const isFresh =
      preview !== null &&
      preview.campaignVersion === campaign.version &&
      preview.audienceVersion === audience.version &&
      deps.now().getTime() - Date.parse(preview.countedAt) <= PREVIEW_TTL_MS;
    if (!(preview && isFresh)) {
      throw new HttpError(409, 'count_preview_required');
    }
    const needsConfirm = preview.count > campaign.confirmThreshold;
    if (needsConfirm && !confirm) {
      throw new HttpError(409, 'confirmation_required', undefined, {
        count: preview.count,
        channel: campaign.channel,
      });
    }
    const mismatched =
      confirm !== undefined &&
      (confirm.count !== preview.count || confirm.channel !== campaign.channel);
    if (mismatched) {
      throw new HttpError(409, 'confirmation_mismatch');
    }
  }

  async function checkQuota(
    tx: Queryable,
    ctx: CampaignContext,
    campaign: CampaignRow,
    confirm: Confirmation | undefined
  ) {
    const count = campaign.countPreview?.count ?? 0;
    if (campaign.channel !== 'email' || confirm?.spreadOverDays === true) {
      return;
    }
    const { settings } = await getChannelSettings(tx, ctx.projectId, 'email');
    if (settings.dailyQuota === null) {
      return;
    }
    const remainingToday = await remainingQuota(tx, {
      projectId: ctx.projectId,
      channel: 'email',
      dailyQuota: settings.dailyQuota,
      quotaTimezone: settings.quotaTimezone,
      now: deps.now(),
    });
    if (count > remainingToday) {
      throw new HttpError(409, 'quota_spread_required', undefined, {
        count,
        remainingToday,
        daysNeeded: daysNeeded(count, remainingToday, settings.dailyQuota),
      });
    }
  }

  // Holds the campaign and audience row locks until commit, so neither can change between the gates and the transition.
  async function passGates(
    tx: Queryable,
    ctx: CampaignContext,
    id: string,
    action: CampaignAction,
    confirm: Confirmation | undefined,
    checkCampaign?: (campaign: CampaignRow) => void
  ): Promise<{ campaign: CampaignRow; audience: LockedAudience }> {
    const locked = await lockCampaign(tx, ctx, id);
    if (!nextState(locked.state, action)) {
      throw new HttpError(409, 'invalid_transition');
    }
    const campaign = await fetchRow(tx, ctx, id);
    if (!campaign.audienceId) {
      throw new HttpError(409, 'missing_audience');
    }
    checkCampaign?.(campaign);
    await tx.$queryRawUnsafe(LOCK_AUDIENCE, campaign.audienceId, ctx.projectId);
    const [audience] = await tx.$queryRawUnsafe<LockedAudience[]>(
      READ_AUDIENCE,
      campaign.audienceId,
      ctx.projectId
    );
    if (!audience) {
      throw new HttpError(409, 'missing_audience');
    }
    const snapshotStale =
      audience.mode === 'snapshot' &&
      audience.snapshot_version !== audience.version;
    if (snapshotStale) {
      throw new HttpError(409, 'audience_snapshot_stale');
    }
    await checkFilters(ctx.projectId, audience);
    const notReady = await channelReady(
      ctx.projectId,
      campaign.channel,
      campaign.template
    );
    if (notReady) {
      throw new HttpError(409, notReady);
    }
    checkPreview(campaign, audience, confirm);
    await checkQuota(tx, ctx, campaign, confirm);
    return { campaign, audience };
  }

  async function pinVersion(
    tx: Queryable,
    ctx: CampaignContext,
    campaign: CampaignRow
  ) {
    if (!deps.pinTemplate) {
      return;
    }
    const version = await deps.pinTemplate(
      tx,
      ctx.projectId,
      campaign.channel,
      campaign.template
    );
    if (version === null) {
      // The gate passed, so the template changed since; the hook names how.
      const code = await channelReady(
        ctx.projectId,
        campaign.channel,
        campaign.template
      );
      throw new HttpError(409, code ?? 'template_unavailable');
    }
    await tx.$executeRawUnsafe(
      'UPDATE marketing.campaigns SET template_version = $2 WHERE id = $1::uuid',
      campaign.id,
      version
    );
  }

  async function startNow(
    tx: Queryable,
    ctx: CampaignContext,
    campaign: CampaignRow,
    audienceVersion: number
  ) {
    const { id } = campaign;
    const now = deps.now();
    // The one-active index aborts the statement; the savepoint keeps the transaction usable for the queued path.
    await tx.$executeRawUnsafe('SAVEPOINT campaign_start');
    try {
      await transition(tx, ctx, id, 'start', {
        send_kind: 'now',
        send_at: now,
        started_at: now,
        audience_version: audienceVersion,
        materialize_state: 'not_started',
      });
    } catch (error) {
      if (!isOneActiveViolation(error)) {
        throw error;
      }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT campaign_start');
      await transition(
        tx,
        ctx,
        id,
        'start',
        { send_kind: 'now', send_at: now },
        'scheduled'
      );
      return;
    }
    await pinVersion(tx, ctx, campaign);
    await tx.$executeRawUnsafe(
      'INSERT INTO marketing.campaign_counters (campaign_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING',
      id
    );
  }

  async function simpleTransition(
    ctx: CampaignContext,
    id: string,
    action: CampaignAction,
    set: Record<string, unknown> = {}
  ): Promise<CampaignRow> {
    await transition(sql, ctx, id, action, set);
    return await fetchRow(sql, ctx, id);
  }

  return {
    async create(
      ctx: CampaignContext,
      draft: CampaignDraft
    ): Promise<CampaignRow> {
      const parsed = parseDraft(draft);
      await assertAudienceInProject(sql, ctx, parsed.audienceId);
      const id = randomUUID();
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, campaign_key,
           skip_previous_recipients, send_at_local, timezone, if_late_minutes, quiet_hours_override, frequency_cap,
           confirm_threshold, created_by, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, 'draft', $4, $5::jsonb, $6::uuid, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
           $14, $15, $16, $16)`,
        id,
        ctx.projectId,
        parsed.name,
        parsed.channel,
        JSON.stringify(parsed.template),
        parsed.audienceId ?? null,
        parsed.campaignKey ?? null,
        parsed.skipPreviousRecipients ?? false,
        parsed.sendAtLocal ?? null,
        parsed.timezone,
        parsed.ifLateMinutes,
        JSON.stringify(parsed.quietHoursOverride ?? null),
        JSON.stringify(parsed.frequencyCap ?? null),
        deps.cfg.confirmThreshold,
        ctx.userId,
        deps.now()
      );
      return await fetchRow(sql, ctx, id);
    },

    async update(
      ctx: CampaignContext,
      id: string,
      patch: CampaignPatch,
      expectedVersion: number
    ): Promise<CampaignRow> {
      return await sql.$transaction(async (tx) => {
        const locked = await lockCampaign(tx, ctx, id);
        if (locked.state !== 'draft') {
          throw new HttpError(409, 'not_draft');
        }
        if (locked.version !== expectedVersion) {
          throw new HttpError(409, 'version_conflict');
        }
        const current = await fetchRow(tx, ctx, id);
        const parsed = parseDraft({ ...current, ...patch });
        await assertAudienceInProject(tx, ctx, parsed.audienceId);
        await tx.$executeRawUnsafe(
          `UPDATE marketing.campaigns SET name = $2, channel = $3, template = $4::jsonb, audience_id = $5::uuid,
             campaign_key = $6, skip_previous_recipients = $7, send_at_local = $8, timezone = $9,
             if_late_minutes = $10, quiet_hours_override = $11::jsonb, frequency_cap = $12::jsonb,
             version = version + 1, updated_at = $13
           WHERE id = $1::uuid`,
          id,
          parsed.name,
          parsed.channel,
          JSON.stringify(parsed.template),
          parsed.audienceId ?? null,
          parsed.campaignKey ?? null,
          parsed.skipPreviousRecipients ?? false,
          parsed.sendAtLocal ?? null,
          parsed.timezone,
          parsed.ifLateMinutes,
          JSON.stringify(parsed.quietHoursOverride ?? null),
          JSON.stringify(parsed.frequencyCap ?? null),
          deps.now()
        );
        return await fetchRow(tx, ctx, id);
      }, TRANSACTION);
    },

    get(ctx: CampaignContext, id: string): Promise<CampaignRow> {
      return fetchRow(sql, ctx, id);
    },

    async list(ctx: CampaignContext): Promise<CampaignRow[]> {
      const rows = await sql.$queryRawUnsafe<Record<string, unknown>[]>(
        `${SELECT_ROWS} ORDER BY c.created_at DESC, c.id`,
        ctx.projectId
      );
      return rows.map(toRow);
    },

    async remove(ctx: CampaignContext, id: string): Promise<void> {
      assertId(id);
      const deleted = await sql.$executeRawUnsafe(
        `DELETE FROM marketing.campaigns WHERE id = $1::uuid AND project_id = $2 AND state = 'draft'`,
        id,
        ctx.projectId
      );
      if (deleted === 0) {
        await fetchRow(sql, ctx, id);
        throw new HttpError(409, 'not_draft');
      }
    },

    async countPreview(
      ctx: CampaignContext,
      id: string
    ): Promise<AudienceCount> {
      const campaign = await fetchRow(sql, ctx, id);
      if (!PREVIEWABLE.has(campaign.state)) {
        throw new HttpError(409, 'invalid_transition');
      }
      if (!campaign.audienceId) {
        throw new HttpError(409, 'missing_audience');
      }
      const audience = await deps.audiences.get(ctx, campaign.audienceId);
      let count: AudienceCount;
      if (audience.mode === 'snapshot') {
        if (audience.snapshotVersion !== audience.version) {
          throw new HttpError(409, 'audience_snapshot_stale');
        }
        count = {
          count: audience.snapshotCount ?? 0,
          approximate: false,
          countedAt: deps.now().toISOString(),
          filterCount: null,
          includeCount: audience.includeCount,
          excludeCount: audience.excludeCount,
        };
      } else {
        const source = await sourceFor(ctx.projectId);
        const definition = await deps.audiences.definition(ctx, audience.id);
        count = await countAudience(source, definition, deps.now).catch(
          (error: unknown) => {
            throw sourceHttpError(error);
          }
        );
      }
      const preview: CountPreview = {
        ...count,
        campaignVersion: campaign.version,
        audienceVersion: audience.version,
      };
      const saved = await sql.$executeRawUnsafe(
        'UPDATE marketing.campaigns SET count_preview = $3::jsonb WHERE id = $1::uuid AND project_id = $2 AND version = $4 AND state = ANY($5::text[])',
        id,
        ctx.projectId,
        JSON.stringify(preview),
        campaign.version,
        [...PREVIEWABLE]
      );
      if (saved === 0) {
        throw new HttpError(409, 'version_conflict');
      }
      return count;
    },

    async start(
      ctx: CampaignContext,
      id: string,
      body: { confirm?: Confirmation }
    ): Promise<CampaignRow> {
      return await sql.$transaction(async (tx) => {
        const { campaign, audience } = await passGates(
          tx,
          ctx,
          id,
          'start',
          body.confirm
        );
        await startNow(tx, ctx, campaign, audience.version);
        return await fetchRow(tx, ctx, id);
      }, TRANSACTION);
    },

    async schedule(
      ctx: CampaignContext,
      id: string,
      body: { confirm?: Confirmation }
    ): Promise<CampaignRow> {
      return await sql.$transaction(async (tx) => {
        let sendAt: Date | null = null;
        await passGates(tx, ctx, id, 'schedule', body.confirm, (campaign) => {
          sendAt = campaign.sendAtLocal
            ? zonedTimeToUtc(campaign.sendAtLocal, campaign.timezone)
            : null;
          if (!sendAt) {
            throw new HttpError(400, 'invalid_send_time');
          }
          if (sendAt.getTime() < deps.now().getTime()) {
            throw new HttpError(409, 'schedule_in_past');
          }
        });
        await transition(tx, ctx, id, 'schedule', {
          send_kind: 'scheduled',
          send_at: sendAt,
        });
        return await fetchRow(tx, ctx, id);
      }, TRANSACTION);
    },

    unschedule(ctx: CampaignContext, id: string): Promise<CampaignRow> {
      return simpleTransition(ctx, id, 'unschedule', {
        send_kind: null,
        send_at: null,
      });
    },

    pause(ctx: CampaignContext, id: string): Promise<CampaignRow> {
      return simpleTransition(ctx, id, 'pause');
    },

    async resume(ctx: CampaignContext, id: string): Promise<CampaignRow> {
      try {
        // A wait computed before the pause may no longer hold.
        return await simpleTransition(ctx, id, 'resume', {
          dispatch_retry_at: null,
          dispatch_error: null,
        });
      } catch (error) {
        // Unreachable while a paused campaign holds the project's slot; kept in case the one-active index changes.
        if (isOneActiveViolation(error)) {
          throw new HttpError(409, 'another_campaign_active');
        }
        throw error;
      }
    },

    async cancel(ctx: CampaignContext, id: string): Promise<CampaignRow> {
      return await sql.$transaction(async (tx) => {
        const now = deps.now();
        await transition(tx, ctx, id, 'cancel', { finished_at: now });
        // Rows already sending belong to the dispatcher, which records their outcome.
        await endUnsentRecipients(tx, id, now, 'cancelled');
        return await fetchRow(tx, ctx, id);
      }, TRANSACTION);
    },

    async requestTestSend(
      ctx: CampaignContext,
      id: string,
      profileId: string
    ): Promise<{ id: string }> {
      if (!zIdentifier.safeParse(profileId).success) {
        throw new HttpError(400, 'invalid_profile_id');
      }
      return await sql.$transaction(async (tx) => {
        const locked = await lockCampaign(tx, ctx, id);
        if (TERMINAL.has(locked.state)) {
          throw new HttpError(409, 'invalid_transition');
        }
        const now = deps.now();
        const [recent] = await tx.$queryRawUnsafe<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM marketing.campaign_test_sends WHERE campaign_id = $1::uuid AND created_at > $2',
          id,
          new Date(now.getTime() - TEST_SEND_WINDOW_MS)
        );
        if ((recent?.n ?? 0) >= MAX_TEST_SENDS_PER_WINDOW) {
          throw new HttpError(429, 'test_send_limit');
        }
        const testSendId = randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO marketing.campaign_test_sends (id, campaign_id, project_id, profile_id, requested_by, created_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          testSendId,
          id,
          ctx.projectId,
          profileId,
          ctx.userId,
          now
        );
        return { id: testSendId };
      }, TRANSACTION);
    },

    async completeIfDone(campaignId: string): Promise<boolean> {
      assertId(campaignId);
      const now = deps.now();
      return (
        (await sql.$executeRawUnsafe(
          COMPLETE_IF_DONE,
          campaignId,
          now,
          fromStates('complete')
        )) === 1
      );
    },

    async failCampaign(campaignId: string, reason: string): Promise<void> {
      assertId(campaignId);
      const now = deps.now();
      await sql.$transaction(
        (tx) => failCampaignIn(tx, campaignId, reason, now),
        TRANSACTION
      );
    },
  };
}
