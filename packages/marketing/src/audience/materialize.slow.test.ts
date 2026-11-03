import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { runMaterializeTick } from '../campaign/materialize-runner';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import type { FilterTree } from './contract';
import { createFakeSource } from './fake-source';
import type { AudienceSource } from './source';

const PROJECT = `slow-${randomUUID()}`;
const LANE_KEY = `marketing:source-sem:${PROJECT}:campaign-lane`;
const START = new Date('2026-11-03T10:00:00.000Z');
const IDS = 20_000;
const PAGE_DELAY_MS = 2000;
const LEASE_MS = 60_000;
const PRO: FilterTree = { dimension: 'plan', op: 'eq', values: ['pro'] };
const CFG = { sourceConcurrency: 4 } as MarketingConfig;
const TEST_TIMEOUT_MS = 120_000;

const redis = getRedisCache();
let clock = START.getTime();

const unusedSource = new Proxy({} as AudienceSource, {
  get: () => {
    throw new Error('a second runner claimed the campaign');
  },
});

const deps = (source: AudienceSource) => ({
  sql,
  sources: { forProject: async () => source, invalidate: () => undefined },
  redis,
  cfg: CFG,
  now: () => new Date(clock),
});

async function leaseUntil(id: string): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ until: Date }[]>(
    'SELECT materialize_lease_until AS until FROM marketing.campaigns WHERE id = $1::uuid',
    id
  );
  return (row?.until as Date).getTime();
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  clock = START.getTime();
  await resetMarketingTables();
  await redis.del(LANE_KEY);
});

afterAll(async () => {
  await redis.del(LANE_KEY);
  redis.disconnect();
});

describe('materialisation against a slow source', () => {
  it(
    'finishes 20,000 ids at 2 s per page, renewing the lease on every page',
    async () => {
      const fake = createFakeSource({
        members: Array.from({ length: IDS }, (_, i) => ({
          id: `pro-${String(i + 1).padStart(6, '0')}`,
          values: { plan: 'pro' },
        })),
        pageDelayMs: PAGE_DELAY_MS,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      const [audience] = await sql.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO marketing.audiences (id, project_id, name, mode, filter, created_by)
         VALUES (gen_random_uuid(), $1, 'a', 'dynamic', $2::jsonb, 'u1') RETURNING id::text`,
        PROJECT,
        JSON.stringify(PRO)
      );
      const [row] = await sql.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, audience_version,
           confirm_threshold, created_by, started_at)
         VALUES (gen_random_uuid(), $1, 'c', 'running', 'push', '{}'::jsonb, $2::uuid, 1, 100000, 'u1', $3)
         RETURNING id::text`,
        PROJECT,
        audience?.id,
        START
      );
      const id = row?.id as string;
      await sql.$executeRawUnsafe(
        'INSERT INTO marketing.campaign_counters (campaign_id) VALUES ($1::uuid)',
        id
      );

      // After each page's delay: the lease must reach LEASE_MS past the previous page's commit
      // and a second runner must find nothing to claim.
      let pages = 0;
      const source: AudienceSource = {
        ...fake,
        members: async (req) => {
          const page = await fake.members(req);
          pages += 1;
          if (pages > 1) {
            expect(await leaseUntil(id)).toBe(clock + LEASE_MS - PAGE_DELAY_MS);
          }
          const second = await runMaterializeTick(deps(unusedSource));
          expect(second.ran).toBe(0);
          return page;
        },
      };

      const first = await runMaterializeTick(deps(source));
      expect(first.ran).toBe(1);
      expect(pages).toBeGreaterThanOrEqual(IDS / 1000);

      const [state] = await sql.$queryRawUnsafe<
        { materialize_state: string; state: string }[]
      >(
        'SELECT materialize_state, state FROM marketing.campaigns WHERE id = $1::uuid',
        id
      );
      expect(state).toEqual({ materialize_state: 'done', state: 'running' });
      const [counts] = await sql.$queryRawUnsafe<
        { total: number; distinct: number }[]
      >(
        `SELECT count(*)::int AS total, count(DISTINCT profile_id)::int AS distinct
         FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid`,
        id
      );
      expect(counts).toEqual({ total: IDS, distinct: IDS });
    },
    TEST_TIMEOUT_MS
  );
});
