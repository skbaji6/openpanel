import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import type { AudienceSource } from '../audience/source';
import { createAudienceStore } from '../audience/store';
import type { BatchChannelAdapter, BatchItem } from '../channels/batch';
import {
  registerBatchAdapter,
  unregisterBatchAdapter,
} from '../channels/registry';
import {
  DEFAULT_CHANNEL_SETTINGS,
  putChannelSettings,
} from '../channels/settings';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from '../templates/registry';
import type { DispatchDeps } from './dispatch';
import { runReapTick, startDispatchLane } from './dispatch-lane';
import { createChannelBackoff, createRateBucket } from './pacing';
import { SENDING_LEASE_MS } from './recipients';
import { createCampaignService } from './service';

const ENCRYPTION_KEY = 'a'.repeat(64);
const CFG = {
  encryptionKey: ENCRYPTION_KEY,
  leaseSeconds: 120,
  sourceConcurrency: 4,
} as MarketingConfig;
const IDLE_MS = 10;
const POLL_MS = 20;
const DRAIN_TIMEOUT_MS = 60_000;
const OVERLAP_WAIT_MS = 2000;
const SECRET = 'lane-secret-value';
const zFakeConfig = z.object({ key: z.string() });

const redis = getRedisCache();
let project = '';

const pad = (n: number) => String(n).padStart(5, '0');
const pushMembers = (count: number): FakeMember[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `p-${pad(i)}`,
    values: {},
    traits: { name: `Name${i}` },
    devices: [{ token: `token-${pad(i)}`, platform: 'android' }],
  }));

function campaignService(source: AudienceSource | null) {
  const resolve = async () => source;
  return createCampaignService({
    sql,
    cfg: CFG,
    audiences: createAudienceStore({
      sql,
      source: resolve,
      now: () => new Date(),
    }),
    source: resolve,
    now: () => new Date(),
  });
}

function depsFor(
  source: AudienceSource,
  overrides: Partial<DispatchDeps> = {}
): DispatchDeps {
  return {
    sql,
    redis,
    cfg: CFG,
    sources: { forProject: async () => source, invalidate: () => undefined },
    registry: createTemplateRegistry({ sql, now: () => new Date() }),
    campaigns: campaignService(source),
    bucket: createRateBucket(redis, {}),
    backoff: createChannelBackoff(redis),
    renderUnsubscribeUrl: (_project, profileId, channel) =>
      `https://unsubscribe.test/${profileId}/${channel}`,
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
    ...overrides,
  };
}

function fakePush(
  send: (items: BatchItem[]) => Promise<void> = async () => undefined
): BatchItem[] {
  const sent: BatchItem[] = [];
  const adapter: BatchChannelAdapter<z.infer<typeof zFakeConfig>> = {
    id: 'push',
    configSchema: zFakeConfig,
    maxBatch: 500,
    async sendBatch(items) {
      await send(items);
      sent.push(...items);
      return items.map((item) => ({
        profileId: item.profileId,
        outcome: 'sent' as const,
      }));
    },
  };
  registerBatchAdapter(adapter);
  return sent;
}

async function insertCampaign(profileIds: string[]): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold,
       created_by, materialize_state, started_at)
     VALUES ($1::uuid, $2, 'c', 'running', 'push', $3::jsonb, 5000, 'u1', 'done', now())`,
    id,
    project,
    JSON.stringify({ subject: 'Hi', body: 'Hello {{profile.name}}' })
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
    project,
    profileIds
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)',
    project,
    'push',
    encryptCredential(ENCRYPTION_KEY, JSON.stringify({ key: 'k' }))
  );
  await putChannelSettings(
    sql,
    project,
    'push',
    DEFAULT_CHANNEL_SETTINGS.push,
    0
  );
  return id;
}

async function campaignState(id: string): Promise<string> {
  const [row] = await sql.$queryRawUnsafe<{ state: string }[]>(
    'SELECT state FROM marketing.campaigns WHERE id = $1::uuid',
    id
  );
  return row?.state ?? 'missing';
}

async function statuses(id: string) {
  const rows = await sql.$queryRawUnsafe<{ status: string; n: number }[]>(
    `SELECT status, count(*)::int AS n FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid GROUP BY status`,
    id
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
  project = `lane-${randomUUID()}`;
});

afterEach(() => {
  unregisterBatchAdapter('push');
});

describe('startDispatchLane', () => {
  it(
    'two loops drain 2,000 recipients with no profile sent twice',
    async () => {
      const members = pushMembers(2000);
      const sent = fakePush();
      const id = await insertCampaign(members.map((member) => member.id));
      const inner = createFakeSource({ members });
      let inFlight = 0;
      let maxInFlight = 0;
      let secondArrived!: () => void;
      const overlap = new Promise<void>((resolve) => {
        secondArrived = resolve;
      });
      const source: AudienceSource = {
        ...inner,
        lookup: async (ids, channel) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (inFlight === 2) {
            secondArrived();
          }
          // The first lookup holds until the other loop's lookup arrives; serial loops would time out here.
          await Promise.race([overlap, Bun.sleep(OVERLAP_WAIT_MS)]);
          try {
            return await inner.lookup(ids, channel);
          } finally {
            inFlight -= 1;
          }
        },
      };

      const lane = startDispatchLane({
        ...depsFor(source),
        concurrency: 2,
        idleMs: IDLE_MS,
        secrets: [],
      });
      await waitFor(
        async () => (await campaignState(id)) === 'completed',
        'the campaign to complete'
      );
      await lane.stop();

      expect(sent).toHaveLength(2000);
      expect(new Set(sent.map((item) => item.profileId)).size).toBe(2000);
      expect(maxInFlight).toBe(2);
      expect(await statuses(id)).toEqual({ sent: 2000 });
    },
    DRAIN_TIMEOUT_MS
  );

  it("stop waits for an in-flight cycle's marks", async () => {
    const members = pushMembers(3);
    let entered!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent = fakePush(async () => {
      entered();
      await gate;
    });
    const id = await insertCampaign(members.map((member) => member.id));
    const lane = startDispatchLane({
      ...depsFor(createFakeSource({ members })),
      concurrency: 1,
      idleMs: IDLE_MS,
      secrets: [],
    });
    await sendStarted;

    let stopped = false;
    const stopping = lane.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(IDLE_MS * 5);
    expect(stopped).toBe(false);
    expect(await statuses(id)).toEqual({ sending: 3 });

    release();
    await stopping;
    expect(sent).toHaveLength(3);
    expect(await statuses(id)).toEqual({ sent: 3 });
  });

  it('a cycle that throws does not stop the loop', async () => {
    const members = pushMembers(5);
    fakePush();
    const id = await insertCampaign(members.map((member) => member.id));
    const source = createFakeSource({ members });
    let calls = 0;
    const errors: string[] = [];
    const logged = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      }
    );
    try {
      const lane = startDispatchLane({
        ...depsFor(source, {
          sources: {
            forProject: async () => {
              calls += 1;
              if (calls === 1) {
                throw new Error(`resolver broke near ${SECRET}`);
              }
              return source;
            },
            invalidate: () => undefined,
          },
        }),
        concurrency: 1,
        idleMs: IDLE_MS,
        secrets: [SECRET],
      });
      await waitFor(
        async () => (await campaignState(id)) === 'completed',
        'the campaign to complete'
      );
      await lane.stop();
    } finally {
      logged.mockRestore();
    }

    expect(await statuses(id)).toEqual({ sent: 5 });
    const logLine = errors.find((line) => line.includes('resolver broke'));
    expect(logLine).toBeDefined();
    expect(logLine).not.toContain(SECRET);
  });
});

async function stuckCampaign(start: Date): Promise<string> {
  project = `lane-${randomUUID()}`;
  const id = await insertCampaign(['done', 'stuck']);
  await sql.$executeRawUnsafe(
    `UPDATE marketing.campaign_recipients SET status = 'sent', sent_at = $2
     WHERE campaign_id = $1::uuid AND profile_id = 'done'`,
    id,
    start
  );
  await sql.$executeRawUnsafe(
    `UPDATE marketing.campaign_recipients SET status = 'sending', attempt = 1,
       lease_token = $2::uuid, lease_until = $3
     WHERE campaign_id = $1::uuid AND profile_id = 'stuck'`,
    id,
    randomUUID(),
    new Date(start.getTime() + SENDING_LEASE_MS)
  );
  return id;
}

describe('runReapTick', () => {
  it('a campaign whose only remaining row is reaped to uncertain becomes completed', async () => {
    const start = new Date();
    const id = await stuckCampaign(start);
    const reapAt = new Date(start.getTime() + SENDING_LEASE_MS + 1000);

    const result = await runReapTick({
      sql,
      campaigns: campaignService(null),
      now: () => reapAt,
      secrets: [],
    });

    expect(result).toEqual({ released: 0, uncertain: 1, completed: 1 });
    expect(await statuses(id)).toEqual({ sent: 1, uncertain: 1 });
    expect(await campaignState(id)).toBe('completed');
  });

  it('one campaign that fails to complete does not strand the others', async () => {
    const start = new Date();
    const first = await stuckCampaign(start);
    const second = await stuckCampaign(start);
    const reapAt = new Date(start.getTime() + SENDING_LEASE_MS + 1000);
    const service = campaignService(null);
    const attempted: string[] = [];
    const errors: string[] = [];
    const logged = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      }
    );
    let result: Awaited<ReturnType<typeof runReapTick>>;
    try {
      result = await runReapTick({
        sql,
        campaigns: {
          ...service,
          completeIfDone: async (campaignId) => {
            attempted.push(campaignId);
            if (attempted.length === 1) {
              throw new Error(`database hiccup near ${SECRET}`);
            }
            return await service.completeIfDone(campaignId);
          },
        },
        now: () => reapAt,
        secrets: [SECRET],
      });
    } finally {
      logged.mockRestore();
    }

    expect(new Set(attempted)).toEqual(new Set([first, second]));
    expect(result.completed).toBe(1);
    const [thrown, other] = attempted;
    expect(await campaignState(thrown ?? '')).toBe('running');
    expect(await campaignState(other ?? '')).toBe('completed');
    const line = errors.find((text) => text.includes('database hiccup'));
    expect(line).toBeDefined();
    expect(line).not.toContain(SECRET);
  });

  it('the sweep completes a running campaign with no unfinished rows the reaper did not touch', async () => {
    const finished = await insertCampaign(['a', 'b']);
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaign_recipients SET status = 'uncertain', reason = 'lease_expired'
       WHERE campaign_id = $1::uuid`,
      finished
    );
    project = `lane-${randomUUID()}`;
    const unfinished = await insertCampaign(['c']);

    const result = await runReapTick({
      sql,
      campaigns: campaignService(null),
      now: () => new Date(),
      secrets: [],
    });

    expect(result).toEqual({ released: 0, uncertain: 0, completed: 1 });
    expect(await campaignState(finished)).toBe('completed');
    expect(await campaignState(unfinished)).toBe('running');
  });
});
