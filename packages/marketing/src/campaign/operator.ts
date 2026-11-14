import { z } from 'zod';
import { HttpError } from '../api/http';
import {
  CAMPAIGN_CHANNELS,
  checkChannelSettings,
  getChannelSettings,
} from '../channels/settings';
import type { Queryable, Sql } from '../engine/engine';
import {
  countChannelSendsSince,
  deleteLedger,
  ledgerRef,
} from '../engine/ledger';
import { daysNeeded, quotaDayStart } from './pacing';
import { RECIPIENT_STATUSES, type RecipientStatus } from './recipients';
import { type CampaignRow, isOneActiveViolation } from './service';
import { type CampaignState, fromStates, nextState } from './state';

export const MAX_RECIPIENT_PAGE = 500;
const TEST_SENDS_LIMIT = 50;
const TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
const RETRYABLE = new Set<CampaignState>(['running', 'paused', 'completed']);
const zCampaignId = z.uuid();

export const zRecipientQuery = z.strictObject({
  status: z.enum(RECIPIENT_STATUSES).optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RECIPIENT_PAGE).default(100),
});

interface OperatorContext {
  projectId: string;
}

export interface Estimate {
  count: number;
  channel: string;
  ratePerSecond: number | null;
  estimatedSeconds: number | null;
  cost: { amount: number; currency: string } | null;
  quota: {
    dailyQuota: number;
    usedToday: number;
    remainingToday: number;
    daysNeeded: number;
  } | null;
  issues: string[];
}

interface EstimateDeps {
  sql: Sql;
  now: () => Date;
  campaigns: {
    get(
      ctx: { projectId: string; userId: string },
      id: string
    ): Promise<CampaignRow>;
  };
  channelReady?: (
    projectId: string,
    channel: string,
    template: unknown
  ) => Promise<string | null>;
}

async function requireCampaign(
  db: Queryable,
  ctx: OperatorContext,
  id: string,
  forUpdate: boolean
): Promise<{ state: CampaignState }> {
  if (!zCampaignId.safeParse(id).success) {
    throw new HttpError(404, 'not_found');
  }
  const [row] = await db.$queryRawUnsafe<{ state: CampaignState }[]>(
    `SELECT state FROM marketing.campaigns WHERE id = $1::uuid AND project_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    id,
    ctx.projectId
  );
  if (!row) {
    throw new HttpError(404, 'not_found');
  }
  return row;
}

// The one deliberate exception to at-most-once: the operator chose to send these people again, so their ledger
// rows go with the retry. Lock order is the campaign row, then its recipients, as in cancel and the dispatcher.
export async function retryUncertain(
  sql: Sql,
  ctx: OperatorContext,
  campaignId: string
): Promise<{ retried: number }> {
  return await sql.$transaction(async (tx) => {
    const { state } = await requireCampaign(tx, ctx, campaignId, true);
    if (!RETRYABLE.has(state)) {
      throw new HttpError(409, 'invalid_transition');
    }
    const now = new Date();
    const changed = await tx.$queryRawUnsafe<{ profile_id: string }[]>(
      `UPDATE marketing.campaign_recipients
       SET status = 'pending', reason = 'operator_retry', attempt = 0, due_at = $2::timestamptz,
         lease_token = NULL, lease_until = NULL, provider_ref = NULL, updated_at = $2::timestamptz
       WHERE campaign_id = $1::uuid AND status = 'uncertain'
       RETURNING profile_id`,
      campaignId,
      now.toISOString()
    );
    if (changed.length === 0) {
      return { retried: 0 };
    }
    await deleteLedger(
      tx,
      changed.map((row) => ledgerRef.campaign(campaignId, row.profile_id))
    );
    await tx.$executeRawUnsafe(
      `UPDATE marketing.campaign_counters
       SET uncertain = GREATEST(uncertain - $2::int, 0), updated_at = $3::timestamptz
       WHERE campaign_id = $1::uuid`,
      campaignId,
      changed.length,
      now.toISOString()
    );
    if (state === 'completed' && nextState(state, 'reopen')) {
      await reopen(tx, campaignId, now);
    }
    return { retried: changed.length };
  }, TRANSACTION);
}

async function reopen(tx: Queryable, campaignId: string, now: Date) {
  try {
    await tx.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET state = 'running', finished_at = NULL, updated_at = $2::timestamptz
       WHERE id = $1::uuid AND state = ANY($3::text[])`,
      campaignId,
      now.toISOString(),
      fromStates('reopen')
    );
  } catch (error) {
    if (isOneActiveViolation(error)) {
      throw new HttpError(409, 'another_campaign_active');
    }
    throw error;
  }
}

export async function listRecipients(
  sql: Sql,
  ctx: OperatorContext,
  campaignId: string,
  query: { status?: RecipientStatus; cursor?: string; limit: number }
): Promise<{
  recipients: {
    profileId: string;
    status: string;
    reason: string | null;
    attempt: number;
    providerRef: string | null;
    sentAt: string | null;
    updatedAt: string;
  }[];
  nextCursor: string | null;
}> {
  await requireCampaign(sql, ctx, campaignId, false);
  const rows = await sql.$queryRawUnsafe<
    {
      profile_id: string;
      status: string;
      reason: string | null;
      attempt: number;
      provider_ref: string | null;
      sent_at: Date | null;
      updated_at: Date;
    }[]
  >(
    `SELECT profile_id, status, reason, attempt, provider_ref, sent_at, updated_at
     FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR profile_id > $3)
     ORDER BY profile_id LIMIT $4::int`,
    campaignId,
    query.status ?? null,
    query.cursor ?? null,
    query.limit + 1
  );
  const page = rows.slice(0, query.limit);
  return {
    recipients: page.map((row) => ({
      profileId: row.profile_id,
      status: row.status,
      reason: row.reason,
      attempt: row.attempt,
      providerRef: row.provider_ref,
      sentAt: row.sent_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(),
    })),
    nextCursor:
      rows.length > query.limit ? (page.at(-1)?.profile_id ?? null) : null,
  };
}

export async function skipReasons(
  sql: Sql,
  ctx: OperatorContext,
  campaignId: string
): Promise<{
  reasons: {
    status: 'skipped' | 'failed' | 'uncertain';
    reason: string;
    count: number;
  }[];
}> {
  await requireCampaign(sql, ctx, campaignId, false);
  const reasons = await sql.$queryRawUnsafe<
    {
      status: 'skipped' | 'failed' | 'uncertain';
      reason: string;
      count: number;
    }[]
  >(
    `SELECT status, COALESCE(reason, 'unknown') AS reason, count(*)::int AS count
     FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid AND status IN ('skipped', 'failed', 'uncertain')
     GROUP BY status, COALESCE(reason, 'unknown')
     ORDER BY status, count DESC, reason`,
    campaignId
  );
  return { reasons };
}

export async function listTestSends(
  sql: Sql,
  ctx: OperatorContext,
  campaignId: string
): Promise<{
  testSends: {
    id: string;
    profileId: string;
    status: string;
    reason: string | null;
    createdAt: string;
    sentAt: string | null;
  }[];
}> {
  await requireCampaign(sql, ctx, campaignId, false);
  const rows = await sql.$queryRawUnsafe<
    {
      id: string;
      profile_id: string;
      status: string;
      reason: string | null;
      created_at: Date;
      sent_at: Date | null;
    }[]
  >(
    `SELECT id::text, profile_id, status, reason, created_at, sent_at
     FROM marketing.campaign_test_sends WHERE campaign_id = $1::uuid
     ORDER BY created_at DESC, id LIMIT $2::int`,
    campaignId,
    TEST_SENDS_LIMIT
  );
  return {
    testSends: rows.map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at.toISOString(),
      sentAt: row.sent_at?.toISOString() ?? null,
    })),
  };
}

export async function estimateCampaign(
  deps: EstimateDeps,
  ctx: OperatorContext & { userId?: string },
  campaignId: string
): Promise<Estimate> {
  const campaign = await deps.campaigns.get(
    { projectId: ctx.projectId, userId: ctx.userId ?? '' },
    campaignId
  );
  if (!campaign.countPreview) {
    throw new HttpError(409, 'count_preview_required');
  }
  const { count } = campaign.countPreview;
  const channel = CAMPAIGN_CHANNELS.find((name) => name === campaign.channel);
  if (!channel) {
    throw new HttpError(409, 'channel_not_configured');
  }
  const { settings } = await getChannelSettings(
    deps.sql,
    ctx.projectId,
    channel
  );
  const issues: string[] = checkChannelSettings(channel, settings);
  const notReady = await deps.channelReady?.(
    ctx.projectId,
    channel,
    campaign.template
  );
  if (notReady) {
    issues.push(notReady);
  }
  const { ratePerSecond, pricePerMessage, dailyQuota } = settings;
  let quota: Estimate['quota'] = null;
  if (channel === 'email' && dailyQuota !== null) {
    const usedToday = await countChannelSendsSince(
      deps.sql,
      ctx.projectId,
      channel,
      quotaDayStart(deps.now(), settings.quotaTimezone)
    );
    const remainingToday = Math.max(0, dailyQuota - usedToday);
    quota = {
      dailyQuota,
      usedToday,
      remainingToday,
      daysNeeded: daysNeeded(count, remainingToday, dailyQuota),
    };
  }
  return {
    count,
    channel,
    ratePerSecond,
    estimatedSeconds:
      ratePerSecond === null ? null : Math.ceil(count / ratePerSecond),
    cost: pricePerMessage
      ? {
          amount: count * pricePerMessage.amount,
          currency: pricePerMessage.currency,
        }
      : null,
    quota,
    issues,
  };
}
