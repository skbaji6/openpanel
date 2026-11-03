// Materialises a campaign audience from a fake source and reports the plugin's own time.
// Usage: DATABASE_URL=<..._test database> REDIS_URL=... bun scripts/load-materialize.ts [--ids 20000] [--page 1000] [--delay-ms 0]
// Works under project id LOAD_PREFIX and removes it at the end. Refuses any database whose name does not end in _test
// unless MARKETING_LOAD_ALLOW=1. Exits 1 on duplicates, missing ids, or (with --delay-ms 0) plugin time at the spec 6.4 target.

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { MarketingConfig } from '../src/config';

const LOAD_PREFIX = 'marketing-load-';
const PROJECT = `${LOAD_PREFIX}materialize-${randomUUID()}`;
const PLUGIN_TARGET_MS = 5000;
const BYTES_PER_MB = 1024 * 1024;
const CONFIRM_THRESHOLD = 1_000_000;
const CFG = { sourceConcurrency: 4 } as MarketingConfig;

const { values } = parseArgs({
  options: {
    ids: { type: 'string', default: '20000' },
    page: { type: 'string', default: '1000' },
    'delay-ms': { type: 'string', default: '0' },
  },
});
const ids = Number(values.ids);
const pageSize = Number(values.page);
const delayMs = Number(values['delay-ms']);

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
  { runMaterializeTick },
  { createFakeSource },
  { getRedisCache },
] = await Promise.all([
  import('../src/db/client'),
  import('../src/db/migrate'),
  import('../src/campaign/materialize-runner'),
  import('../src/audience/fake-source'),
  import('@openpanel/redis'),
]);

const redis = getRedisCache();
const pad = (n: number) => String(n).padStart(String(ids).length, '0');

async function cleanup() {
  await sql.$executeRawUnsafe(
    'DELETE FROM marketing.campaigns WHERE project_id LIKE $1',
    `${LOAD_PREFIX}%`
  );
  await sql.$executeRawUnsafe(
    'DELETE FROM marketing.audiences WHERE project_id LIKE $1',
    `${LOAD_PREFIX}%`
  );
  await redis.del(`marketing:source-sem:${PROJECT}:campaign-lane`);
}

async function main() {
  await migrate();
  await cleanup();
  const filter = { dimension: 'plan', op: 'eq', values: ['pro'] };
  const [audience] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.audiences (id, project_id, name, mode, filter, created_by)
     VALUES (gen_random_uuid(), $1, 'load', 'dynamic', $2::jsonb, 'load') RETURNING id::text`,
    PROJECT,
    JSON.stringify(filter)
  );
  const [campaign] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, audience_version,
       confirm_threshold, created_by, started_at)
     VALUES (gen_random_uuid(), $1, 'load', 'running', 'push', '{}'::jsonb, $2::uuid, 1, $3, 'load', now())
     RETURNING id::text`,
    PROJECT,
    audience?.id,
    CONFIRM_THRESHOLD
  );
  const campaignId = campaign?.id as string;
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.campaign_counters (campaign_id) VALUES ($1::uuid)',
    campaignId
  );

  const fake = createFakeSource({
    members: Array.from({ length: ids }, (_, i) => ({
      id: `load-${pad(i + 1)}`,
      values: { plan: 'pro' },
    })),
    pageDelayMs: delayMs,
  });
  let pages = 0;
  const source = {
    ...fake,
    members: async (req: Parameters<typeof fake.members>[0]) => {
      pages += 1;
      return await fake.members({
        ...req,
        limit: Math.min(req.limit, pageSize),
      });
    },
  };

  const started = performance.now();
  await runMaterializeTick({
    sql,
    sources: { forProject: async () => source, invalidate: () => undefined },
    redis,
    cfg: CFG,
    now: () => new Date(),
  });
  const totalMs = performance.now() - started;
  const sourceMs = fake.sourceTimeMs();
  const pluginMs = totalMs - sourceMs;

  const [counts] = await sql.$queryRawUnsafe<
    { total: number; distinct: number }[]
  >(
    `SELECT count(*)::int AS total, count(DISTINCT profile_id)::int AS distinct
     FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid`,
    campaignId
  );
  const duplicates = (counts?.total ?? 0) - (counts?.distinct ?? 0);
  const missing = ids - (counts?.distinct ?? 0);
  const rssMb = process.memoryUsage().rss / BYTES_PER_MB;
  console.log(
    `ids=${ids} pages=${pages} total=${totalMs.toFixed(0)} ms source=${sourceMs.toFixed(0)} ms plugin=${pluginMs.toFixed(0)} ms duplicates=${duplicates} missing=${missing} rss=${rssMb.toFixed(0)} MB`
  );
  const overTarget = delayMs === 0 && pluginMs >= PLUGIN_TARGET_MS;
  if (duplicates > 0 || missing > 0 || overTarget) {
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await cleanup();
  await sql.$disconnect();
  redis.disconnect();
}
process.exit(process.exitCode ?? 0);
