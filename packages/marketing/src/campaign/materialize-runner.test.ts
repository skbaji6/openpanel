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
import type { FilterTree } from '../audience/contract';
import {
  SourceAuthError,
  SourceProtocolError,
  SourceUnavailableError,
} from '../audience/errors';
import { createFakeSource } from '../audience/fake-source';
import type { SourceResolver } from '../audience/resolver';
import type { AudienceSource } from '../audience/source';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { runMaterializeTick } from './materialize-runner';

const PROJECT = `runner-${randomUUID()}`;
const LANE_KEY = `marketing:source-sem:${PROJECT}:campaign-lane`;
const START = new Date('2026-11-03T10:00:00.000Z');
const SECOND_MS = 1000;
const LEASE_SECONDS = 60;
const RETRY_SECONDS = 30;
const MATCHING = 3000;
const PAGE_SIZE = 1000;
const MAX_PROTOCOL_ATTEMPTS = 5;
const PRO: FilterTree = { dimension: 'plan', op: 'eq', values: ['pro'] };
const CFG = { sourceConcurrency: 4 } as MarketingConfig;
const POLL_STEP_MS = 10;

const redis = getRedisCache();
let now = START;

const pad = (n: number) => String(n).padStart(6, '0');
const proIds = (count = MATCHING) =>
  Array.from({ length: count }, (_, i) => `pro-${pad(i + 1)}`);
const fake = () =>
  createFakeSource({
    members: proIds().map((id) => ({ id, values: { plan: 'pro' } })),
  });
const advance = (seconds: number) => {
  now = new Date(now.getTime() + seconds * SECOND_MS);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolverOf(source: AudienceSource | null): SourceResolver {
  return { forProject: async () => source, invalidate: () => undefined };
}

// Runs `before` ahead of each members call, numbered from 1.
function hooked(
  inner: AudienceSource,
  before: (call: number) => Promise<void> | void
): AudienceSource & { calls: () => number } {
  let calls = 0;
  return {
    ...inner,
    members: async (req) => {
      calls += 1;
      await before(calls);
      return await inner.members(req);
    },
    calls: () => calls,
  };
}

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const tick = (source: AudienceSource | null) =>
  runMaterializeTick({
    sql,
    sources: resolverOf(source),
    redis,
    cfg: CFG,
    now: () => now,
  });

async function insertCampaign(): Promise<string> {
  const [audience] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.audiences (id, project_id, name, mode, filter, created_by)
     VALUES (gen_random_uuid(), $1, 'a', 'dynamic', $2::jsonb, 'u1') RETURNING id::text`,
    PROJECT,
    JSON.stringify(PRO)
  );
  const [row] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, audience_version,
       confirm_threshold, created_by, started_at)
     VALUES (gen_random_uuid(), $1, 'c', 'running', 'push', '{}'::jsonb, $2::uuid, 1, 5000, 'u1', $3)
     RETURNING id::text`,
    PROJECT,
    audience?.id,
    now
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.campaign_counters (campaign_id) VALUES ($1::uuid)',
    row?.id
  );
  return row?.id as string;
}

interface CampaignState {
  state: string;
  state_reason: string | null;
  materialize_state: string;
  materialize_error: string | null;
  materialize_attempts: number;
  materialize_retry_at: Date | null;
  materialize_lease_token: string | null;
  queued: number;
  skipped: number;
}

async function campaign(id: string): Promise<CampaignState> {
  const [row] = await sql.$queryRawUnsafe<CampaignState[]>(
    `SELECT c.state, c.state_reason, c.materialize_state, c.materialize_error, c.materialize_attempts,
       c.materialize_retry_at, c.materialize_lease_token::text, n.queued, n.skipped
     FROM marketing.campaigns c JOIN marketing.campaign_counters n ON n.campaign_id = c.id
     WHERE c.id = $1::uuid`,
    id
  );
  return row as CampaignState;
}

async function recipients(id: string, status?: string): Promise<string[]> {
  const rows = await sql.$queryRawUnsafe<{ profile_id: string }[]>(
    `SELECT profile_id FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid AND ($2::text IS NULL OR status = $2)
     ORDER BY profile_id`,
    id,
    status ?? null
  );
  return rows.map((row) => row.profile_id);
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  now = START;
  await resetMarketingTables();
  await redis.del(LANE_KEY);
});

afterAll(async () => {
  await redis.del(LANE_KEY);
  redis.disconnect();
});

describe('runMaterializeTick', () => {
  it('materialises 3,000 ids and sets queued 3,000', async () => {
    const id = await insertCampaign();
    expect(await tick(fake())).toEqual({ ran: 1 });
    expect(await recipients(id, 'pending')).toEqual(proIds());
    expect(await campaign(id)).toMatchObject({
      state: 'running',
      materialize_state: 'done',
      materialize_lease_token: null,
      queued: MATCHING,
      skipped: 0,
    });
    expect(await tick(fake())).toEqual({ ran: 0 });
  });

  it('counts recipients who already received the campaign key as skipped', async () => {
    const earlier = await insertCampaign();
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET state = 'completed', campaign_key = 'k', materialize_state = 'done'
       WHERE id = $1::uuid`,
      earlier
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status)
       SELECT $1::uuid, unnest($2::text[]), $3, 'sent'`,
      earlier,
      proIds(10),
      PROJECT
    );
    const id = await insertCampaign();
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET campaign_key = 'k', skip_previous_recipients = true WHERE id = $1::uuid`,
      id
    );
    expect(await tick(fake())).toEqual({ ran: 1 });
    expect(await campaign(id)).toMatchObject({
      queued: MATCHING - 10,
      skipped: 10,
    });
  });

  it('a source down for 60 s (fake clock) leaves the campaign running with source_unavailable, no failed mark, and a later tick completes with the exact set and no duplicates', async () => {
    const id = await insertCampaign();
    const upAt = now.getTime() + LEASE_SECONDS * SECOND_MS;
    const source = hooked(fake(), (call) => {
      if (call > 1 && now.getTime() < upAt) {
        throw new SourceUnavailableError('down');
      }
    });
    expect(await tick(source)).toEqual({ ran: 1 });
    expect(await recipients(id)).toHaveLength(PAGE_SIZE);
    expect(await campaign(id)).toMatchObject({
      state: 'running',
      materialize_state: 'in_progress',
      materialize_error: 'source_unavailable',
      materialize_attempts: 0,
      materialize_retry_at: new Date(now.getTime() + RETRY_SECONDS * SECOND_MS),
    });
    expect(await tick(source)).toEqual({ ran: 0 });

    advance(RETRY_SECONDS);
    expect(await tick(source)).toEqual({ ran: 1 });
    expect((await campaign(id)).materialize_state).toBe('in_progress');

    advance(RETRY_SECONDS);
    expect(await tick(source)).toEqual({ ran: 1 });
    expect(await recipients(id, 'pending')).toEqual(proIds());
    expect(await campaign(id)).toMatchObject({
      state: 'running',
      materialize_state: 'done',
      queued: MATCHING,
    });
  });

  it("an expired lease is taken over by a second runner and the first runner's next saveProgress returns lost_claim", async () => {
    const id = await insertCampaign();
    const stuck = gate();
    const reached = gate();
    const first = hooked(fake(), async (call) => {
      if (call === 2) {
        reached.open();
        await stuck.opened;
      }
    });
    const firstRun = tick(first);
    await reached.opened;
    expect(await recipients(id)).toHaveLength(PAGE_SIZE);

    advance(LEASE_SECONDS + 1);
    expect(await tick(fake())).toEqual({ ran: 1 });
    const done = await campaign(id);
    expect(done.materialize_state).toBe('done');

    stuck.open();
    expect(await firstRun).toEqual({ ran: 1 });
    expect(first.calls()).toBe(2);
    expect(await campaign(id)).toEqual(done);
    expect(await recipients(id, 'pending')).toEqual(proIds());
  });

  it('two runners in parallel never materialise the same campaign at once', async () => {
    const id = await insertCampaign();
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = (inner: AudienceSource): AudienceSource => ({
      ...inner,
      members: async (req) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(POLL_STEP_MS * 5);
        try {
          return await inner.members(req);
        } finally {
          inFlight -= 1;
        }
      },
    });
    const results = await Promise.all([tick(slow(fake())), tick(slow(fake()))]);
    expect(results.reduce((sum, result) => sum + result.ran, 0)).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(await recipients(id, 'pending')).toEqual(proIds());
  });

  it('cancel during materialisation stops it', async () => {
    const id = await insertCampaign();
    const source = hooked(fake(), async (call) => {
      if (call === 2) {
        await sql.$executeRawUnsafe(
          `UPDATE marketing.campaigns SET state = 'cancelled' WHERE id = $1::uuid`,
          id
        );
        await sql.$executeRawUnsafe(
          `UPDATE marketing.campaign_recipients SET status = 'skipped', reason = 'cancelled'
           WHERE campaign_id = $1::uuid AND status = 'pending'`,
          id
        );
      }
    });
    expect(await tick(source)).toEqual({ ran: 1 });
    expect(source.calls()).toBe(2);
    expect(await recipients(id, 'pending')).toEqual([]);
    expect(await recipients(id)).toHaveLength(PAGE_SIZE);
    expect(await campaign(id)).toMatchObject({
      state: 'cancelled',
      materialize_state: 'in_progress',
    });
    expect(await tick(fake())).toEqual({ ran: 0 });
  });

  it('a cancel between pages is noticed before the next page is fetched', async () => {
    const id = await insertCampaign();
    const source = hooked(fake(), () => undefined);
    const originalSave = sql.$transaction.bind(sql);
    let commits = 0;
    // Cancels right after the first page (the exclusions step) commits, before the runner checks for a stop.
    const counting = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return async (...args: Parameters<typeof originalSave>) => {
            const result = await originalSave(...args);
            commits += 1;
            if (commits === 1) {
              await sql.$executeRawUnsafe(
                `UPDATE marketing.campaigns SET state = 'cancelled' WHERE id = $1::uuid`,
                id
              );
            }
            return result;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await runMaterializeTick({
      sql: counting,
      sources: resolverOf(source),
      redis,
      cfg: CFG,
      now: () => now,
    });
    expect(result).toEqual({ ran: 1 });
    expect(source.calls()).toBe(0);
  });

  it('five protocol errors fail the campaign with materialize_failed', async () => {
    const id = await insertCampaign();
    const broken = hooked(fake(), (call) => {
      if (call > 1) {
        throw new SourceProtocolError('bad page: upstream said <html>');
      }
    });
    for (let attempt = 1; attempt < MAX_PROTOCOL_ATTEMPTS; attempt++) {
      expect(await tick(broken)).toEqual({ ran: 1 });
      expect(await campaign(id)).toMatchObject({
        state: 'running',
        materialize_state: 'in_progress',
        materialize_error: 'source_protocol_error',
        materialize_attempts: attempt,
      });
      advance(RETRY_SECONDS);
    }
    expect(await tick(broken)).toEqual({ ran: 1 });
    expect(await campaign(id)).toMatchObject({
      state: 'failed',
      state_reason: 'materialize_failed',
      materialize_state: 'failed',
      materialize_attempts: MAX_PROTOCOL_ATTEMPTS,
    });
    expect(await recipients(id, 'pending')).toEqual([]);
    expect(await recipients(id, 'skipped')).toHaveLength(PAGE_SIZE);
    advance(RETRY_SECONDS);
    expect(await tick(broken)).toEqual({ ran: 0 });
  });

  it('a 401 sets source_auth_failed on the source row', async () => {
    const id = await insertCampaign();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.audience_sources (project_id, kind, base_url) VALUES ($1, 'http', 'https://x.test')`,
      PROJECT
    );
    const denied = hooked(fake(), () => {
      throw new SourceAuthError('http_401');
    });
    expect(await tick(denied)).toEqual({ ran: 1 });
    expect(await campaign(id)).toMatchObject({
      state: 'running',
      materialize_error: 'source_auth_failed',
      materialize_attempts: 0,
      materialize_retry_at: new Date(now.getTime() + RETRY_SECONDS * SECOND_MS),
    });
    const [row] = await sql.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM marketing.audience_sources WHERE project_id = $1',
      PROJECT
    );
    expect(row?.status).toBe('source_auth_failed');
  });

  it('a project without an http source waits with source_not_http', async () => {
    const id = await insertCampaign();
    expect(await tick(null)).toEqual({ ran: 1 });
    expect(await campaign(id)).toMatchObject({
      state: 'running',
      materialize_error: 'source_not_http',
      materialize_retry_at: new Date(now.getTime() + RETRY_SECONDS * SECOND_MS),
    });
  });

  it('a restart from scratch after sending began fails the campaign', async () => {
    const id = await insertCampaign();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status)
       VALUES ($1::uuid, 'pro-000001', $2, 'sent')`,
      id,
      PROJECT
    );
    expect(await tick(fake())).toEqual({ ran: 1 });
    expect(await campaign(id)).toMatchObject({
      state: 'failed',
      state_reason: 'materialize_restart_after_sending',
      materialize_state: 'failed',
    });
    advance(RETRY_SECONDS);
    expect(await tick(fake())).toEqual({ ran: 0 });
  });
});
