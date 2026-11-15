import { randomUUID } from 'node:crypto';
import { HttpError } from '../api/http';
import { zIdentifier } from '../api/routes-sync';
import type { LookupEntry } from '../audience/contract';
import { withCampaignLane } from '../audience/lane';
import { CONFIG_SQL, type DispatchDeps } from '../campaign/dispatch';
import { SENDING_LEASE_MS } from '../campaign/recipients';
import {
  MAX_TEST_SENDS_PER_WINDOW,
  TEST_SEND_WINDOW_MS,
} from '../campaign/service';
import { lookupFailureReason } from '../campaign/test-sends';
import { getAdapter } from '../channels/registry';
import type { ChannelAdapter, Recipient, SendResult } from '../channels/types';
import { filterLiveTokens, recordDeadTokens } from '../engine/dead-tokens';
import type { Sql } from '../engine/engine';
import {
  entryValues,
  loadChannelConfig,
  lookupSkipReason,
  recipientValues,
  render,
} from '../engine/ticker';
import { redactSecrets } from '../redact';
import {
  type RuleDefinition,
  type Step,
  type StepTemplate,
  zRuleDefinition,
} from '../rules/rule.schema';
import { DEFAULT_VARIANT, pinDefinition } from '../templates/pin';
import type { createTemplateRegistry } from '../templates/registry';

const CLAIM_LIMIT = 10;
const LIST_LIMIT = 20;
const BAD_REQUEST = 400;
const PIN_FAILURE_STATUS = 409;
const LOG_PREFIX = 'marketing journey test sends:';
const LIMIT_LOCK_PREFIX = 'journey-test-send:';

type TemplateRegistry = ReturnType<typeof createTemplateRegistry>;
type Final = 'sent' | 'failed' | 'skipped';

// A send that outlived its lease may have reached the provider, so it is never retried.
const EXPIRE_SQL = `UPDATE marketing.journey_test_sends
  SET status = 'failed', reason = 'uncertain', lease_until = NULL
  WHERE status = 'sending' AND lease_until < $1::timestamptz`;
// Params: lease end. Marked sending before anything else, so a crash can never send it twice.
const CLAIM_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT id FROM marketing.journey_test_sends WHERE status = 'pending'
    ORDER BY created_at LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE marketing.journey_test_sends t SET status = 'sending', lease_until = $1::timestamptz
  FROM picked p, marketing.rules r
  WHERE t.id = p.id AND r.id = t.rule_id AND t.status = 'pending'
  RETURNING t.id::text AS id, t.project_id, t.rule_id::text AS rule_id, t.step_index, t.variant_key,
    t.profile_id, r.definition`;
// Params: id, status, reason, sent at.
const FINISH_SQL = `UPDATE marketing.journey_test_sends
  SET status = $2, reason = $3, sent_at = $4::timestamptz, lease_until = NULL
  WHERE id = $1::uuid AND status = 'sending'`;
const OPTED_OUT_SQL = `SELECT 1 FROM marketing.opt_outs
  WHERE project_id = $1 AND channel = $2 AND profile_id = $3`;

interface ClaimedTestSend {
  id: string;
  project_id: string;
  rule_id: string;
  step_index: number;
  variant_key: string;
  profile_id: string;
  definition: unknown;
}

type PinnedMessage =
  | { ok: true; message: StepTemplate & { body: string } }
  | { ok: false; code: string };

function messageOf(step: Step, variant: string): StepTemplate | undefined {
  if (variant === DEFAULT_VARIANT) {
    return step.template;
  }
  return Object.hasOwn(step.variants ?? {}, variant)
    ? step.variants?.[variant]
    : undefined;
}

// Pins only the requested message, so a disabled template elsewhere in the journey cannot block this test.
// Nothing is stored: a draft's unpinned refs are resolved for this send alone.
async function pinRequested(
  registry: TemplateRegistry,
  projectId: string,
  definition: RuleDefinition,
  step: Step,
  variant: string
): Promise<PinnedMessage> {
  const message = messageOf(step, variant);
  if (!message) {
    return { ok: false, code: 'unknown_variant' };
  }
  const single: Step =
    variant === DEFAULT_VARIANT
      ? { ...step, template: message, variants: undefined }
      : { ...step, template: undefined, variants: { [variant]: message } };
  const result = await pinDefinition(registry, projectId, {
    ...definition,
    steps: [single],
  });
  if (!result.ok) {
    return { ok: false, code: result.code };
  }
  const [pinnedStep] = result.definition.steps;
  const pinned = pinnedStep ? messageOf(pinnedStep, variant) : undefined;
  if (pinned?.body === undefined) {
    return { ok: false, code: 'template_not_pinned' };
  }
  return { ok: true, message: { ...pinned, body: pinned.body } };
}

export interface JourneyTestSendRequest {
  profileId: string;
  stepIndex: number;
  variant: string;
}

export async function requestJourneyTestSend(
  deps: { sql: Sql; registry: TemplateRegistry; now: () => Date },
  projectId: string,
  ruleId: string,
  request: JourneyTestSendRequest
): Promise<{ id: string }> {
  const { sql, registry } = deps;
  if (!zIdentifier.safeParse(request.profileId).success) {
    throw new HttpError(BAD_REQUEST, 'invalid_profile_id');
  }
  const [rule] = await sql.$queryRawUnsafe<{ definition: unknown }[]>(
    'SELECT definition FROM marketing.rules WHERE id = $1::uuid AND project_id = $2',
    ruleId,
    projectId
  );
  if (!rule) {
    throw new HttpError(404, 'not_found');
  }
  const definition = zRuleDefinition.parse(rule.definition);
  const step = definition.steps[request.stepIndex];
  if (!step) {
    throw new HttpError(BAD_REQUEST, 'invalid_step');
  }
  const pinned = await pinRequested(
    registry,
    projectId,
    definition,
    step,
    request.variant
  );
  if (!pinned.ok) {
    const status =
      pinned.code === 'unknown_variant' ? BAD_REQUEST : PIN_FAILURE_STATUS;
    throw new HttpError(status, pinned.code, undefined, {
      stepIndex: request.stepIndex,
      variant: request.variant,
    });
  }
  const now = deps.now();
  return await sql.$transaction(async (tx) => {
    // One lock per project serialises the count and the insert, so the limit cannot be raced past.
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `${LIMIT_LOCK_PREFIX}${projectId}`
    );
    const [recent] = await tx.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM marketing.journey_test_sends WHERE project_id = $1 AND created_at > $2',
      projectId,
      new Date(now.getTime() - TEST_SEND_WINDOW_MS)
    );
    if ((recent?.n ?? 0) >= MAX_TEST_SENDS_PER_WINDOW) {
      throw new HttpError(429, 'test_send_limit');
    }
    const id = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO marketing.journey_test_sends
         (id, project_id, rule_id, step_index, variant_key, profile_id, created_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::int, $5, $6, $7)`,
      id,
      projectId,
      ruleId,
      request.stepIndex,
      request.variant,
      request.profileId,
      now
    );
    return { id };
  });
}

export async function listJourneyTestSends(
  sql: Sql,
  projectId: string,
  ruleId: string
) {
  const rows = await sql.$queryRawUnsafe<
    {
      id: string;
      step_index: number;
      variant_key: string;
      profile_id: string;
      status: string;
      reason: string | null;
      created_at: Date;
      sent_at: Date | null;
    }[]
  >(
    `SELECT id::text, step_index, variant_key, profile_id, status, reason, created_at, sent_at
     FROM marketing.journey_test_sends WHERE project_id = $1 AND rule_id = $2::uuid
     ORDER BY created_at DESC, id LIMIT $3::int`,
    projectId,
    ruleId,
    LIST_LIMIT
  );
  return {
    testSends: rows.map((row) => ({
      id: row.id,
      stepIndex: row.step_index,
      variant: row.variant_key,
      profileId: row.profile_id,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at.toISOString(),
      sentAt: row.sent_at?.toISOString() ?? null,
    })),
  };
}

async function finish(
  deps: DispatchDeps,
  row: ClaimedTestSend,
  status: Final,
  reason: string | null
): Promise<Final> {
  await deps.sql.$executeRawUnsafe(
    FINISH_SQL,
    row.id,
    status,
    reason,
    status === 'sent' ? deps.now().toISOString() : null
  );
  return status;
}

function contactSkip(
  channel: Step['channel'],
  recipient: Recipient
): string | null {
  if (channel === 'email' && !recipient.email) {
    return 'no_email';
  }
  if (channel === 'push' && recipient.deviceTokens.length === 0) {
    return 'no_device';
  }
  return null;
}

async function lookUp(
  deps: DispatchDeps,
  row: ClaimedTestSend,
  channel: Step['channel']
): Promise<{ entry: LookupEntry } | { final: Final }> {
  const source = await deps.sources.forProject(row.project_id);
  if (!source) {
    return { final: await finish(deps, row, 'failed', 'source_not_http') };
  }
  try {
    const entries = await withCampaignLane(source, {
      redis: deps.redis,
      projectId: row.project_id,
      sourceConcurrency: deps.cfg.sourceConcurrency,
    }).lookup([row.profile_id], channel === 'webhook' ? 'none' : channel);
    const entry = entries.find((e) => e.id === row.profile_id) ?? {
      id: row.profile_id,
      status: 'not_found' as const,
    };
    return { entry };
  } catch (error) {
    const reason = lookupFailureReason(error);
    if (!reason) {
      throw error;
    }
    return { final: await finish(deps, row, 'failed', reason) };
  }
}

interface Prepared {
  adapter: ChannelAdapter<unknown>;
  config: unknown;
  secrets: string[];
  step: Step;
  definition: RuleDefinition;
  message: StepTemplate & { body: string };
}

// Everything before the provider call: a failure here sent nothing, so the row may end at once.
async function prepare(
  deps: DispatchDeps,
  row: ClaimedTestSend
): Promise<Prepared | { final: Final }> {
  const parsed = zRuleDefinition.safeParse(row.definition);
  const step = parsed.success ? parsed.data.steps[row.step_index] : undefined;
  if (!(parsed.success && step)) {
    return { final: await finish(deps, row, 'failed', 'step_missing') };
  }
  const pinned = await pinRequested(
    deps.registry,
    row.project_id,
    parsed.data,
    step,
    row.variant_key
  );
  if (!pinned.ok) {
    return { final: await finish(deps, row, 'skipped', pinned.code) };
  }
  let adapter: ChannelAdapter<unknown>;
  try {
    adapter = getAdapter(step.channel);
  } catch {
    return { final: await finish(deps, row, 'skipped', 'channel_unavailable') };
  }
  const [configRow] = await deps.sql.$queryRawUnsafe<
    { config_encrypted: string }[]
  >(CONFIG_SQL, row.project_id, step.channel);
  if (!configRow) {
    return {
      final: await finish(deps, row, 'skipped', 'channel_not_configured'),
    };
  }
  const loaded = loadChannelConfig(
    adapter.configSchema,
    configRow.config_encrypted,
    deps.cfg.encryptionKey
  );
  if (!loaded.ok) {
    return {
      final: await finish(deps, row, 'skipped', 'invalid_channel_config'),
    };
  }
  return {
    adapter,
    config: loaded.config,
    secrets: loaded.secrets,
    step,
    definition: parsed.data,
    message: pinned.message,
  };
}

async function liveTokens(
  deps: DispatchDeps,
  row: ClaimedTestSend,
  channel: Step['channel'],
  entry: LookupEntry
): Promise<string[]> {
  const tokens = entry.devices?.map((device) => device.token) ?? [];
  return channel === 'push'
    ? await filterLiveTokens(
        deps.sql,
        row.project_id,
        tokens,
        deps.cfg.encryptionKey
      )
    : tokens;
}

async function deliver(
  deps: DispatchDeps,
  row: ClaimedTestSend,
  redact: string[]
): Promise<Final | null> {
  const prepared = await prepare(deps, row);
  if ('final' in prepared) {
    return prepared.final;
  }
  const { adapter, step } = prepared;
  redact.push(...prepared.secrets);
  const looked = await lookUp(deps, row, step.channel);
  if ('final' in looked) {
    return looked.final;
  }
  const { entry } = looked;
  redact.push(...entryValues(entry));
  const lookupSkip = lookupSkipReason(entry);
  if (lookupSkip) {
    return finish(deps, row, 'skipped', lookupSkip);
  }
  const [optedOut] = await deps.sql.$queryRawUnsafe<unknown[]>(
    OPTED_OUT_SQL,
    row.project_id,
    step.channel,
    row.profile_id
  );
  if (optedOut) {
    return finish(deps, row, 'skipped', 'opted_out');
  }
  const recipient: Recipient = {
    profileId: entry.id,
    ...(entry.email ? { email: entry.email } : {}),
    deviceTokens: await liveTokens(deps, row, step.channel, entry),
    attributes: entry.traits ?? {},
  };
  const contact = contactSkip(step.channel, recipient);
  if (contact) {
    return finish(deps, row, 'skipped', contact);
  }
  redact.push(...recipientValues(recipient));
  redact.sort((a, b) => b.length - a.length);
  // The requested variant is rendered whatever state the student is in: that is what a test is for.
  const rendered = render(
    prepared.message,
    step.channel,
    {
      attributes: recipient.attributes,
      trigger_properties: {},
      rule_snapshot: prepared.definition,
    },
    { met: false, missing: [] },
    {
      projectId: row.project_id,
      enrollmentId: row.id,
      ruleId: row.rule_id,
      stepIndex: row.step_index,
    }
  );
  const result: SendResult = await Promise.resolve()
    .then(() =>
      adapter.send(rendered, recipient, prepared.config, {
        idempotencyKey: `test:${row.id}`,
        unsubscribeUrl: deps.renderUnsubscribeUrl(
          row.project_id,
          row.profile_id,
          step.channel
        ),
      })
    )
    .catch((error: unknown) => ({
      ok: false as const,
      retryable: false,
      reason: redactSecrets(error, redact),
    }));
  if (result.invalidTokens?.length) {
    await recordDeadTokens(
      deps.sql,
      row.project_id,
      result.invalidTokens,
      deps.cfg.encryptionKey
    ).catch((error: unknown) => {
      console.error(
        LOG_PREFIX,
        row.id,
        'recording dead tokens:',
        redactSecrets(error, redact)
      );
    });
  }
  // Only a fixed code is stored: an adapter's error text can echo the recipient.
  return result.ok
    ? finish(deps, row, 'sent', null)
    : finish(deps, row, 'failed', 'send_failed');
}

// Quiet hours, caps and the ledger do not apply: the operator asked for this one.
// Each row is claimed alone and ended or expired, never retried.
export async function runJourneyTestSendTick(
  deps: DispatchDeps
): Promise<number> {
  await deps.sql.$executeRawUnsafe(EXPIRE_SQL, deps.now().toISOString());
  let handled = 0;
  for (let claimed = 0; claimed < CLAIM_LIMIT; claimed++) {
    const [row] = await deps.sql.$queryRawUnsafe<ClaimedTestSend[]>(
      CLAIM_SQL,
      new Date(deps.now().getTime() + SENDING_LEASE_MS).toISOString()
    );
    if (!row) {
      break;
    }
    handled += 1;
    const redact: string[] = [];
    try {
      await deliver(deps, row, redact);
    } catch (error) {
      // The row stays sending: the provider may have it, so only the expiry rule may end it.
      console.error(LOG_PREFIX, row.id, redactSecrets(error, redact));
    }
  }
  return handled;
}
