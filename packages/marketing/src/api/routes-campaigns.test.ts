import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { getRedisCache } from '@openpanel/redis';
import type { FilterTree, Schema } from '../audience/contract';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import type { SourceResolver } from '../audience/resolver';
import { pinTemplate } from '../campaign/channel-ready';
import { runMaterializeTick } from '../campaign/materialize-runner';
import { runScheduleTick } from '../campaign/scheduler';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createServer } from './server';

const PROXY_SECRET = 'proxy-secret-for-tests';
const BASE = 'http://marketing.internal';
const START = new Date('2026-11-03T10:00:00.000Z');
const HOUR_MS = 3_600_000;
const PRO_COUNT = 30;
const LOW_THRESHOLD = 5;
const MAX_PROFILE_ID = 256;
const UNKNOWN_CAMPAIGN = '00000000-0000-4000-8000-000000000000';
const PUSH_TEMPLATE = { subject: 'Hi', body: 'Hello' };
const SCHEMA: Schema = {
  dimensions: [
    {
      key: 'plan',
      label: 'Plan',
      type: 'string',
      multiValued: false,
      valuesListable: true,
    },
  ],
};
const PRO: FilterTree = { dimension: 'plan', op: 'eq', values: ['pro'] };
const members: FakeMember[] = Array.from({ length: PRO_COUNT }, (_, i) => ({
  id: `m${String(i).padStart(4, '0')}`,
  values: { plan: 'pro' },
}));

const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  MARKETING_PROXY_SECRET: PROXY_SECRET,
  MARKETING_PUBLIC_URL: 'https://marketing.test',
});
const redis = getRedisCache();
let now = START;
const resolver = {
  forProject: async () => createFakeSource({ members, schema: SCHEMA }),
  invalidate: () => undefined,
} as unknown as SourceResolver;
const clock = () => now.getTime();
const app = createServer({ cfg, sql, redis, sources: resolver, now: clock });
type Body = Record<string, unknown>;
type RouteSpec = [method: string, path: string, body?: Body];

function call(
  method: string,
  path: string,
  options: {
    body?: unknown;
    project?: string;
    secret?: boolean;
  } = {}
) {
  const hasJson = options.body !== undefined;
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(hasJson ? { 'content-type': 'application/json' } : {}),
        ...(options.secret === false
          ? {}
          : {
              'x-marketing-proxy-secret': PROXY_SECRET,
              'x-marketing-project-id': options.project ?? 'proj-a',
              'x-marketing-user-id': 'user-1',
              'x-marketing-csrf': '1',
            }),
      },
      body: hasJson ? JSON.stringify(options.body) : undefined,
    })
  );
}

async function createAudience(project: string): Promise<string> {
  const res = await call('POST', '/marketing/audiences', {
    project,
    body: { name: 'Pros', mode: 'dynamic', filter: PRO, excludeFilter: null },
  });
  return ((await res.json()) as { id: string }).id;
}

async function createCampaign(over: Body = {}, project = 'proj-a') {
  const res = await call('POST', '/marketing/campaigns', {
    project,
    body: {
      name: 'Launch',
      channel: 'push',
      template: PUSH_TEMPLATE,
      audienceId: await createAudience(project),
      ...over,
    },
  });
  if (res.status !== 201) {
    throw new Error(`create failed with ${res.status}`);
  }
  return (await res.json()) as Body & { id: string; version: number };
}

const HIDDEN = [
  'materializeLeaseToken',
  'materializeLeaseUntil',
  'materializeCursor',
  'materializeRetryAt',
];
const expectHidden = (text: string) => {
  for (const key of HIDDEN) {
    expect(text).not.toContain(key);
  }
};

const preview = (id: string) =>
  call('POST', `/marketing/campaigns/${id}/count-preview`);

const idRoutes = (id: string): RouteSpec[] => [
  ['GET', `/marketing/campaigns/${id}`],
  ['PATCH', `/marketing/campaigns/${id}`, { expectedVersion: 1, name: 'x' }],
  ['DELETE', `/marketing/campaigns/${id}`],
  ['POST', `/marketing/campaigns/${id}/count-preview`],
  ['POST', `/marketing/campaigns/${id}/start`],
  ['POST', `/marketing/campaigns/${id}/schedule`],
  ['POST', `/marketing/campaigns/${id}/unschedule`],
  ['POST', `/marketing/campaigns/${id}/pause`],
  ['POST', `/marketing/campaigns/${id}/resume`],
  ['POST', `/marketing/campaigns/${id}/cancel`],
  ['POST', `/marketing/campaigns/${id}/test-send`, { profileId: 'p' }],
  ['POST', `/marketing/campaigns/${id}/retry-uncertain`],
  ['GET', `/marketing/campaigns/${id}/recipients`],
  ['GET', `/marketing/campaigns/${id}/skip-reasons`],
  ['GET', `/marketing/campaigns/${id}/test-sends`],
  ['POST', `/marketing/campaigns/${id}/estimate`],
];

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  now = START;
  await resetMarketingTables();
  await redis.flushdb();
  // The server's readiness hook starts push campaigns only once the channel has credentials.
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ('proj-a', 'push', 'x')`
  );
});
afterAll(async () => {
  redis.disconnect();
  await sql.$disconnect();
});

describe('campaign routes', () => {
  it('every route needs the proxy secret', async () => {
    const routes: RouteSpec[] = [
      ['GET', '/marketing/campaigns'],
      ['POST', '/marketing/campaigns', {}],
      ...idRoutes(UNKNOWN_CAMPAIGN),
    ];
    for (const [method, path, body] of routes) {
      const res = await call(method, path, { body, secret: false });
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });

  it('skipPreviousRecipients without campaignKey is 400 invalid_campaign on create and PATCH', async () => {
    const errorOf = async (res: Response) => [
      res.status,
      ((await res.json()) as { error: string }).error,
    ];
    const created = await call('POST', '/marketing/campaigns', {
      body: {
        name: 'Launch',
        channel: 'push',
        template: PUSH_TEMPLATE,
        skipPreviousRecipients: true,
      },
    });
    expect(await errorOf(created)).toEqual([400, 'invalid_campaign']);

    const draft = await createCampaign();
    const patched = await call('PATCH', `/marketing/campaigns/${draft.id}`, {
      body: { skipPreviousRecipients: true, expectedVersion: draft.version },
    });
    expect(await errorOf(patched)).toEqual([400, 'invalid_campaign']);
  });

  it('draft, preview, start round-trip with counters after one materialise tick', async () => {
    const draft = await createCampaign();
    expect(draft.state).toBe('draft');
    const listed = (await (
      await call('GET', '/marketing/campaigns')
    ).json()) as { campaigns: Body[] };
    expect(listed.campaigns.map((c) => c.id)).toEqual([draft.id]);

    const counted = await preview(draft.id);
    expect(((await counted.json()) as Body).count).toBe(PRO_COUNT);

    const started = await call(
      'POST',
      `/marketing/campaigns/${draft.id}/start`
    );
    expect(started.status).toBe(200);
    const running = (await started.json()) as Body;
    expect(running.state).toBe('running');
    expect(running.materializeState).toBe('not_started');
    expect(running.templateVersion).toBe(0);

    await runMaterializeTick({
      sql,
      sources: resolver,
      redis,
      cfg,
      now: () => now,
    });
    const after = (await (
      await call('GET', `/marketing/campaigns/${draft.id}`)
    ).json()) as Body;
    expect(after.materializeState).toBe('done');
    expect(after.counters).toEqual({
      queued: PRO_COUNT,
      sent: 0,
      failed: 0,
      skipped: 0,
      uncertain: 0,
    });
    expect(after.materializeError).toBeNull();
    expect(after.stateReason).toBeNull();
  });

  it('an sms campaign without channel credentials does not start', async () => {
    const draft = await createCampaign({
      channel: 'sms',
      template: { templateId: 'otp' },
    });
    await preview(draft.id);
    const started = await call(
      'POST',
      `/marketing/campaigns/${draft.id}/start`
    );
    expect(started.status).toBe(409);
    expect(((await started.json()) as { error: string }).error).toBe(
      'channel_not_configured'
    );
  });

  it('never exposes worker internals', async () => {
    const draft = await createCampaign();
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET materialize_lease_token = gen_random_uuid(), materialize_lease_until = now(),
       materialize_cursor = 'c', materialize_retry_at = now() WHERE id = $1::uuid`,
      draft.id
    );
    const patched = await call('PATCH', `/marketing/campaigns/${draft.id}`, {
      body: { expectedVersion: draft.version, name: 'Renamed' },
    });
    expect(patched.status).toBe(200);
    const responses = [
      await call('GET', '/marketing/campaigns'),
      await call('GET', `/marketing/campaigns/${draft.id}`),
      patched,
    ];
    for (const res of responses) {
      expectHidden(await res.text());
    }
    await preview(draft.id);
    const started = await call(
      'POST',
      `/marketing/campaigns/${draft.id}/start`
    );
    expectHidden(await started.text());
  });

  it('confirmation_required answers {count, channel}', async () => {
    const draft = await createCampaign();
    // The threshold is stored on the campaign when it is created.
    await sql.$executeRawUnsafe(
      'UPDATE marketing.campaigns SET confirm_threshold = $2 WHERE id = $1::uuid',
      draft.id,
      LOW_THRESHOLD
    );
    await preview(draft.id);
    const res = await call('POST', `/marketing/campaigns/${draft.id}/start`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'confirmation_required',
      details: { count: PRO_COUNT, channel: 'push' },
    });
    const confirmed = await call(
      'POST',
      `/marketing/campaigns/${draft.id}/start`,
      { body: { confirm: { count: PRO_COUNT, channel: 'push' } } }
    );
    expect(confirmed.status).toBe(200);
  });

  it('a confirm naming an unknown channel is 400', async () => {
    const draft = await createCampaign();
    const res = await call('POST', `/marketing/campaigns/${draft.id}/start`, {
      body: { confirm: { count: 1, channel: 'carrier-pigeon' } },
    });
    expect(res.status).toBe(400);
  });

  it('an invalid transition is 409 invalid_transition', async () => {
    const draft = await createCampaign();
    const res = await call('POST', `/marketing/campaigns/${draft.id}/pause`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Body).error).toBe('invalid_transition');
  });

  it('a body with an unknown field is 400', async () => {
    const draft = await createCampaign();
    const base = `/marketing/campaigns/${draft.id}`;
    const confirm = { count: 1, channel: 'push' };
    const bad: RouteSpec[] = [
      [
        'POST',
        '/marketing/campaigns',
        {
          name: 'x',
          channel: 'push',
          template: PUSH_TEMPLATE,
          confirmThreshold: 1,
        },
      ],
      ['PATCH', base, { expectedVersion: 1, state: 'running' }],
      ['PATCH', base, { name: 'no version' }],
      ['POST', `${base}/start`, { confirm, x: 1 }],
      ['POST', `${base}/schedule`, { x: 1 }],
      ['POST', `${base}/unschedule`, { x: 1 }],
      ['POST', `${base}/pause`, { x: 1 }],
      ['POST', `${base}/resume`, { x: 1 }],
      ['POST', `${base}/cancel`, { x: 1 }],
      ['POST', `${base}/count-preview`, { x: 1 }],
      ['POST', `${base}/test-send`, { profileId: 'p', x: 1 }],
    ];
    for (const [method, path, body] of bad) {
      const res = await call(method, path, { body });
      expect([method, path, res.status]).toEqual([method, path, 400]);
      expect(((await res.json()) as Body).error).toBe('invalid_body');
    }
  });

  it('a campaign of another project is 404 on every route', async () => {
    const other = await createCampaign({}, 'proj-b');
    for (const [method, path, body] of idRoutes(other.id)) {
      const res = await call(method, path, { body });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    const intact = await call('GET', `/marketing/campaigns/${other.id}`, {
      project: 'proj-b',
    });
    expect(intact.status).toBe(200);
  });

  it('test-send with a 257-character id is 400', async () => {
    const draft = await createCampaign();
    const path = `/marketing/campaigns/${draft.id}/test-send`;
    const long = await call('POST', path, {
      body: { profileId: 'x'.repeat(MAX_PROFILE_ID + 1) },
    });
    expect(long.status).toBe(400);
    const ok = await call('POST', path, {
      body: { profileId: 'x'.repeat(MAX_PROFILE_ID) },
    });
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as Body).id).toBe('string');
  });

  it('a missed campaign reads state missed with stateReason late', async () => {
    const draft = await createCampaign({
      sendAtLocal: '2026-11-03T11:00',
      timezone: 'UTC',
    });
    await preview(draft.id);
    const scheduled = await call(
      'POST',
      `/marketing/campaigns/${draft.id}/schedule`
    );
    expect(scheduled.status).toBe(200);
    now = new Date(START.getTime() + 3 * HOUR_MS);
    await runScheduleTick({ sql, now: () => now, pinTemplate });
    const row = (await (
      await call('GET', `/marketing/campaigns/${draft.id}`)
    ).json()) as Body;
    expect(row.state).toBe('missed');
    expect(row.stateReason).toBe('late');
  });

  it('retry-uncertain answers the retried count and the reopened campaign; recipients never carry contact data', async () => {
    const draft = await createCampaign();
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET state = 'completed', materialize_state = 'done' WHERE id = $1::uuid`,
      draft.id
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status, reason)
       VALUES ($1::uuid, 'u1', 'proj-a', 'uncertain', 'timeout'), ($1::uuid, 'u2', 'proj-a', 'sent', NULL)`,
      draft.id
    );
    const base = `/marketing/campaigns/${draft.id}`;
    const reasons = (await (
      await call('GET', `${base}/skip-reasons`)
    ).json()) as Body;
    expect(reasons.reasons).toEqual([
      { status: 'uncertain', reason: 'timeout', count: 1 },
    ]);

    const retried = await call('POST', `${base}/retry-uncertain`);
    expect(retried.status).toBe(200);
    const body = (await retried.json()) as Body & { campaign: Body };
    expect(body.retried).toBe(1);
    expect(body.campaign.state).toBe('running');
    expectHidden(JSON.stringify(body));

    const list = (await (
      await call('GET', `${base}/recipients?status=pending&limit=10`)
    ).json()) as { recipients: Body[]; nextCursor: string | null };
    expect(list.recipients).toHaveLength(1);
    expect(list.recipients[0]).toMatchObject({
      profileId: 'u1',
      status: 'pending',
      reason: 'operator_retry',
    });
    expect(list.nextCursor).toBeNull();
  });

  it('a bad recipients query is 400 invalid_query', async () => {
    const draft = await createCampaign();
    for (const query of [
      'status=bogus',
      'limit=0',
      'limit=501',
      'limit=x',
      'extra=1',
    ]) {
      const res = await call(
        'GET',
        `/marketing/campaigns/${draft.id}/recipients?${query}`
      );
      expect([query, res.status]).toEqual([query, 400]);
      expect(((await res.json()) as Body).error).toBe('invalid_query');
    }
  });

  it('estimate without a preview is 409 count_preview_required and with one answers the count', async () => {
    const draft = await createCampaign();
    const path = `/marketing/campaigns/${draft.id}/estimate`;
    const early = await call('POST', path);
    expect([early.status, ((await early.json()) as Body).error]).toEqual([
      409,
      'count_preview_required',
    ]);
    await preview(draft.id);
    const estimate = (await (await call('POST', path)).json()) as Body;
    expect(estimate).toMatchObject({
      count: PRO_COUNT,
      channel: 'push',
      quota: null,
    });
  });

  it('retry-uncertain on a draft is 409 invalid_transition', async () => {
    const draft = await createCampaign();
    const res = await call(
      'POST',
      `/marketing/campaigns/${draft.id}/retry-uncertain`
    );
    expect([res.status, ((await res.json()) as Body).error]).toEqual([
      409,
      'invalid_transition',
    ]);
  });
});
