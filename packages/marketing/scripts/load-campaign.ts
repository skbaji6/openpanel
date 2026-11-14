// Drives the real campaign dispatch lane (claim, lookup, mark, adapter, outcomes, completion) against a fake audience source and a fake provider.
// Usage: DATABASE_URL=<..._test database> REDIS_URL=... bun scripts/load-campaign.ts --mode noop|isolation|slow-api|fcm
//   [--recipients 20000] [--loops 2] [--delay-ms 2000] [--fcm-latency-ms 150] [--fcm-tokens-per-second 600]
// Prints one JSON line per run. Works under projects prefixed LOAD_PREFIX and removes them at the end. Refuses any database whose
// name does not end in _test unless MARKETING_LOAD_ALLOW=1. Exits 1 on duplicates, missing recipients, or a missed spec 6.4 target.

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { MarketingConfig } from '../src/config';

const LOAD_PREFIX = 'marketing-load-';
const CAMPAIGN_PROJECT = `${LOAD_PREFIX}campaign-${randomUUID()}`;
const JOURNEY_PROJECT = `${LOAD_PREFIX}journey-${randomUUID()}`;
const ENCRYPTION_KEY = 'a'.repeat(64);
const MODES = ['noop', 'isolation', 'slow-api', 'fcm'] as const;
type Mode = (typeof MODES)[number];

const MIN_SENDS_PER_SECOND = 1000;
const MAX_DURING_TO_IDLE_RATIO = 2;
const FCM_FINISH_LIMIT_MS = 600_000;
const DRAIN_LIMIT_MS = 1_800_000;
const JOURNEY_STEPS = 200;
const JOURNEY_TICK_MS = 1000;
const JOURNEY_LIMIT_MS = 120_000;
const LANE_IDLE_MS = 100;
const POLL_MS = 50;
const MS_PER_SECOND = 1000;
const CONFIRM_THRESHOLD = 1_000_000;
const PROFILE_DIGITS = 6;
const DECIMAL_PLACES = 1;
const MEDIAN_DIVISOR = 2;
const CFG = {
  encryptionKey: ENCRYPTION_KEY,
  leaseSeconds: 120,
  sourceConcurrency: 4,
  claimBatch: 200,
  sendConcurrency: 10,
  graceSeconds: 0,
  maxLatenessSeconds: 86_400,
  maxLag: 1000,
  tickMs: JOURNEY_TICK_MS,
  lookupWindowMs: 2000,
} as MarketingConfig;
const FAKE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'load',
  client_email: 'load@load.invalid',
  private_key: 'not-a-real-key',
});

const { values } = parseArgs({
  options: {
    mode: { type: 'string' },
    recipients: { type: 'string', default: '20000' },
    loops: { type: 'string', default: '2' },
    'delay-ms': { type: 'string', default: '2000' },
    'fcm-latency-ms': { type: 'string', default: '150' },
    'fcm-tokens-per-second': { type: 'string', default: '600' },
  },
});
const mode = values.mode as Mode;
if (!MODES.includes(mode)) {
  throw new Error(`--mode must be one of ${MODES.join(', ')}`);
}
const recipients = Number(values.recipients);
const loops = Number(values.loops);
const delayMs = Number(values['delay-ms']);
const fcmLatencyMs = Number(values['fcm-latency-ms']);
const fcmTokensPerSecond = Number(values['fcm-tokens-per-second']);

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  const database = new URL(url).pathname.replace(/^\//, '');
  const allowed =
    database.endsWith('_test') || process.env.MARKETING_LOAD_ALLOW === '1';
  if (!allowed) {
    throw new Error(
      `refusing to seed database "${database}": its name must end in _test (or set MARKETING_LOAD_ALLOW=1)`
    );
  }
}

assertTestDatabase();
process.env.LOG_SILENT ??= 'true';

const [
  { sql },
  { migrate },
  { getRedisCache },
  { createFakeSource },
  { createFakeFcm },
  { createPushAdapter },
  { createCampaignService },
  { createAudienceStore },
  { createTemplateRegistry },
  { createChannelBackoff, createRateBucket },
  { startDispatchLane },
  { registerAdapter, registerBatchAdapter, unregisterBatchAdapter },
  { DEFAULT_CHANNEL_SETTINGS, putChannelSettings },
  { createEngine },
  { createTickState, runTick },
  { encryptCredential },
  { z },
] = await Promise.all([
  import('../src/db/client'),
  import('../src/db/migrate'),
  import('@openpanel/redis'),
  import('../src/audience/fake-source'),
  import('../src/channels/fakes/fcm'),
  import('../src/channels/push'),
  import('../src/campaign/service'),
  import('../src/audience/store'),
  import('../src/templates/registry'),
  import('../src/campaign/pacing'),
  import('../src/campaign/dispatch-lane'),
  import('../src/channels/registry'),
  import('../src/channels/settings'),
  import('../src/engine/engine'),
  import('../src/engine/ticker'),
  import('@openpanel/shared/server'),
  import('zod'),
]);
type FakeMember = Parameters<typeof createFakeSource>[0]['members'][number];
type AudienceSource = ReturnType<typeof createFakeSource>;

const redis = getRedisCache();
const pad = (n: number) => String(n).padStart(PROFILE_DIGITS, '0');
const profileOf = (i: number) => `p-${pad(i)}`;
const tokenOf = (profileId: string) => profileId.replace('p-', 'token-');
const now = () => new Date();

async function cleanup() {
  for (const table of [
    'campaigns',
    'rules',
    'contacts',
    'channel_configs',
    'channel_settings',
  ]) {
    await sql.$executeRawUnsafe(
      `DELETE FROM marketing.${table} WHERE project_id LIKE $1`,
      `${LOAD_PREFIX}%`
    );
  }
  // Enrollments and steps do not cascade from rules.
  await sql.$executeRawUnsafe(
    `DELETE FROM marketing.steps WHERE enrollment_id IN
       (SELECT id FROM marketing.enrollments WHERE project_id LIKE $1)`,
    `${LOAD_PREFIX}%`
  );
  await sql.$executeRawUnsafe(
    'DELETE FROM marketing.enrollments WHERE project_id LIKE $1',
    `${LOAD_PREFIX}%`
  );
  await sql.$executeRawUnsafe(
    'DELETE FROM marketing.send_ledger WHERE project_id LIKE $1',
    `${LOAD_PREFIX}%`
  );
  for (const project of [CAMPAIGN_PROJECT, JOURNEY_PROJECT]) {
    const keys = await redis.keys(`*${project}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}

async function setChannelConfig(
  project: string,
  channel: string,
  config: unknown
) {
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)',
    project,
    channel,
    encryptCredential(ENCRYPTION_KEY, JSON.stringify(config))
  );
}

// ---- campaign side ----

// The provider's own view: how many times each profile reached it.
const providerSeen = new Map<string, number>();
const fakeFcm = createFakeFcm({
  latencyMs: fcmLatencyMs,
  tokensPerSecond: fcmTokensPerSecond,
});

function installProvider() {
  if (mode === 'fcm') {
    registerAdapter(createPushAdapter({ sendMulticast: fakeFcm }));
    return;
  }
  registerBatchAdapter({
    id: 'push',
    configSchema: z.object({ key: z.string() }),
    maxBatch: 500,
    async sendBatch(items) {
      return items.map((item) => {
        providerSeen.set(
          item.profileId,
          (providerSeen.get(item.profileId) ?? 0) + 1
        );
        return { profileId: item.profileId, outcome: 'sent' as const };
      });
    },
  });
}

function buildSource(members: FakeMember[]): AudienceSource {
  const inner = createFakeSource({ members });
  if (mode !== 'slow-api') {
    return inner;
  }
  return {
    ...inner,
    lookup: async (ids, channel) => {
      await Bun.sleep(delayMs);
      return await inner.lookup(ids, channel);
    },
  };
}

async function seedCampaign(profileIds: string[]): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold,
       created_by, materialize_state, started_at)
     VALUES ($1::uuid, $2, 'load', 'running', 'push', $3::jsonb, $4, 'load', 'done', now())`,
    id,
    CAMPAIGN_PROJECT,
    JSON.stringify({ subject: 'Hi', body: 'Hello {{profile.name}}' }),
    CONFIRM_THRESHOLD
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.campaign_counters (campaign_id, queued) VALUES ($1::uuid, $2)',
    id,
    profileIds.length
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, due_at)
     SELECT $1::uuid, p, $2, now() FROM unnest($3::text[]) AS p`,
    id,
    CAMPAIGN_PROJECT,
    profileIds
  );
  await setChannelConfig(
    CAMPAIGN_PROJECT,
    'push',
    mode === 'fcm' ? { serviceAccountJson: FAKE_SERVICE_ACCOUNT } : { key: 'k' }
  );
  await putChannelSettings(
    sql,
    CAMPAIGN_PROJECT,
    'push',
    DEFAULT_CHANNEL_SETTINGS.push,
    0
  );
  return id;
}

function laneFor(source: AudienceSource) {
  const resolve = async () => source;
  return startDispatchLane({
    sql,
    redis,
    cfg: CFG,
    sources: { forProject: resolve, invalidate: () => undefined },
    registry: createTemplateRegistry({ sql, now }),
    campaigns: createCampaignService({
      sql,
      cfg: CFG,
      audiences: createAudienceStore({ sql, source: resolve, now }),
      source: resolve,
      now,
    }),
    bucket: createRateBucket(redis, {}),
    backoff: createChannelBackoff(redis),
    renderUnsubscribeUrl: (_project, profileId, channel) =>
      `https://unsubscribe.invalid/${profileId}/${channel}`,
    now,
    sleep: (ms) => Bun.sleep(ms),
    concurrency: loops,
    idleMs: LANE_IDLE_MS,
    secrets: [],
  });
}

async function campaignState(id: string): Promise<string> {
  const [row] = await sql.$queryRawUnsafe<{ state: string }[]>(
    'SELECT state FROM marketing.campaigns WHERE id = $1::uuid',
    id
  );
  return row?.state ?? 'missing';
}

async function sentCount(id: string): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid AND status <> 'pending'`,
    id
  );
  return row?.n ?? 0;
}

// Returns false when the limit passed first.
async function waitUntil(
  check: () => Promise<boolean>,
  limitMs: number
): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      return false;
    }
    await Bun.sleep(POLL_MS);
  }
  return true;
}

function providerCount(profileId: string): number {
  return mode === 'fcm'
    ? (fakeFcm.delivered.get(tokenOf(profileId)) ?? 0)
    : (providerSeen.get(profileId) ?? 0);
}

async function audit(campaignId: string) {
  const rows = await sql.$queryRawUnsafe<
    { profile_id: string; status: string }[]
  >(
    'SELECT profile_id, status FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid',
    campaignId
  );
  const finalStatuses = new Set(['sent', 'failed', 'skipped', 'uncertain']);
  const statusCounts: Record<string, number> = {};
  let missing = recipients - rows.length;
  let uncertain = 0;
  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    uncertain += row.status === 'uncertain' ? 1 : 0;
    const undelivered =
      row.status === 'sent' && providerCount(row.profile_id) === 0;
    missing += !finalStatuses.has(row.status) || undelivered ? 1 : 0;
  }
  const duplicates = [
    ...(mode === 'fcm' ? fakeFcm.delivered : providerSeen).values(),
  ].filter((n) => n > 1).length;
  return { duplicates, missing, uncertain, statusCounts };
}

// ---- journey side ----

function registerJourneyAdapter() {
  registerAdapter({
    id: 'webhook',
    configSchema: z.object({ secret: z.string() }),
    send: async () => ({ ok: true as const }),
  });
}

async function seedJourneyProject() {
  await setChannelConfig(JOURNEY_PROJECT, 'webhook', { secret: 'load-secret' });
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.consumer_state (id, lag, updated_at) VALUES (1, 0, now())
     ON CONFLICT (id) DO UPDATE SET lag = 0, updated_at = now()`
  );
}

function startJourneyTicker() {
  const engine = createEngine({ sql, now });
  const state = createTickState();
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      await sql.$executeRawUnsafe(
        'UPDATE marketing.consumer_state SET lag = 0, updated_at = now() WHERE id = 1'
      );
      await runTick({
        sql,
        engine,
        cfg: CFG,
        now,
        state,
        renderUnsubscribeUrl: (project, profileId, channel) =>
          `https://unsubscribe.invalid/${project}/${profileId}/${channel}`,
        logger: { warn: () => undefined },
      });
      await Bun.sleep(JOURNEY_TICK_MS);
    }
  })();
  return async () => {
    stopped = true;
    await done;
  };
}

// Seeds due steps and returns the median of sent_at - due_at in ms.
async function measureJourneySteps(label: string): Promise<number> {
  const ruleId = randomUUID();
  const definition = {
    name: label,
    trigger: { event: 'purchase' },
    goal: { kind: 'event', event: 'opened' },
    steps: [{ delaySeconds: 1, channel: 'webhook', template: { body: 'w' } }],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
  };
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, $3, 'active', $4::jsonb)`,
    ruleId,
    JOURNEY_PROJECT,
    label,
    JSON.stringify(definition)
  );
  const dueAt = now().toISOString();
  await sql.$executeRawUnsafe(
    `WITH e AS (
       INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
       SELECT gen_random_uuid(), $1, $2::uuid, $3::jsonb, $4 || g, 'active', $5::timestamptz - interval '1 hour'
       FROM generate_series(1, $6::int) g RETURNING id
     )
     INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status)
     SELECT id, 0, $5::timestamptz, 'pending' FROM e`,
    JOURNEY_PROJECT,
    ruleId,
    JSON.stringify(definition),
    `${label}-`,
    dueAt,
    JOURNEY_STEPS
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.contacts (project_id, profile_id, email, attributes)
     SELECT $1, $2 || g, 'person@load.invalid', '{}'::jsonb FROM generate_series(1, $3::int) g`,
    JOURNEY_PROJECT,
    `${label}-`,
    JOURNEY_STEPS
  );
  const finished = await waitUntil(async () => {
    const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM marketing.steps s
       JOIN marketing.enrollments e ON e.id = s.enrollment_id
       WHERE e.rule_id = $1::uuid AND s.status IN ('pending', 'sending')`,
      ruleId
    );
    return (row?.n ?? 1) === 0;
  }, JOURNEY_LIMIT_MS);
  const latencies = await sql.$queryRawUnsafe<{ ms: number }[]>(
    `SELECT (extract(epoch FROM (s.sent_at - s.due_at)) * 1000)::float8 AS ms
     FROM marketing.steps s JOIN marketing.enrollments e ON e.id = s.enrollment_id
     WHERE e.rule_id = $1::uuid AND s.status = 'sent' ORDER BY ms`,
    ruleId
  );
  if (!finished || latencies.length !== JOURNEY_STEPS) {
    throw new Error(
      `${label}: ${latencies.length} of ${JOURNEY_STEPS} journey steps were sent`
    );
  }
  const mid = Math.floor(latencies.length / MEDIAN_DIVISOR);
  const median =
    latencies.length % MEDIAN_DIVISOR === 0
      ? ((latencies[mid - 1]?.ms ?? 0) + (latencies[mid]?.ms ?? 0)) /
        MEDIAN_DIVISOR
      : (latencies[mid]?.ms ?? 0);
  return Math.round(median);
}

// ---- run ----

async function main() {
  await migrate();
  await cleanup();
  installProvider();
  const profileIds = Array.from({ length: recipients }, (_, i) => profileOf(i));
  const members: FakeMember[] = profileIds.map((id, i) => ({
    id,
    values: {},
    traits: { name: `Name${i}` },
    devices: [{ token: tokenOf(id), platform: 'android' }],
  }));
  const campaignId = await seedCampaign(profileIds);
  const source = buildSource(members);

  let journeyIdleMedianMs: number | undefined;
  let journeyDuringMedianMs: number | undefined;
  let stopTicker: (() => Promise<void>) | undefined;
  if (mode === 'isolation') {
    registerJourneyAdapter();
    await seedJourneyProject();
    stopTicker = startJourneyTicker();
    journeyIdleMedianMs = await measureJourneySteps('idle');
  }

  const started = performance.now();
  const lane = laneFor(source);
  let overlapped = true;
  if (mode === 'isolation') {
    await waitUntil(
      async () => (await sentCount(campaignId)) > 0,
      DRAIN_LIMIT_MS
    );
    journeyDuringMedianMs = await measureJourneySteps('during');
    overlapped = (await campaignState(campaignId)) !== 'completed';
  }
  const limitMs = mode === 'fcm' ? FCM_FINISH_LIMIT_MS : DRAIN_LIMIT_MS;
  const finished = await waitUntil(
    async () => (await campaignState(campaignId)) === 'completed',
    limitMs - (performance.now() - started)
  );
  const elapsedMs = performance.now() - started;
  await lane.stop();
  await stopTicker?.();

  const { duplicates, missing, uncertain, statusCounts } =
    await audit(campaignId);
  const sendsPerSecond = recipients / (elapsedMs / MS_PER_SECOND);
  const line: Record<string, number | string> = {
    mode,
    recipients,
    elapsedMs: Math.round(elapsedMs),
    sendsPerSecond: Number(sendsPerSecond.toFixed(DECIMAL_PLACES)),
    duplicates,
    missing,
    uncertain,
  };
  if (mode === 'isolation') {
    line.journeyIdleMedianMs = journeyIdleMedianMs as number;
    line.journeyDuringMedianMs = journeyDuringMedianMs as number;
  }
  console.log(JSON.stringify(line));

  const problems: string[] = [];
  if (duplicates > 0 || missing > 0) {
    problems.push('duplicates or missing recipients');
  }
  if (!finished) {
    problems.push('campaign did not finish within the limit');
  }
  if ((statusCounts.sent ?? 0) !== recipients) {
    problems.push(`status counts ${JSON.stringify(statusCounts)}`);
  }
  if (mode === 'noop' && sendsPerSecond < MIN_SENDS_PER_SECOND) {
    problems.push(`below ${MIN_SENDS_PER_SECOND} sends/s`);
  }
  if (mode === 'slow-api' && uncertain > 0) {
    problems.push('uncertain recipients');
  }
  if (mode === 'isolation') {
    if (!overlapped) {
      problems.push('campaign finished before the journey steps did');
    }
    if (
      (journeyDuringMedianMs as number) >
      MAX_DURING_TO_IDLE_RATIO * (journeyIdleMedianMs as number)
    ) {
      problems.push(`journey median above ${MAX_DURING_TO_IDLE_RATIO}x idle`);
    }
  }
  if (mode === 'fcm' && elapsedMs > FCM_FINISH_LIMIT_MS) {
    problems.push(`not finished within ${FCM_FINISH_LIMIT_MS} ms`);
  }
  if (problems.length > 0) {
    console.error(`target missed: ${problems.join('; ')}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  unregisterBatchAdapter('push');
  await cleanup();
  await sql.$disconnect();
  redis.disconnect();
}
process.exit(process.exitCode ?? 0);
