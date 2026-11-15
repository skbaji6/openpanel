import { z } from 'zod';
import { HttpError } from '../api/http';
import type { LookupEntry } from '../audience/contract';
import {
  SourceAuthError,
  SourceBusyError,
  SourceProtocolError,
  SourceUnavailableError,
} from '../audience/errors';
import { withCampaignLane } from '../audience/lane';
import type { DeliveryOutcome } from '../channels/batch';
import { phoneSecrets } from '../channels/msg91-http';
import { getChannelSettings, PROVIDER_CHANNELS } from '../channels/settings';
import { recordDeadTokens } from '../engine/dead-tokens';
import { entryValues } from '../engine/ticker';
import { redactSecrets } from '../redact';
import type { TemplateVersion } from '../templates/registry';
import { zRegistryTemplate } from './definition';
import {
  CONFIG_SQL,
  type DispatchDeps,
  type DueCampaign,
  loadAdapterConfig,
  lookupChannelOf,
  type Prepared,
  SEND_DEADLINE_MS,
  safeProviderRef,
  sendWithDeadline,
  sortEntries,
} from './dispatch';
import { acquireTokens } from './pacing';
import { SENDING_LEASE_MS } from './recipients';

const CLAIM_LIMIT = 10;
const LOG_PREFIX = 'marketing test sends:';
const NOT_FOUND = 404;
const ENDED_CAMPAIGN_STATES = new Set(['cancelled', 'failed']);

// A send that outlived its lease may have reached the provider, so it is never retried.
const EXPIRE_SQL = `UPDATE marketing.campaign_test_sends
  SET status = 'failed', reason = 'uncertain', lease_until = NULL
  WHERE status = 'sending' AND lease_until < $1::timestamptz`;
// Params: lease end. Marked sending before anything else, so a crash can never send it twice.
// One row per claim, so each test send gets its own lease and deadline.
const CLAIM_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT id FROM marketing.campaign_test_sends WHERE status = 'pending'
    ORDER BY created_at LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE marketing.campaign_test_sends t SET status = 'sending', lease_until = $1::timestamptz
  FROM picked p, marketing.campaigns c
  WHERE t.id = p.id AND c.id = t.campaign_id AND t.status = 'pending'
  RETURNING t.id::text AS test_send_id, t.profile_id, c.id::text AS id, c.project_id, c.state, c.channel,
    c.template, c.template_version, c.quiet_hours_override, c.frequency_cap`;
// Params: id, status, reason, provider ref, sent at.
const FINISH_SQL = `UPDATE marketing.campaign_test_sends
  SET status = $2, reason = $3, provider_ref = $4, sent_at = $5::timestamptz, lease_until = NULL
  WHERE id = $1::uuid AND status = 'sending'`;

type Final = 'sent' | 'failed' | 'skipped';

interface ClaimedTestSend extends DueCampaign {
  test_send_id: string;
  profile_id: string;
  state: string;
}

type TemplateChoice =
  | { ok: true; version: TemplateVersion | null }
  | { ok: false; reason: 'template_not_found' | 'template_disabled' };

async function finish(
  deps: DispatchDeps,
  row: ClaimedTestSend,
  status: Final,
  reason: string | null,
  providerRef: string | null = null
): Promise<Final> {
  await deps.sql.$executeRawUnsafe(
    FINISH_SQL,
    row.test_send_id,
    status,
    reason,
    providerRef,
    status === 'sent' ? deps.now().toISOString() : null
  );
  return status;
}

async function chooseTemplate(
  deps: DispatchDeps,
  row: ClaimedTestSend
): Promise<TemplateChoice> {
  if (!PROVIDER_CHANNELS.has(row.channel)) {
    return { ok: true, version: null };
  }
  const ref = zRegistryTemplate.safeParse(row.template);
  const templateId = ref.success ? ref.data.templateId : '';
  if (!z.uuid().safeParse(templateId).success) {
    return { ok: false, reason: 'template_not_found' };
  }
  try {
    const current = await deps.registry.get(row.project_id, templateId);
    if (!current.enabled) {
      return { ok: false, reason: 'template_disabled' };
    }
    const version =
      row.template_version === null
        ? current
        : await deps.registry.getVersion(
            row.project_id,
            templateId,
            row.template_version
          );
    return { ok: true, version };
  } catch (error) {
    if (error instanceof HttpError && error.status === NOT_FOUND) {
      return { ok: false, reason: 'template_not_found' };
    }
    throw error;
  }
}

// Only errors raised before any provider call: nothing was sent, so the test send can end at once.
export function lookupFailureReason(error: unknown): string | null {
  if (error instanceof SourceAuthError) {
    return 'source_auth_failed';
  }
  const unavailable =
    error instanceof SourceUnavailableError ||
    error instanceof SourceBusyError ||
    error instanceof SourceProtocolError;
  return unavailable ? 'source_unavailable' : null;
}

function finalOf(outcome: DeliveryOutcome, redact: string[]) {
  if (outcome.outcome === 'sent') {
    return { status: 'sent' as const, reason: null };
  }
  // Nothing is re-queued: a test send is at most once, so every other outcome is final.
  const reason =
    outcome.outcome === 'uncertain'
      ? 'uncertain'
      : redactSecrets(outcome.reason ?? outcome.outcome, redact);
  return { status: 'failed' as const, reason };
}

async function deliver(
  deps: DispatchDeps,
  row: ClaimedTestSend,
  claimedAt: Date,
  redact: string[]
): Promise<Final | null> {
  const { project_id: projectId, channel, profile_id: profileId } = row;
  if (ENDED_CAMPAIGN_STATES.has(row.state)) {
    return finish(deps, row, 'skipped', row.state);
  }
  const [configRow] = await deps.sql.$queryRawUnsafe<
    { config_encrypted: string }[]
  >(CONFIG_SQL, projectId, channel);
  const loaded = loadAdapterConfig(deps, channel, configRow?.config_encrypted);
  if (!loaded) {
    return finish(deps, row, 'failed', 'channel_not_configured');
  }
  redact.push(...loaded.secrets);
  const template = await chooseTemplate(deps, row);
  if (!template.ok) {
    return finish(deps, row, 'skipped', template.reason);
  }
  const source = await deps.sources.forProject(projectId);
  if (!source) {
    return finish(deps, row, 'failed', 'source_not_http');
  }
  let entries: LookupEntry[];
  try {
    entries = await withCampaignLane(source, {
      redis: deps.redis,
      projectId,
      sourceConcurrency: deps.cfg.sourceConcurrency,
    }).lookup([profileId], lookupChannelOf(channel));
  } catch (error) {
    const reason = lookupFailureReason(error);
    if (!reason) {
      throw error;
    }
    return finish(deps, row, 'failed', reason);
  }
  redact.push(
    ...entries.flatMap(entryValues),
    ...entries.flatMap((entry) => phoneSecrets(entry.phone))
  );
  redact.sort((a, b) => b.length - a.length);

  const { settings } = await getChannelSettings(deps.sql, projectId, channel);
  const prepared: Prepared = {
    ...loaded,
    settings: { ...settings, concurrency: 1 },
    source,
    version: template.version,
    cap: null,
    limit: 1,
  };
  const sorted = await sortEntries(
    deps,
    row,
    prepared,
    {
      token: row.test_send_id,
      profileIds: [profileId],
      leaseUntil: new Date(claimedAt.getTime() + SENDING_LEASE_MS),
    },
    new Map(entries.map((entry) => [entry.id, entry]))
  );
  const [skip] = sorted.skipped;
  if (skip) {
    return finish(deps, row, 'skipped', skip.reason);
  }
  const [renderFailure] = sorted.failed;
  if (renderFailure) {
    return finish(deps, row, 'failed', renderFailure.reason);
  }
  const [item] = sorted.items;
  if (!item) {
    return null;
  }
  const budgetMs =
    claimedAt.getTime() + SEND_DEADLINE_MS - deps.now().getTime();
  const granted =
    budgetMs > 0
      ? await acquireTokens(
          deps.bucket,
          `${projectId}:${channel}`,
          settings.ratePerSecond,
          1,
          budgetMs,
          deps.sleep
        )
      : 0;
  if (granted === 0) {
    return finish(deps, row, 'failed', 'rate_limited');
  }
  // A campaign-scoped key would let a provider that dedupes on it drop this person's real send later.
  const outcomes = await sendWithDeadline(
    deps,
    prepared,
    [{ ...item, idempotencyKey: `test:${row.test_send_id}` }],
    claimedAt
  );
  const outcome = outcomes.find((o) => o.profileId === profileId);
  if (!outcome) {
    return null;
  }
  const invalidTokens = outcome.invalidTokens ?? [];
  if (invalidTokens.length > 0) {
    // The outcome is known, so a failure here must not leave the row for the expiry rule.
    await recordDeadTokens(
      deps.sql,
      projectId,
      invalidTokens,
      deps.cfg.encryptionKey
    ).catch((error: unknown) => {
      console.error(
        LOG_PREFIX,
        row.test_send_id,
        'recording dead tokens:',
        redactSecrets(error, redact)
      );
    });
  }
  const final = finalOf(outcome, redact);
  return finish(
    deps,
    row,
    final.status,
    final.reason,
    safeProviderRef(outcome.providerRef, redact) ?? null
  );
}

// Quiet hours, frequency caps and quotas do not apply, and no ledger row is written: the operator asked for this one.
export async function runTestSendTick(
  deps: DispatchDeps
): Promise<{ sent: number; failed: number; skipped: number }> {
  const counts = {
    sent: 0,
    failed: await deps.sql.$executeRawUnsafe(
      EXPIRE_SQL,
      deps.now().toISOString()
    ),
    skipped: 0,
  };
  for (let claimed = 0; claimed < CLAIM_LIMIT; claimed++) {
    const claimedAt = deps.now();
    const [row] = await deps.sql.$queryRawUnsafe<ClaimedTestSend[]>(
      CLAIM_SQL,
      new Date(claimedAt.getTime() + SENDING_LEASE_MS).toISOString()
    );
    if (!row) {
      break;
    }
    const redact: string[] = [];
    try {
      const final = await deliver(deps, row, claimedAt, redact);
      if (final) {
        counts[final] += 1;
      }
    } catch (error) {
      // The row stays sending: the provider may have it, so only the expiry rule may end it.
      console.error(LOG_PREFIX, row.test_send_id, redactSecrets(error, redact));
    }
  }
  return counts;
}
