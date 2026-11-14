// Test-only harness for the campaign send engine's failure tests: a fake clock, a recording adapter that can
// crash at a chosen point, a SQL wrapper that can crash or react mid-transaction, and the final-state checks.
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import type { FakeMember } from '../audience/fake-source';
import type { AudienceSource } from '../audience/source';
import { createAudienceStore } from '../audience/store';
import type {
  BatchChannelAdapter,
  BatchItem,
  DeliveryOutcome,
} from '../channels/batch';
import { registerBatchAdapter } from '../channels/registry';
import {
  type CampaignChannel,
  type ChannelSettings,
  DEFAULT_CHANNEL_SETTINGS,
  putChannelSettings,
} from '../channels/settings';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import type { Sql } from '../engine/engine';
import { createTemplateRegistry } from '../templates/registry';
import { type DispatchDeps, runDispatchCycle } from './dispatch';
import { runReapTick } from './dispatch-lane';
import { createRateBucket } from './pacing';
import { createCampaignService } from './service';

export const ENCRYPTION_KEY = 'a'.repeat(64);
export const CFG = {
  encryptionKey: ENCRYPTION_KEY,
  leaseSeconds: 120,
  sourceConcurrency: 4,
} as MarketingConfig;
export const CLAIM_LEASE_MS = CFG.leaseSeconds * 1000;
export const START = new Date('2026-11-03T06:00:00.000Z');
export const USER = 'u1';
const CHANNEL_SECRET = 'fake-channel-secret-value';
const MAX_DRAIN_ROUNDS = 2000;
const ONE_MS = 1;
const FINAL_STATUSES = new Set(['sent', 'uncertain', 'skipped', 'failed']);
const PUSH_TEMPLATE = { subject: 'Hi', body: 'Hello {{profile.name}}' };
const zFakeConfig = z.object({ key: z.string() });

export const redis = getRedisCache();

// Thrown where a test kills a dispatch cycle; the process is gone, so nothing after it may run.
export class CrashError extends Error {
  constructor(point: string) {
    super(`simulated crash ${point}`);
  }
}

export interface Clock {
  now: () => Date;
  ms: () => number;
  advance: (ms: number) => void;
  // Never moves backwards: concurrent loops share one clock.
  moveTo: (at: Date) => void;
  sleep: (ms: number) => Promise<void>;
}

export function createClock(start: Date = START): Clock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    ms: () => current,
    advance: (ms) => {
      current += ms;
    },
    moveTo: (at) => {
      current = Math.max(current, at.getTime());
    },
    sleep: async (ms) => {
      current += ms;
    },
  };
}

// The real backoff runs on the Redis clock; this one runs on the test clock.
export function testClockBackoff(clock: Clock): DispatchDeps['backoff'] {
  const ends = new Map<string, number>();
  return {
    async set(projectId, channel, ms) {
      const key = `${projectId}:${channel}`;
      ends.set(key, Math.max(ends.get(key) ?? 0, clock.ms() + ms));
    },
    async until(projectId, channel) {
      const end = ends.get(`${projectId}:${channel}`) ?? 0;
      return end > clock.ms() ? end : null;
    },
  };
}

export function campaignService(
  source: AudienceSource | null,
  now: () => Date
) {
  const resolve = async () => source;
  return createCampaignService({
    sql,
    cfg: CFG,
    audiences: createAudienceStore({ sql, source: resolve, now }),
    source: resolve,
    now,
  });
}

export function dispatchDeps(
  source: AudienceSource | null,
  clock: Clock,
  overrides: Partial<DispatchDeps> = {}
): DispatchDeps {
  return {
    sql,
    redis,
    cfg: CFG,
    sources: { forProject: async () => source, invalidate: () => undefined },
    registry: createTemplateRegistry({ sql, now: clock.now }),
    campaigns: campaignService(source, clock.now),
    bucket: createRateBucket(redis, { now: clock.ms }),
    backoff: testClockBackoff(clock),
    renderUnsubscribeUrl: (_project, profileId, channel) =>
      `https://unsubscribe.test/${profileId}/${channel}`,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
}

export interface SqlHooks {
  // Runs before every statement, inside transactions too; a throw there aborts the statement (and its transaction).
  beforeQuery?: (text: string, params: unknown[]) => void;
  // Runs after an interactive transaction committed, before its caller sees the result.
  afterTransaction?: (result: unknown) => Promise<void> | void;
}

type Queryable = Pick<Sql, '$queryRawUnsafe' | '$executeRawUnsafe'>;

function hookQueries<T extends Queryable>(target: T, hooks: SqlHooks): T {
  return new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== 'function') {
        return value;
      }
      if (property === '$queryRawUnsafe' || property === '$executeRawUnsafe') {
        return (text: string, ...params: unknown[]) => {
          hooks.beforeQuery?.(text, params);
          return value.call(object, text, ...params);
        };
      }
      if (property === '$transaction') {
        return async (work: unknown, options: unknown) => {
          if (typeof work !== 'function') {
            return await value.call(object, work, options);
          }
          const result: unknown = await value.call(
            object,
            (tx: Queryable) => work(hookQueries(tx, hooks)),
            options
          );
          await hooks.afterTransaction?.(result);
          return result;
        };
      }
      return value.bind(object);
    },
  });
}

export const hookedSql = (hooks: SqlHooks): Sql => hookQueries(sql, hooks);

// markOutcomes is the only statement that decides outcomes; its text starts with this CTE.
export const isMarkOutcomes = (text: string) =>
  text.includes('WITH decided AS');
export const isMarkSendingResult = (
  result: unknown
): result is { sending: string[]; notRunning: boolean } =>
  typeof result === 'object' && result !== null && 'sending' in result;
export const isMarkOutcomesResult = (
  result: unknown
): result is { applied: number } =>
  typeof result === 'object' && result !== null && 'applied' in result;

export interface Delivery {
  profileId: string;
  seq: number;
  at: number;
}

let deliverySequence = 0;
export const nextSequence = () => {
  deliverySequence += 1;
  return deliverySequence;
};

export interface AdapterBehaviour {
  // A throw here is a crash after markSending and before the provider call.
  beforeSend?: (
    items: BatchItem[],
    opts: { signal?: AbortSignal; deadlineAt?: number }
  ) => Promise<void> | void;
  outcome?: (item: BatchItem) => DeliveryOutcome;
  // A throw here is a crash after the provider accepted, before markOutcomes.
  afterAccept?: (items: BatchItem[]) => Promise<void> | void;
  at?: () => number;
}

// The provider: every accepted ('sent') item is a delivery, whatever the dispatcher does next.
export function recordingAdapter(
  channel: CampaignChannel,
  behaviour: AdapterBehaviour = {}
): Delivery[] {
  const deliveries: Delivery[] = [];
  const adapter: BatchChannelAdapter<z.infer<typeof zFakeConfig>> = {
    id: channel,
    configSchema: zFakeConfig,
    maxBatch: 500,
    async sendBatch(items, _config, opts) {
      await behaviour.beforeSend?.(items, opts);
      const outcomes = items.map(
        (item) =>
          behaviour.outcome?.(item) ?? {
            profileId: item.profileId,
            outcome: 'sent' as const,
            providerRef: `ref-${item.profileId}`,
          }
      );
      for (const outcome of outcomes) {
        if (outcome.outcome === 'sent') {
          deliveries.push({
            profileId: outcome.profileId,
            seq: nextSequence(),
            at: behaviour.at?.() ?? Date.now(),
          });
        }
      }
      await behaviour.afterAccept?.(items);
      return outcomes;
    },
  };
  registerBatchAdapter(adapter);
  return deliveries;
}

export function deliveryCounts(deliveries: Delivery[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { profileId } of deliveries) {
    counts.set(profileId, (counts.get(profileId) ?? 0) + 1);
  }
  return counts;
}

const pad = (n: number) => String(n).padStart(6, '0');

export const pushMembers = (count: number, prefix = 'p'): FakeMember[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${pad(i)}`,
    values: {},
    traits: { name: `Name${i}` },
    devices: [{ token: `token-${prefix}-${pad(i)}`, platform: 'android' }],
  }));

export interface CampaignSetup {
  project: string;
  channel: CampaignChannel;
  recipients: string[];
  now: Date;
  template?: unknown;
  templateVersion?: number | null;
  frequencyCap?: { max: number; periodSeconds: number };
  settings?: Partial<ChannelSettings>;
}

export async function insertRunningCampaign(
  options: CampaignSetup
): Promise<string> {
  const id = randomUUID();
  const { project, channel, recipients, now } = options;
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, template_version,
       frequency_cap, confirm_threshold, created_by, materialize_state, started_at)
     VALUES ($1::uuid, $2, 'c', 'running', $3, $4::jsonb, $5, $6::jsonb, 5000, $7, 'done', $8)`,
    id,
    project,
    channel,
    JSON.stringify(options.template ?? PUSH_TEMPLATE),
    options.templateVersion ?? null,
    options.frequencyCap ? JSON.stringify(options.frequencyCap) : null,
    USER,
    now
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.campaign_counters (campaign_id, queued) VALUES ($1::uuid, $2)',
    id,
    recipients.length
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, due_at)
     SELECT $1::uuid, p, $2, $3::timestamptz FROM unnest($4::text[]) AS p`,
    id,
    project,
    now.toISOString(),
    recipients
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)',
    project,
    channel,
    encryptCredential(ENCRYPTION_KEY, JSON.stringify({ key: CHANNEL_SECRET }))
  );
  await putChannelSettings(
    sql,
    project,
    channel,
    { ...DEFAULT_CHANNEL_SETTINGS[channel], ...options.settings },
    0
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.audience_sources (project_id, kind, base_url) VALUES ($1, 'http', 'https://source.test')
     ON CONFLICT DO NOTHING`,
    project
  );
  return id;
}

export async function statuses(
  campaignId: string
): Promise<Record<string, number>> {
  const rows = await sql.$queryRawUnsafe<{ status: string; n: number }[]>(
    `SELECT status, count(*)::int AS n FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid GROUP BY status`,
    campaignId
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

export interface CampaignSnapshot {
  state: string;
  state_reason: string | null;
  dispatch_error: string | null;
  dispatch_retry_at: Date | null;
  sent: number;
  failed: number;
  skipped: number;
  uncertain: number;
}

export async function campaignSnapshot(
  campaignId: string
): Promise<CampaignSnapshot> {
  const [row] = await sql.$queryRawUnsafe<CampaignSnapshot[]>(
    `SELECT c.state, c.state_reason, c.dispatch_error, c.dispatch_retry_at,
       n.sent, n.failed, n.skipped, n.uncertain
     FROM marketing.campaigns c JOIN marketing.campaign_counters n ON n.campaign_id = c.id
     WHERE c.id = $1::uuid`,
    campaignId
  );
  if (!row) {
    throw new Error('campaign missing');
  }
  return row;
}

export interface RecipientRow {
  profile_id: string;
  status: string;
  reason: string | null;
  sent_at: Date | null;
}

export async function recipientRows(
  campaignId: string
): Promise<RecipientRow[]> {
  return await sql.$queryRawUnsafe<RecipientRow[]>(
    `SELECT profile_id, status, reason, sent_at FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid`,
    campaignId
  );
}

export interface Settlement {
  violations: {
    deliveredTwice: string[];
    missingRows: number;
    unfinished: string[];
    sentNotDelivered: string[];
    deliveredNotSent: string[];
    counterMismatch: string[];
  };
  rows: RecipientRow[];
}

// What a settled campaign must show: an assertion compares `violations` with this.
export const NO_VIOLATIONS: Settlement['violations'] = {
  deliveredTwice: [],
  missingRows: 0,
  unfinished: [],
  sentNotDelivered: [],
  deliveredNotSent: [],
  counterMismatch: [],
};

const COUNTED_STATUSES = ['sent', 'failed', 'skipped', 'uncertain'] as const;

// The governing rule: nobody delivered twice, every recipient in exactly one final status, counters agree.
export async function settlement(
  campaignId: string,
  total: number,
  deliveries: Delivery[]
): Promise<Settlement> {
  const counts = deliveryCounts(deliveries);
  const rows = await recipientRows(campaignId);
  const statusOf = new Map(rows.map((row) => [row.profile_id, row.status]));
  const withStatus = (status: string) =>
    rows.filter((row) => row.status === status);
  const snapshot = await campaignSnapshot(campaignId);
  return {
    rows,
    violations: {
      deliveredTwice: [...counts]
        .filter(([, n]) => n > 1)
        .map(([profileId]) => profileId),
      missingRows: total - rows.length,
      unfinished: rows
        .filter((row) => !FINAL_STATUSES.has(row.status))
        .map((row) => row.profile_id),
      sentNotDelivered: withStatus('sent')
        .filter((row) => counts.get(row.profile_id) !== 1)
        .map((row) => row.profile_id),
      deliveredNotSent: [...counts.keys()].filter(
        (profileId) =>
          statusOf.get(profileId) !== 'sent' &&
          statusOf.get(profileId) !== 'uncertain'
      ),
      counterMismatch: COUNTED_STATUSES.filter(
        (status) => snapshot[status] !== withStatus(status).length
      ),
    },
  };
}

export const reapAt = (deps: DispatchDeps) =>
  runReapTick({
    sql: deps.sql,
    campaigns: deps.campaigns,
    now: deps.now,
    secrets: [],
  });

// The next moment anything can happen without a dispatch: a retry time, a due row or a lease end.
const NEXT_EVENT_SQL = `SELECT LEAST(
    (SELECT min(c.dispatch_retry_at) FROM marketing.campaigns c
      WHERE c.state = 'running' AND c.dispatch_retry_at > $1::timestamptz),
    (SELECT min(r.due_at) FROM marketing.campaign_recipients r
      JOIN marketing.campaigns c ON c.id = r.campaign_id
      WHERE c.state = 'running' AND r.status = 'pending' AND r.due_at > $1::timestamptz),
    (SELECT min(r.lease_until) + interval '${ONE_MS} millisecond' FROM marketing.campaign_recipients r
      WHERE r.status IN ('leased', 'sending') AND r.lease_until >= $1::timestamptz)
  ) AS at`;

// Dispatches until no running campaign has work left, moving the clock to each next event and reaping on the way.
export async function drain(deps: DispatchDeps, clock: Clock): Promise<void> {
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    const result = await runDispatchCycle(deps);
    if (result.campaignId !== null) {
      continue;
    }
    await reapAt(deps);
    const [next] = await sql.$queryRawUnsafe<{ at: Date | null }[]>(
      NEXT_EVENT_SQL,
      clock.now().toISOString()
    );
    if (!next?.at) {
      return;
    }
    clock.moveTo(next.at);
    await reapAt(deps);
  }
  throw new Error('dispatch never drained');
}

const POLL_MS = 10;
const WAIT_LIMIT_MS = 60_000;

export async function waitUntil(
  check: () => Promise<boolean> | boolean,
  what: string,
  limitMs = WAIT_LIMIT_MS
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(POLL_MS);
  }
}
