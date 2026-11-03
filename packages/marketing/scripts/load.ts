// Load check against the Global Constraints targets: claim query time with 1,000,000 pending steps,
// consumer throughput with 95% of events pre-filtered out, and one 200-step tick.
// Usage: DATABASE_URL=<..._test database> REDIS_URL=... bun scripts/load.ts
// Seeds into schema marketing only, under project ids starting with LOAD_PREFIX, and removes them at the end
// (MARKETING_LOAD_KEEP=1 keeps them). Refuses any database whose name does not end in _test unless MARKETING_LOAD_ALLOW=1.

import { randomUUID } from 'node:crypto';
import type { MarketingConfig } from '../src/config';

const LOAD_PREFIX = 'marketing-load-';
const FILTER_PROJECT = `${LOAD_PREFIX}filter`;
const KEEP_ALL_PROJECT = `${LOAD_PREFIX}keep-all`;
const TRIGGER_EVENT = 'load_trigger';
const KEEP_ALL_TRIGGER_EVENT = 'load_trigger_keep_all';
const GOAL_EVENT = 'load_goal';
const ACTIVITY_EVENT = 'page_view';

const ENROLLMENTS = 100_000;
const STEPS_PER_ENROLLMENT = 10;
const SEED_CHUNK = 10_000;
// Enrollments whose first step is already due; the rest are due in the future.
const DUE_ENROLLMENTS = 10_000;
const STEP_SPACING_HOURS = 1;

const CLAIM_RUNS = 25;
const TICK_RUNS = 3;
const EVENTS_PER_RUN = 100_000;
// One in INTEREST_EVERY events survives the pre-filter (5%).
const INTEREST_EVERY = 20;
const KAFKA_BATCH = 1000;
const KEEP_ALL_PROFILES = 5000;
const P95 = 0.95;
const TIMING_LABEL_LENGTH = 70;
const TIMING_TOP_STATEMENTS = 6;

const CLAIM_TARGET_MS = 50;
const THROUGHPUT_TARGET = 2000;

const ENCRYPTION_KEY = 'a'.repeat(64);
const CFG: MarketingConfig = {
  databaseUrl: '',
  redisUrl: '',
  encryptionKey: ENCRYPTION_KEY,
  proxySecret: '',
  publicUrl: 'https://marketing.load',
  port: 0,
  trustProxy: false,
  graceSeconds: 300,
  maxLag: 1000,
  tickMs: 5000,
  leaseSeconds: 120,
  retentionDays: 30,
  claimBatch: 200,
  sendConcurrency: 10,
  dbPool: 10,
  sourceConcurrency: 4,
  lookupWindowMs: 2000,
  maxLatenessSeconds: 86_400,
  confirmThreshold: 5000,
  webhookAllowHosts: [],
  kafka: { brokers: [], clientId: '', topic: '', groupId: '', ssl: false },
};

const ROLLBACK = new Error('rollback');

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
  { createEngine },
  { CLAIM_SQL, createTickState, runTick },
  { registerAdapter },
  { createBatchHandler },
  { createMemoryInterestSet, createRedisInterestSet, INTEREST_PROFILES_KEY },
  { getRedisCache },
  { encryptCredential },
  { z },
] = await Promise.all([
  import('../src/db/client'),
  import('../src/db/migrate'),
  import('../src/engine/engine'),
  import('../src/engine/ticker'),
  import('../src/channels/registry'),
  import('../src/kafka/consumer'),
  import('../src/kafka/interest'),
  import('@openpanel/redis'),
  import('@openpanel/shared/server'),
  import('zod'),
]);

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return { median: at(0.5), p95: at(P95), min: sorted[0] ?? 0 };
}

const ms = (value: number) => `${value.toFixed(1)} ms`;
const verdict = (pass: boolean) => (pass ? 'PASS' : 'MISS');

function ruleDefinition(trigger: string, goal: unknown) {
  return {
    name: `load ${trigger}`,
    trigger: { event: trigger },
    goal,
    steps: Array.from({ length: STEPS_PER_ENROLLMENT }, (_unused, index) => ({
      delaySeconds: (index + 1) * STEP_SPACING_HOURS * 3600,
      channel: 'webhook',
      template: { body: `load step ${index}` },
    })),
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
  };
}

async function insertRule(projectId: string, definition: unknown) {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, 'load', 'active', $3::jsonb)`,
    id,
    projectId,
    JSON.stringify(definition)
  );
  return id;
}

// Params: project, rule, snapshot, now, first g, last g. Enrollments g <= DUE_ENROLLMENTS start due.
const SEED_CHUNK_SQL = `
  WITH enrollment AS (
    INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
    SELECT gen_random_uuid(), $1, $2::uuid, $3::jsonb, 'load-profile-' || g, 'active',
      CASE WHEN g <= ${DUE_ENROLLMENTS}
        THEN $4::timestamptz - interval '2 hours' - g * interval '1 second'
        ELSE $4::timestamptz + g * interval '1 second' END
    FROM generate_series($5::int, $6::int) g
    RETURNING id, trigger_time
  )
  INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status)
  SELECT enrollment.id, step,
    enrollment.trigger_time + (step + 1) * interval '${STEP_SPACING_HOURS} hour', 'pending'
  FROM enrollment, generate_series(0, ${STEPS_PER_ENROLLMENT - 1}) step`;

async function seed(now: Date) {
  const definition = ruleDefinition(TRIGGER_EVENT, {
    kind: 'event',
    event: GOAL_EVENT,
  });
  const ruleId = await insertRule(FILTER_PROJECT, definition);
  await insertRule(
    KEEP_ALL_PROJECT,
    ruleDefinition(KEEP_ALL_TRIGGER_EVENT, {
      kind: 'inactivity',
      excludeEvents: [],
    })
  );
  const started = performance.now();
  for (let first = 1; first <= ENROLLMENTS; first += SEED_CHUNK) {
    await sql.$executeRawUnsafe(
      SEED_CHUNK_SQL,
      FILTER_PROJECT,
      ruleId,
      JSON.stringify(definition),
      now.toISOString(),
      first,
      Math.min(first + SEED_CHUNK - 1, ENROLLMENTS)
    );
  }
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, 'webhook', $2)`,
    FILTER_PROJECT,
    encryptCredential(ENCRYPTION_KEY, '{}')
  );
  for (const table of ['steps', 'enrollments', 'rules', 'events']) {
    await sql.$executeRawUnsafe(`ANALYZE marketing.${table}`);
  }
  const [counts] = await sql.$queryRawUnsafe<
    { pending: number; active: number }[]
  >(
    `SELECT (SELECT count(*) FROM marketing.steps WHERE status = 'pending')::int AS pending,
            (SELECT count(*) FROM marketing.enrollments WHERE status = 'active')::int AS active`
  );
  console.log(
    `seeded ${counts?.pending} pending steps, ${counts?.active} active enrollments in ${((performance.now() - started) / 1000).toFixed(1)} s (ANALYZE done)`
  );
}

function claimParams(now: Date) {
  return [
    now.toISOString(),
    new Date(now.getTime() - CFG.graceSeconds * 1000).toISOString(),
    CFG.claimBatch,
    new Date(now.getTime() + CFG.leaseSeconds * 1000).toISOString(),
  ];
}

// The claim updates rows, so every run is rolled back to keep the data identical between runs.
async function inRolledBackTransaction<T>(
  work: (tx: Pick<typeof sql, '$queryRawUnsafe'>) => Promise<T>
): Promise<T> {
  let result: T | undefined;
  try {
    await sql.$transaction(
      async (tx) => {
        result = await work(tx);
        throw ROLLBACK;
      },
      { timeout: 60_000 }
    );
  } catch (error) {
    if (error !== ROLLBACK) {
      throw error;
    }
  }
  return result as T;
}

async function measureClaim() {
  const samples: number[] = [];
  let claimed = 0;
  for (let run = 0; run < CLAIM_RUNS; run++) {
    const elapsed = await inRolledBackTransaction(async (tx) => {
      const started = performance.now();
      const rows = await tx.$queryRawUnsafe<unknown[]>(
        CLAIM_SQL,
        ...claimParams(new Date())
      );
      claimed = rows.length;
      return performance.now() - started;
    });
    samples.push(elapsed);
  }
  const plan = await inRolledBackTransaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
      `EXPLAIN (ANALYZE, BUFFERS) ${CLAIM_SQL}`,
      ...claimParams(new Date())
    );
    return rows.map((row) => Object.values(row).join(' '));
  });
  const { median, p95 } = stats(samples);
  console.log(
    `\n(a) claim query, ${CLAIM_RUNS} runs, ${claimed} rows claimed per run: median ${ms(median)}, p95 ${ms(p95)}`
  );
  console.log('EXPLAIN (ANALYZE, BUFFERS):');
  for (const line of plan) {
    console.log(`  ${line}`);
  }
  const indexes = ['steps_pending_due_idx', 'steps_sending_lease_idx'].filter(
    (index) => plan.some((line) => line.includes(index))
  );
  console.log(`indexes used: ${indexes.join(', ') || 'none'}`);
  return { median, p95 };
}

interface QueryTimings {
  totals: Map<string, { calls: number; ms: number }>;
  claimStart: number;
  claimEnd: number;
}

function statementLabel(prop: string | symbol, args: unknown[]): string {
  if (prop === '$transaction') {
    return 'transaction (profile-locked writes)';
  }
  const text = typeof args[0] === 'string' ? args[0] : String(prop);
  return text.trim().split('\n')[0]?.slice(0, TIMING_LABEL_LENGTH) ?? '';
}

// Times every top-level statement runTick sends; statements inside a transaction count toward it.
function timedSql(timings: QueryTimings): typeof sql {
  return new Proxy(sql, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      return async (...args: unknown[]) => {
        const started = performance.now();
        try {
          return await value.apply(target, args);
        } finally {
          const ended = performance.now();
          const label = statementLabel(prop, args);
          const total = timings.totals.get(label) ?? { calls: 0, ms: 0 };
          total.calls += 1;
          total.ms += ended - started;
          timings.totals.set(label, total);
          if (args[0] === CLAIM_SQL) {
            timings.claimStart = started;
            timings.claimEnd = ended;
          }
        }
      };
    },
  });
}

async function measureTick() {
  registerAdapter({
    id: 'webhook',
    configSchema: z.object({}),
    send: () => Promise.resolve({ ok: true }),
  });
  const engine = createEngine({ sql });
  const healSweep = createTickState();
  const samples: number[] = [];
  const lines: string[] = [];
  for (let run = 0; run < TICK_RUNS; run++) {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.consumer_state (id, lag, updated_at) VALUES (1, 0, $1::timestamptz)
       ON CONFLICT (id) DO UPDATE SET lag = 0, updated_at = EXCLUDED.updated_at`,
      new Date().toISOString()
    );
    const timings: QueryTimings = {
      totals: new Map(),
      claimStart: 0,
      claimEnd: 0,
    };
    const started = performance.now();
    const result = await runTick({
      sql: timedSql(timings),
      engine,
      cfg: CFG,
      now: () => new Date(),
      renderUnsubscribeUrl: () => 'https://marketing.load/u',
      state: healSweep,
    });
    const ended = performance.now();
    samples.push(ended - started);
    lines.push(
      `    tick ${run + 1}: ${ms(ended - started)} = before claim (lag gate, sweep) ${ms(timings.claimStart - started)}, claim ${ms(timings.claimEnd - timings.claimStart)}, send pool ${ms(ended - timings.claimEnd)}; ${JSON.stringify(result)}`
    );
    const top = [...timings.totals.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, TIMING_TOP_STATEMENTS);
    for (const [label, total] of top) {
      lines.push(
        `      ${String(total.calls).padStart(4)} x ${ms(total.ms).padStart(10)}  ${label}`
      );
    }
  }
  const { median } = stats(samples);
  console.log(
    `\n(c) runTick, ${CFG.claimBatch}-step batch, no-op adapter, concurrency ${CFG.sendConcurrency}: ${samples.map(ms).join(', ')} (median ${ms(median)})`
  );
  console.log(
    '    summed statement time per kind (concurrent, so sums exceed wall time):'
  );
  for (const line of lines) {
    console.log(line);
  }
  return { median };
}

function message(projectId: string, name: string, profileId: string) {
  return Buffer.from(
    JSON.stringify({
      id: randomUUID(),
      projectId,
      deviceId: 'load-device',
      event: {
        name,
        profileId,
        properties: { path: '/load', referrer: 'https://example.test' },
        timestamp: new Date().toISOString(),
      },
    })
  );
}

// 1 in INTEREST_EVERY is kept: alternately a trigger for a new profile and activity of an enrolled one.
function filterProjectEvents(run: string): Buffer[] {
  return Array.from({ length: EVENTS_PER_RUN }, (_unused, index) => {
    if (index % INTEREST_EVERY !== 0) {
      return message(FILTER_PROJECT, ACTIVITY_EVENT, `anon-${run}-${index}`);
    }
    if (index % (INTEREST_EVERY * 2) === 0) {
      return message(FILTER_PROJECT, TRIGGER_EVENT, `new-${run}-${index}`);
    }
    return message(
      FILTER_PROJECT,
      ACTIVITY_EVENT,
      `load-profile-${(index % ENROLLMENTS) + 1}`
    );
  });
}

function keepAllProjectEvents(): Buffer[] {
  return Array.from({ length: EVENTS_PER_RUN }, (_unused, index) =>
    message(
      KEEP_ALL_PROJECT,
      ACTIVITY_EVENT,
      `keep-all-${index % KEEP_ALL_PROFILES}`
    )
  );
}

async function throughput(
  label: string,
  interest: Awaited<ReturnType<typeof createMemoryInterestSet>>,
  values: Buffer[]
) {
  const engine = createEngine({ sql });
  let kept = 0;
  const handle = createBatchHandler({
    engine: {
      handleEvents: (events) => {
        kept += events.length;
        return engine.handleEvents(events);
      },
    },
    interest,
  });
  const started = performance.now();
  for (let first = 0; first < values.length; first += KAFKA_BATCH) {
    await handle(values.slice(first, first + KAFKA_BATCH));
  }
  const seconds = (performance.now() - started) / 1000;
  const perSecond = values.length / seconds;
  console.log(
    `    ${label}: ${values.length} events (${kept} kept) in ${seconds.toFixed(2)} s = ${Math.round(perSecond)} events/s`
  );
  return perSecond;
}

async function measureThroughput() {
  const engine = createEngine({ sql });
  const redis = getRedisCache();
  const redisInterest = createRedisInterestSet(redis, { engine, sql });
  const memoryInterest = createMemoryInterestSet({ engine, sql });
  const refreshStarted = performance.now();
  await redisInterest.refresh();
  console.log(
    `\n(b) consumer batch handler (batches of ${KAFKA_BATCH}); Redis interest refresh took ${ms(performance.now() - refreshStarted)}`
  );
  await memoryInterest.refresh();
  const redisRate = await throughput(
    'filter project, Redis interest set',
    redisInterest,
    filterProjectEvents('redis')
  );
  const memoryRate = await throughput(
    'filter project, in-memory interest set',
    memoryInterest,
    filterProjectEvents('memory')
  );
  const keepAllRate = await throughput(
    'keep-all project (inactivity rule), Redis interest set',
    redisInterest,
    keepAllProjectEvents()
  );
  return { redisRate, memoryRate, keepAllRate };
}

async function cleanup() {
  const like = `${LOAD_PREFIX}%`;
  await sql.$executeRawUnsafe(
    `DELETE FROM marketing.steps s USING marketing.enrollments e
     WHERE e.id = s.enrollment_id AND e.project_id LIKE $1`,
    like
  );
  for (const table of ['enrollments', 'rules', 'events', 'channel_configs']) {
    await sql.$executeRawUnsafe(
      `DELETE FROM marketing.${table} WHERE project_id LIKE $1`,
      like
    );
  }
  await getRedisCache().del(INTEREST_PROFILES_KEY);
}

// Rows of other projects (e.g. left by a test run) would be claimed by the measured ticks.
async function assertNoForeignRows() {
  const [row] = await sql.$queryRawUnsafe<{ other_rows: number }[]>(
    'SELECT count(*)::int AS other_rows FROM marketing.enrollments WHERE project_id NOT LIKE $1',
    `${LOAD_PREFIX}%`
  );
  if (row?.other_rows) {
    throw new Error(
      `marketing.enrollments holds ${row.other_rows} rows of other projects; empty the test schema's tables before a load run`
    );
  }
}

async function main() {
  await migrate();
  await cleanup();
  await assertNoForeignRows();
  const [consumerState] = await sql.$queryRawUnsafe<unknown[]>(
    'SELECT 1 FROM marketing.consumer_state WHERE id = 1'
  );
  try {
    await seed(new Date());
    const claim = await measureClaim();
    const tick = await measureTick();
    const rates = await measureThroughput();
    console.log(
      '\nmeasurement                                   measured        target       result'
    );
    console.log(
      `claim query p95 (1M pending steps)            ${ms(claim.p95).padEnd(15)} < ${CLAIM_TARGET_MS} ms      ${verdict(claim.p95 < CLAIM_TARGET_MS)}`
    );
    console.log(
      `consumer, 95% filtered (Redis interest)       ${`${Math.round(rates.redisRate)}/s`.padEnd(15)} >= ${THROUGHPUT_TARGET}/s    ${verdict(rates.redisRate >= THROUGHPUT_TARGET)}`
    );
    console.log(
      `consumer, 95% filtered (in-memory interest)   ${`${Math.round(rates.memoryRate)}/s`.padEnd(15)} >= ${THROUGHPUT_TARGET}/s    ${verdict(rates.memoryRate >= THROUGHPUT_TARGET)}`
    );
    console.log(
      `consumer, keep-all project (none filtered)    ${`${Math.round(rates.keepAllRate)}/s`.padEnd(15)} (no target; 0% filtered)`
    );
    console.log(
      `runTick, 200-step batch, no-op adapter        ${ms(tick.median).padEnd(15)} (no target)`
    );
  } finally {
    if (process.env.MARKETING_LOAD_KEEP === '1') {
      console.log('\nMARKETING_LOAD_KEEP=1: seeded rows kept');
    } else {
      await cleanup();
      if (!consumerState) {
        await sql.$executeRawUnsafe('DELETE FROM marketing.consumer_state');
      }
      console.log('\ncleaned up seeded rows');
    }
  }
}

try {
  await main();
} finally {
  await sql.$disconnect();
  getRedisCache().disconnect();
}
process.exit(0);
