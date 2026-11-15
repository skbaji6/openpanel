import type { Redis } from '@openpanel/redis';
import {
  type LookupChannel,
  type LookupEntry,
  MAX_LOOKUP_IDS,
} from '../audience/contract';
import {
  SourceAuthError,
  SourceBusyError,
  SourceProtocolError,
  SourceUnavailableError,
} from '../audience/errors';
import { withCampaignLane } from '../audience/lane';
import type { SourceResolver } from '../audience/resolver';
import type { AudienceSource } from '../audience/source';
import type {
  BatchChannelAdapter,
  BatchItem,
  DeliveryOutcome,
  ProviderMessage,
} from '../channels/batch';
import { phoneSecrets } from '../channels/msg91-http';
import { getBatchAdapter } from '../channels/registry';
import {
  type CampaignChannel,
  type ChannelSettings,
  effectiveQuietHours,
  getChannelSettings,
  PROVIDER_CHANNELS,
  usesRegistryVersion,
} from '../channels/settings';
import { LEASE_MARGIN_MS, SEND_TIMEOUT_MS } from '../channels/timeouts';
import type { RenderedMessage } from '../channels/types';
import type { MarketingConfig } from '../config';
import { filterLiveTokens, recordDeadTokens } from '../engine/dead-tokens';
import type { Sql } from '../engine/engine';
import { inQuietHours, nextAllowedTime } from '../engine/gates';
import { type EffectiveCap, effectiveCap } from '../engine/ledger';
import {
  entryValues,
  loadChannelConfig,
  lookupSkipReason,
  zCaps,
} from '../engine/ticker';
import { redactSecrets } from '../redact';
import { zInlineTemplate } from '../rules/rule.schema';
import { renderTemplate } from '../template/render';
import { renderProviderVariables } from '../templates/provider-render';
import type {
  createTemplateRegistry,
  TemplateVersion,
} from '../templates/registry';
import {
  zFrequencyCap,
  zPushTemplate,
  zQuietHoursOverride,
  zRegistryTemplate,
} from './definition';
import {
  AUTH_RETRY_MS,
  SOURCE_AUTH_FAILED,
  SOURCE_OK,
} from './materialize-runner';
import {
  acquireTokens,
  claimSize,
  type createChannelBackoff,
  type createRateBucket,
  nextQuotaDayStart,
  remainingQuota,
} from './pacing';
import {
  CHANNEL_ERROR_BACKOFF_MS,
  claimRecipients,
  markLeasedFinal,
  markOutcomes,
  markSending,
  NOT_ATTEMPTED_REASONS,
  RETRY_BACKOFF_MS,
  releaseLeased,
  SENDING_LEASE_MS,
  UNREACHABLE_REASONS,
} from './recipients';
import type { createCampaignService } from './service';

const SOURCE_RETRY_MS = 30_000;
const MS_PER_SECOND = 1000;
const MIN_PACING_REST_MS = 1000;
const MAX_DISPATCH_FAILURES = 5;
// The last send may start here and still finish, at its own timeout, before the reaper can take the batch.
// Every adapter bounds a send by SEND_TIMEOUT_MS.
export const SEND_DEADLINE_MS =
  SENDING_LEASE_MS - SEND_TIMEOUT_MS - LEASE_MARGIN_MS;
const LOG_PREFIX = 'marketing dispatch:';
const TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
const RETURNED_OUTCOMES = new Set<DeliveryOutcome['outcome']>([
  'retry',
  'rate_limited',
  'channel_error',
]);
const providerReached = (outcome: DeliveryOutcome) =>
  outcome.outcome !== 'channel_error' &&
  outcome.outcome !== 'rate_limited' &&
  !(
    outcome.outcome === 'retry' &&
    NOT_ATTEMPTED_REASONS.has(outcome.reason ?? '')
  );

// No row lock: SKIP LOCKED on the recipient claim keeps concurrent loops apart.
const PICK_SQL = `SELECT c.id::text, c.project_id, c.channel, c.template, c.template_version,
    c.quiet_hours_override, c.frequency_cap
  FROM marketing.campaigns c
  WHERE c.state = 'running' AND c.materialize_state = 'done'
    AND (c.dispatch_retry_at IS NULL OR c.dispatch_retry_at <= $1::timestamptz)
    AND EXISTS (SELECT 1 FROM marketing.campaign_recipients r
      WHERE r.campaign_id = c.id AND r.status = 'pending' AND r.due_at <= $1::timestamptz)
  ORDER BY c.dispatch_retry_at NULLS FIRST, c.id LIMIT 1`;
// Params: campaign, retry at, error (null keeps the current one).
const RETRY_LATER_SQL = `UPDATE marketing.campaigns SET dispatch_retry_at = $2::timestamptz,
    dispatch_error = COALESCE($3, dispatch_error)
  WHERE id = $1::uuid`;
// Stamped on every claim so the pick rotates between campaigns instead of always taking a never-retried one.
const STAMP_SQL = `UPDATE marketing.campaigns
  SET dispatch_retry_at = GREATEST(COALESCE(dispatch_retry_at, $2::timestamptz), $2::timestamptz)
  WHERE id = $1::uuid`;
// A successful lookup says only that the source is healthy; channel-side errors wait for the adapter.
const SOURCE_ERRORS =
  "'source_unavailable', 'source_auth_failed', 'source_error'";
const CHANNEL_ERRORS = `'channel_auth_failed', 'channel_unreachable', 'channel_not_configured', 'quota_exhausted',
  'quiet_hours', 'rate_limited', 'dispatch_error'`;
const LOOKUP_OK_SQL = `UPDATE marketing.campaigns SET dispatch_failures = 0,
    dispatch_error = CASE WHEN dispatch_error IN (${SOURCE_ERRORS}) THEN NULL ELSE dispatch_error END
  WHERE id = $1::uuid AND (dispatch_failures <> 0 OR dispatch_error IN (${SOURCE_ERRORS}))`;
const CHANNEL_OK_SQL = `UPDATE marketing.campaigns SET dispatch_error = NULL
  WHERE id = $1::uuid AND dispatch_error IN (${CHANNEL_ERRORS})`;
// A provider backoff also guards an unreachable channel; that label is the more telling one.
const BACKOFF_WAIT_SQL = `UPDATE marketing.campaigns SET dispatch_retry_at = $2::timestamptz,
    dispatch_error = CASE WHEN dispatch_error = 'channel_unreachable' THEN dispatch_error ELSE 'rate_limited' END
  WHERE id = $1::uuid`;
const PROTOCOL_FAILURE_SQL = `UPDATE marketing.campaigns SET dispatch_failures = dispatch_failures + 1,
    dispatch_error = 'source_error', dispatch_retry_at = $2::timestamptz
  WHERE id = $1::uuid RETURNING dispatch_failures`;
export const CONFIG_SQL =
  'SELECT config_encrypted FROM marketing.channel_configs WHERE project_id = $1 AND channel = $2';
const CAPS_SQL =
  'SELECT caps FROM marketing.project_settings WHERE project_id = $1';
const OPTED_OUT_SQL = `SELECT profile_id FROM marketing.opt_outs
  WHERE project_id = $1 AND channel = $2 AND profile_id = ANY($3::text[])`;

export interface DispatchDeps {
  sql: Sql;
  redis: Redis;
  cfg: MarketingConfig;
  sources: SourceResolver;
  registry: ReturnType<typeof createTemplateRegistry>;
  campaigns: Pick<
    ReturnType<typeof createCampaignService>,
    'completeIfDone' | 'failCampaign'
  >;
  bucket: ReturnType<typeof createRateBucket>;
  backoff: ReturnType<typeof createChannelBackoff>;
  renderUnsubscribeUrl: (
    projectId: string,
    profileId: string,
    channel: string
  ) => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface DispatchResult {
  campaignId: string | null;
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  uncertain: number;
  released: number;
}

export interface DueCampaign {
  id: string;
  project_id: string;
  channel: CampaignChannel;
  template: unknown;
  template_version: number | null;
  quiet_hours_override: unknown;
  frequency_cap: unknown;
}

export interface Prepared {
  settings: ChannelSettings;
  adapter: BatchChannelAdapter<unknown>;
  config: unknown;
  secrets: string[];
  source: AudienceSource;
  version: TemplateVersion | null;
  cap: EffectiveCap | null;
  limit: number;
}

export interface Claim {
  token: string;
  profileIds: string[];
  leaseUntil: Date;
}

type Rendered =
  | { ok: true; message: RenderedMessage | ProviderMessage }
  | { ok: false; reason: 'missing_variable' | 'render_failed' };

// A provider ref is the provider's own string and may echo the request, so one holding a secret is dropped.
export const safeProviderRef = (ref: string | undefined, redact: string[]) =>
  ref === undefined || redact.some((secret) => ref.includes(secret))
    ? undefined
    : ref;

const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

// shortcut: one sendBatch at a time per project and channel in this process, so the lane's loops together stay
// within settings.concurrency; replicas are not coordinated, upgrade to a Redis semaphore if that matters.
const sendQueues = new Map<string, Promise<unknown>>();
async function oneBatchAtATime<T>(
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = sendQueues.get(key) ?? Promise.resolve();
  const current = previous.then(work, work);
  const settled = current.catch(() => undefined);
  sendQueues.set(key, settled);
  try {
    return await current;
  } finally {
    if (sendQueues.get(key) === settled) {
      sendQueues.delete(key);
    }
  }
}

async function retryLater(
  deps: DispatchDeps,
  campaignId: string,
  retryAt: Date,
  error: string | null
): Promise<void> {
  await deps.sql.$executeRawUnsafe(
    RETRY_LATER_SQL,
    campaignId,
    retryAt.toISOString(),
    error
  );
}

export function loadAdapterConfig(
  deps: DispatchDeps,
  channel: CampaignChannel,
  encrypted: string | undefined
): Pick<Prepared, 'adapter' | 'config' | 'secrets'> | null {
  if (!encrypted) {
    return null;
  }
  let adapter: BatchChannelAdapter<unknown>;
  try {
    adapter = getBatchAdapter(channel);
  } catch {
    return null;
  }
  const loaded = loadChannelConfig(
    adapter.configSchema,
    encrypted,
    deps.cfg.encryptionKey
  );
  return loaded.ok
    ? { adapter, config: loaded.config, secrets: loaded.secrets }
    : null;
}

async function pinnedVersion(
  deps: DispatchDeps,
  campaign: DueCampaign
): Promise<TemplateVersion | null | 'missing'> {
  if (!usesRegistryVersion(campaign.channel, campaign.template)) {
    return null;
  }
  const template = zRegistryTemplate.safeParse(campaign.template);
  if (!template.success) {
    return 'missing';
  }
  try {
    return await deps.registry.getVersion(
      campaign.project_id,
      template.data.templateId,
      campaign.template_version ?? 0
    );
  } catch {
    return 'missing';
  }
}

async function projectCap(
  deps: DispatchDeps,
  campaign: DueCampaign
): Promise<EffectiveCap | null | 'invalid'> {
  const [row] = await deps.sql.$queryRawUnsafe<{ caps: unknown }[]>(
    CAPS_SQL,
    campaign.project_id
  );
  const projectCaps = zCaps.safeParse(row?.caps ?? null);
  const campaignCap = zFrequencyCap.safeParse(campaign.frequency_cap ?? null);
  // Sending without a cap the campaign asked for could message people too often, so it fails instead.
  if (!campaignCap.success) {
    return 'invalid';
  }
  return effectiveCap(
    campaignCap.data,
    projectCaps.success ? projectCaps.data : null
  );
}

// Every check that leaves the rows pending without claiming them. Null means the campaign waits.
async function prepare(
  deps: DispatchDeps,
  campaign: DueCampaign,
  now: Date
): Promise<Prepared | null> {
  const { id, project_id: projectId, channel } = campaign;
  const { settings } = await getChannelSettings(deps.sql, projectId, channel);
  const backoffUntil = await deps.backoff.until(projectId, channel);
  if (backoffUntil !== null) {
    await deps.sql.$executeRawUnsafe(
      BACKOFF_WAIT_SQL,
      id,
      new Date(backoffUntil).toISOString()
    );
    return null;
  }
  const override = zQuietHoursOverride.safeParse(
    campaign.quiet_hours_override ?? null
  );
  const quietHours = effectiveQuietHours(
    settings.quietHours,
    override.success ? override.data : null
  );
  if (inQuietHours(now, quietHours)) {
    await retryLater(deps, id, nextAllowedTime(now, quietHours), 'quiet_hours');
    return null;
  }
  let quota = Number.POSITIVE_INFINITY;
  if (channel === 'email' && settings.dailyQuota !== null) {
    // shortcut: read once without a lock, so loops dispatching one campaign at once can overshoot the quota by a batch each; lock or reserve per project and channel if that overshoot matters.
    quota = await remainingQuota(deps.sql, {
      projectId,
      channel,
      dailyQuota: settings.dailyQuota,
      quotaTimezone: settings.quotaTimezone,
      now,
    });
    if (quota === 0) {
      await retryLater(
        deps,
        id,
        nextQuotaDayStart(now, settings.quotaTimezone),
        'quota_exhausted'
      );
      return null;
    }
  }
  const [configRow] = await deps.sql.$queryRawUnsafe<
    { config_encrypted: string }[]
  >(CONFIG_SQL, projectId, channel);
  const loaded = loadAdapterConfig(deps, channel, configRow?.config_encrypted);
  if (!loaded) {
    await retryLater(
      deps,
      id,
      later(now, CHANNEL_ERROR_BACKOFF_MS),
      'channel_not_configured'
    );
    return null;
  }
  const source = await deps.sources.forProject(projectId);
  if (!source) {
    await deps.campaigns.failCampaign(id, 'source_not_http');
    return null;
  }
  const version = await pinnedVersion(deps, campaign);
  if (version === 'missing') {
    await deps.campaigns.failCampaign(id, 'template_not_found');
    return null;
  }
  const cap = await projectCap(deps, campaign);
  if (cap === 'invalid') {
    await deps.campaigns.failCampaign(id, 'invalid_frequency_cap');
    return null;
  }
  return {
    ...loaded,
    settings,
    source,
    version,
    cap,
    limit: Math.min(claimSize(settings.ratePerSecond), quota, MAX_LOOKUP_IDS),
  };
}

// Error text is stored as a code only: upstream messages may carry anything.
async function handleSourceError(
  deps: DispatchDeps,
  campaign: DueCampaign,
  error: unknown
): Promise<void> {
  const now = deps.now();
  if (
    error instanceof SourceUnavailableError ||
    error instanceof SourceBusyError
  ) {
    await retryLater(
      deps,
      campaign.id,
      later(now, SOURCE_RETRY_MS),
      'source_unavailable'
    );
    return;
  }
  if (error instanceof SourceAuthError) {
    await deps.sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        RETRY_LATER_SQL,
        campaign.id,
        later(now, AUTH_RETRY_MS).toISOString(),
        'source_auth_failed'
      );
      await tx.$executeRawUnsafe(SOURCE_AUTH_FAILED, campaign.project_id, now);
    }, TRANSACTION);
    return;
  }
  if (error instanceof SourceProtocolError) {
    const [row] = await deps.sql.$queryRawUnsafe<
      { dispatch_failures: number }[]
    >(PROTOCOL_FAILURE_SQL, campaign.id, later(now, SOURCE_RETRY_MS));
    if ((row?.dispatch_failures ?? 0) >= MAX_DISPATCH_FAILURES) {
      await deps.campaigns.failCampaign(campaign.id, 'source_error');
    }
    return;
  }
  throw error;
}

export function lookupChannelOf(channel: CampaignChannel): LookupChannel {
  return channel === 'webhook' ? 'none' : channel;
}

function consentMissing(
  campaign: DueCampaign,
  prepared: Prepared,
  entry: LookupEntry
): boolean {
  if (!prepared.settings.requireConsent) {
    return false;
  }
  if (campaign.channel === 'whatsapp') {
    return entry.consent?.whatsapp !== true;
  }
  const promotionalSms =
    campaign.channel === 'sms' && prepared.version?.category === 'promotional';
  return promotionalSms && entry.consent?.sms_promotional !== true;
}

function pushExtras(template: {
  body: string;
  imageUrl?: string;
  link?: string;
}): Pick<RenderedMessage, 'imageUrl' | 'data'> {
  return {
    ...(template.imageUrl === undefined ? {} : { imageUrl: template.imageUrl }),
    ...(template.link === undefined ? {} : { data: { link: template.link } }),
  };
}

// A pinned push version carries inline subject and body; the campaign's own template is only read when nothing is pinned.
function inlineContent(campaign: DueCampaign, version: TemplateVersion | null) {
  if (version) {
    return zInlineTemplate.parse(version.content);
  }
  return campaign.channel === 'push'
    ? zPushTemplate.parse(campaign.template)
    : zInlineTemplate.parse(campaign.template);
}

function render(
  campaign: DueCampaign,
  version: TemplateVersion | null,
  traits: Record<string, string | number | boolean>
): Rendered {
  try {
    if (version && PROVIDER_CHANNELS.has(campaign.channel)) {
      const variables = renderProviderVariables(version, traits);
      return variables.ok
        ? {
            ok: true,
            message: {
              kind: 'provider',
              version,
              variables: variables.variables,
            },
          }
        : { ok: false, reason: variables.reason };
    }
    const template = inlineContent(campaign, version);
    const vars = {
      profile: traits,
      event: {},
      missing: [],
      allowedEventProps: [],
    };
    const heading =
      template.subject === undefined
        ? undefined
        : renderTemplate(template.subject, vars, { mode: 'text' });
    const body = renderTemplate(template.body, vars, {
      mode: campaign.channel === 'email' ? 'html' : 'text',
    });
    const meta = { projectId: campaign.project_id, campaignId: campaign.id };
    return {
      ok: true,
      message:
        campaign.channel === 'push'
          ? { title: heading, body, meta, ...pushExtras(template) }
          : { subject: heading, body, meta },
    };
  } catch {
    return { ok: false, reason: 'render_failed' };
  }
}

interface Sorted {
  items: BatchItem[];
  skipped: { profileId: string; reason: string }[];
  failed: { profileId: string; reason: string }[];
}

export async function sortEntries(
  deps: DispatchDeps,
  campaign: DueCampaign,
  prepared: Prepared,
  claim: Claim,
  entries: Map<string, LookupEntry>
): Promise<Sorted> {
  const { project_id: projectId, channel } = campaign;
  const optedOut = new Set(
    (
      await deps.sql.$queryRawUnsafe<{ profile_id: string }[]>(
        OPTED_OUT_SQL,
        projectId,
        channel,
        claim.profileIds
      )
    ).map((row) => row.profile_id)
  );
  const allTokens = [...entries.values()].flatMap(
    (entry) => entry.devices?.map((device) => device.token) ?? []
  );
  const isPush = channel === 'push';
  // Only push carries device tokens; other channels send none.
  const liveTokens = new Set(
    isPush
      ? await filterLiveTokens(
          deps.sql,
          projectId,
          allTokens,
          deps.cfg.encryptionKey
        )
      : []
  );
  const sorted: Sorted = { items: [], skipped: [], failed: [] };
  for (const profileId of claim.profileIds) {
    const entry = entries.get(profileId) ?? {
      id: profileId,
      status: 'not_found',
    };
    const deviceTokens =
      entry.devices
        ?.map((device) => device.token)
        .filter((token) => liveTokens.has(token)) ?? [];
    const noLiveToken = isPush && deviceTokens.length === 0;
    let skip = lookupSkipReason(entry);
    if (!skip && optedOut.has(profileId)) {
      skip = 'opted_out';
    } else if (!skip && consentMissing(campaign, prepared, entry)) {
      skip = 'consent';
    } else if (!skip && noLiveToken) {
      skip = 'unreachable:no_live_token';
    }
    if (skip) {
      sorted.skipped.push({ profileId, reason: skip });
      continue;
    }
    const traits = entry.traits ?? {};
    const rendered = render(campaign, prepared.version, traits);
    if (!rendered.ok) {
      sorted.failed.push({ profileId, reason: rendered.reason });
      continue;
    }
    sorted.items.push({
      profileId,
      to: {
        profileId,
        ...(entry.email ? { email: entry.email } : {}),
        ...(entry.phone ? { phone: entry.phone } : {}),
        deviceTokens,
        attributes: traits,
      },
      message: rendered.message,
      idempotencyKey: `${campaign.id}:${profileId}`,
      unsubscribeUrl: deps.renderUnsubscribeUrl(projectId, profileId, channel),
    });
  }
  return sorted;
}

export async function sendWithDeadline(
  deps: DispatchDeps,
  prepared: Prepared,
  items: BatchItem[],
  sendingAt: Date
): Promise<DeliveryOutcome[]> {
  const deadlineAt = sendingAt.getTime() + SEND_DEADLINE_MS;
  const controller = new AbortController();
  // Fires at the deadline too, for adapters that check the signal rather than the clock.
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, deadlineAt - deps.now().getTime())
  );
  try {
    return await prepared.adapter.sendBatch(items, prepared.config, {
      concurrency: prepared.settings.concurrency,
      signal: controller.signal,
      deadlineAt,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function recordOutcomes(
  deps: DispatchDeps,
  campaign: DueCampaign,
  claim: Claim,
  outcomes: DeliveryOutcome[],
  redact: string[],
  result: DispatchResult
): Promise<void> {
  const { id, project_id: projectId, channel } = campaign;
  const stored = outcomes.map((outcome) => ({
    ...outcome,
    reason:
      outcome.reason === undefined
        ? undefined
        : redactSecrets(outcome.reason, redact),
    providerRef: safeProviderRef(outcome.providerRef, redact),
  }));
  const now = deps.now();
  await markOutcomes(deps.sql, {
    campaignId: id,
    token: claim.token,
    outcomes: stored,
    now,
    retryAt: now,
  });
  for (const outcome of outcomes) {
    if (outcome.outcome === 'sent') {
      result.sent += 1;
    } else if (outcome.outcome === 'failed') {
      result.failed += 1;
    } else if (outcome.outcome === 'uncertain') {
      result.uncertain += 1;
    } else if (RETURNED_OUTCOMES.has(outcome.outcome)) {
      result.released += 1;
    }
  }
  // Cleared first, so a mixed batch ends with the label of the problem it still shows.
  if (outcomes.some(providerReached)) {
    await deps.sql.$executeRawUnsafe(CHANNEL_OK_SQL, id);
  }
  const rateLimited = outcomes.filter((o) => o.outcome === 'rate_limited');
  if (rateLimited.length > 0) {
    const backoffMs = Math.max(
      ...rateLimited.map((o) => o.retryAfterMs ?? RETRY_BACKOFF_MS)
    );
    await deps.backoff.set(projectId, channel, backoffMs);
    await retryLater(deps, id, later(now, backoffMs), 'rate_limited');
  }
  const unreachable = outcomes.some(
    (o) => o.outcome === 'retry' && UNREACHABLE_REASONS.has(o.reason ?? '')
  );
  if (unreachable) {
    await deps.backoff.set(projectId, channel, CHANNEL_ERROR_BACKOFF_MS);
    await retryLater(
      deps,
      id,
      later(now, CHANNEL_ERROR_BACKOFF_MS),
      'channel_unreachable'
    );
  }
  if (outcomes.some((o) => o.outcome === 'channel_error')) {
    await retryLater(
      deps,
      id,
      later(now, CHANNEL_ERROR_BACKOFF_MS),
      'channel_auth_failed'
    );
  }
  const invalidTokens = outcomes.flatMap((o) => o.invalidTokens ?? []);
  if (invalidTokens.length > 0) {
    await recordDeadTokens(
      deps.sql,
      projectId,
      invalidTokens,
      deps.cfg.encryptionKey
    ).catch((error: unknown) => {
      console.error(
        LOG_PREFIX,
        campaign.id,
        'recording dead tokens:',
        redactSecrets(error, redact)
      );
    });
  }
}

// What the claim's lease leaves for waiting on tokens once the sending lease is set aside.
const pacingBudgetMs = (deps: DispatchDeps, claim: Claim) =>
  claim.leaseUntil.getTime() - deps.now().getTime() - SENDING_LEASE_MS;

// A claim that could send nothing rests the campaign, or every loop would claim and look it up again at once.
// shortcut: waits the time one token takes at the rate, an upper bound of the bucket's own wait; return that wait from acquireTokens if resting a little long matters.
async function restUntilTokenDue(
  deps: DispatchDeps,
  campaign: DueCampaign,
  prepared: Prepared
): Promise<void> {
  const rate = prepared.settings.ratePerSecond;
  const tokenMs = rate === null ? 0 : Math.ceil(MS_PER_SECOND / rate);
  await retryLater(
    deps,
    campaign.id,
    later(deps.now(), Math.max(MIN_PACING_REST_MS, tokenMs)),
    null
  );
}

async function deliver(
  deps: DispatchDeps,
  campaign: DueCampaign,
  prepared: Prepared,
  claim: Claim,
  result: DispatchResult
): Promise<void> {
  const { id, project_id: projectId, channel } = campaign;
  if (pacingBudgetMs(deps, claim) <= 0) {
    await restUntilTokenDue(deps, campaign, prepared);
    return;
  }
  let entries: LookupEntry[];
  try {
    entries = await withCampaignLane(prepared.source, {
      redis: deps.redis,
      projectId,
      sourceConcurrency: deps.cfg.sourceConcurrency,
    }).lookup(claim.profileIds, lookupChannelOf(channel));
  } catch (error) {
    await handleSourceError(deps, campaign, error);
    return;
  }
  await deps.sql.$executeRawUnsafe(LOOKUP_OK_SQL, id);
  await deps.sql.$executeRawUnsafe(SOURCE_OK, projectId, deps.now());

  const redact = [
    ...new Set([
      ...prepared.secrets,
      ...entries.flatMap(entryValues),
      ...entries.flatMap((entry) => phoneSecrets(entry.phone)),
    ]),
  ].sort((a, b) => b.length - a.length);
  try {
    const sorted = await sortEntries(
      deps,
      campaign,
      prepared,
      claim,
      new Map(entries.map((entry) => [entry.id, entry]))
    );
    result.skipped += await markLeasedFinal(
      deps.sql,
      claim.token,
      'skipped',
      sorted.skipped
    );
    result.failed += await markLeasedFinal(
      deps.sql,
      claim.token,
      'failed',
      sorted.failed
    );
    if (sorted.items.length === 0) {
      return;
    }
    const budgetMs = pacingBudgetMs(deps, claim);
    const granted =
      budgetMs > 0
        ? await acquireTokens(
            deps.bucket,
            `${projectId}:${channel}`,
            prepared.settings.ratePerSecond,
            sorted.items.length,
            budgetMs,
            deps.sleep
          )
        : 0;
    const paced = sorted.items.slice(0, granted);
    if (paced.length === 0) {
      await restUntilTokenDue(deps, campaign, prepared);
      return;
    }
    await oneBatchAtATime(`${projectId}:${channel}`, async () => {
      // The sending lease starts here, and a capped markSending spans several chunk transactions.
      const sendingAt = deps.now();
      const marked = await markSending(deps.sql, {
        campaignId: id,
        projectId,
        channel,
        token: claim.token,
        profileIds: paced.map((item) => item.profileId),
        now: sendingAt,
        cap: prepared.cap,
      });
      result.skipped += marked.capped.length;
      // A capped batch commits in chunks, so rows marked before a pause or cancel are still delivered.
      const sending = new Set(marked.sending);
      const toSend = paced.filter((item) => sending.has(item.profileId));
      if (toSend.length === 0) {
        return;
      }
      let outcomes: DeliveryOutcome[];
      try {
        outcomes = await sendWithDeadline(deps, prepared, toSend, sendingAt);
      } catch (error) {
        // The rows stay sending: the provider may have accepted some, so only the reaper may decide.
        console.error(
          LOG_PREFIX,
          id,
          'batch send failed:',
          redactSecrets(error, redact)
        );
        return;
      }
      await recordOutcomes(deps, campaign, claim, outcomes, redact, result);
    });
  } catch (error) {
    throw new Error(redactSecrets(error, redact));
  }
}

export async function runDispatchCycle(
  deps: DispatchDeps
): Promise<DispatchResult> {
  const now = deps.now();
  const [campaign] = await deps.sql.$queryRawUnsafe<DueCampaign[]>(
    PICK_SQL,
    now.toISOString()
  );
  const result: DispatchResult = {
    campaignId: campaign?.id ?? null,
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    uncertain: 0,
    released: 0,
  };
  if (!campaign) {
    return result;
  }
  let prepared: Prepared | null;
  try {
    prepared = await prepare(deps, campaign, now);
  } catch (error) {
    // Without a retry time the broken campaign stays first in the pick and starves every other one.
    await retryLater(
      deps,
      campaign.id,
      later(now, CHANNEL_ERROR_BACKOFF_MS),
      'dispatch_error'
    );
    throw error;
  }
  if (!prepared) {
    return result;
  }
  const claim = await claimRecipients(deps.sql, {
    campaignId: campaign.id,
    limit: prepared.limit,
    now,
    leaseMs: deps.cfg.leaseSeconds * 1000,
  });
  result.claimed = claim.profileIds.length;
  if (result.claimed === 0) {
    return result;
  }
  try {
    await deps.sql.$executeRawUnsafe(STAMP_SQL, campaign.id, now.toISOString());
    await deliver(deps, campaign, prepared, claim, result);
  } finally {
    // A row leased but never marked sending always returns to the pool.
    result.released += await releaseLeased(deps.sql, claim.token);
  }
  await deps.campaigns.completeIfDone(campaign.id);
  return result;
}
