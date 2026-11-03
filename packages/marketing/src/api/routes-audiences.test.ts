import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { getRedisCache } from '@openpanel/redis';
import type { FilterTree, Schema } from '../audience/contract';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import type { SourceResolver } from '../audience/resolver';
import { createSourceResolver } from '../audience/resolver';
import { verifyRequest } from '../audience/signing';
import type { AudienceSource } from '../audience/source';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createServer } from './server';

const PROXY_SECRET = 'proxy-secret-for-tests';
const BASE = 'http://marketing.internal';
const MIB = 1024 * 1024;
const PRO_COUNT = 30;
const CHUNK = 2000;
const CHUNKS = 10;
const OVER_RESOLVE_LIMIT = 201;
const PHONE = '+919800000001';
const FREEZE_DELAY_MS = 150;

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
  contact: { phone: `+9198000${String(i).padStart(5, '0')}` },
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

let down = false;
let hasSource = true;
let pageDelayMs = 0;
let sourceOverride: AudienceSource | null = null;
const resolver = {
  forProject: async () => {
    if (!hasSource) {
      return null;
    }
    return (
      sourceOverride ??
      createFakeSource({
        members,
        schema: SCHEMA,
        down: () => down,
        pageDelayMs,
      })
    );
  },
  invalidate: () => undefined,
} as unknown as SourceResolver;
const app = createServer({ cfg, sql, redis, sources: resolver });

function call(
  method: string,
  path: string,
  options: {
    body?: unknown;
    rawBody?: BodyInit;
    project?: string;
    user?: string;
    secret?: boolean;
    server?: typeof app;
  } = {}
) {
  const hasJson = options.body !== undefined;
  return (options.server ?? app).fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(hasJson ? { 'content-type': 'application/json' } : {}),
        ...(options.secret === false
          ? {}
          : {
              'x-marketing-proxy-secret': PROXY_SECRET,
              'x-marketing-project-id': options.project ?? 'proj-a',
              'x-marketing-user-id': options.user ?? 'user-1',
              'x-marketing-csrf': '1',
            }),
      },
      body: hasJson ? JSON.stringify(options.body) : options.rawBody,
    })
  );
}

const input = (over: Record<string, unknown> = {}) => ({
  name: 'Pros',
  mode: 'dynamic',
  filter: PRO,
  excludeFilter: null,
  ...over,
});

interface Row {
  id: string;
  version: number;
  createdBy: string;
  includeCount: number;
  snapshotCount: number | null;
}

async function create(over: Record<string, unknown> = {}, project = 'proj-a') {
  const res = await call('POST', '/marketing/audiences', {
    body: input(over),
    project,
  });
  if (res.status !== 201) {
    throw new Error(`create failed with ${res.status}`);
  }
  return (await res.json()) as Row;
}

const ids = (from: number, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `id-${String(from + i).padStart(6, '0')}`
  );

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  down = false;
  hasSource = true;
  pageDelayMs = 0;
  sourceOverride = null;
  await resetMarketingTables();
  await redis.flushdb();
});
afterAll(async () => {
  redis.disconnect();
  await sql.$disconnect();
});

describe('audience routes', () => {
  it('every route needs the proxy secret', async () => {
    const audience =
      '/marketing/audiences/00000000-0000-4000-8000-000000000000';
    const routes = [
      ['GET', '/marketing/audience/schema'],
      ['GET', '/marketing/audience/dimensions/plan/values'],
      ['POST', '/marketing/audience/resolve'],
      ['GET', '/marketing/audiences'],
      ['POST', '/marketing/audiences'],
      ['GET', audience],
      ['PUT', audience],
      ['DELETE', audience],
      ['GET', `${audience}/ids`],
      ['POST', `${audience}/ids`],
      ['POST', `${audience}/count`],
      ['POST', `${audience}/preview`],
      ['POST', `${audience}/explain`],
      ['POST', `${audience}/freeze`],
    ];
    for (const [method, path] of routes) {
      const res = await call(method as string, path as string, {
        secret: false,
        body: {},
      });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  it('create, update, add 20,000 ids in 2,000-id chunks, count, preview, explain and freeze round-trip', async () => {
    const created = await create({ mode: 'snapshot' });
    let { version } = created;
    const put = await call('PUT', `/marketing/audiences/${created.id}`, {
      body: {
        ...input({ mode: 'snapshot', name: 'Pros 2' }),
        expectedVersion: version,
      },
    });
    expect(put.status).toBe(200);
    version = ((await put.json()) as Row).version;
    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      const res = await call('POST', `/marketing/audiences/${created.id}/ids`, {
        body: {
          list: 'include',
          add: ids(chunk * CHUNK, CHUNK),
          expectedVersion: version,
        },
      });
      expect(res.status).toBe(200);
      version = ((await res.json()) as Row).version;
    }
    const page = await call(
      'GET',
      `/marketing/audiences/${created.id}/ids?list=include&limit=3`
    );
    expect(await page.json()).toEqual({
      ids: ids(0, 3),
      nextCursor: ids(2, 1)[0],
    });
    const base = `/marketing/audiences/${created.id}`;
    const count = (await (await call('POST', `${base}/count`)).json()) as {
      count: number;
      filterCount: number;
      includeCount: number;
    };
    expect(count.filterCount).toBe(PRO_COUNT);
    expect(count.includeCount).toBe(CHUNK * CHUNKS);
    const preview = await call('POST', `${base}/preview`, {
      body: { limit: 5 },
    });
    expect(
      ((await preview.json()) as { members: unknown[] }).members
    ).toHaveLength(5);
    const explain = await call('POST', `${base}/explain`, {
      body: { id: 'm0001' },
    });
    expect(((await explain.json()) as { verdict: string }).verdict).toBe('in');
    const freeze = await call('POST', `${base}/freeze`);
    expect(freeze.status).toBe(200);
    expect(((await freeze.json()) as Row).snapshotCount).toBeGreaterThan(0);
    const list = (await (await call('GET', '/marketing/audiences')).json()) as {
      audiences: Row[];
    };
    expect(list.audiences).toHaveLength(1);
    const del = await call('DELETE', base);
    expect(del.status).toBe(204);
    expect((await call('GET', base)).status).toBe(404);
  });

  it('a 2,001-id chunk is 400 invalid_body', async () => {
    const created = await create();
    const res = await call('POST', `/marketing/audiences/${created.id}/ids`, {
      body: {
        list: 'include',
        add: ids(0, CHUNK + 1),
        expectedVersion: created.version,
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'invalid_body'
    );
  });

  it('a 1 MiB-plus body is 413', async () => {
    const created = await create();
    const res = await call('POST', `/marketing/audiences/${created.id}/ids`, {
      rawBody: JSON.stringify({ pad: 'x'.repeat(MIB + 1) }),
    });
    expect(res.status).toBe(413);
  });

  it('unknown keys in a body are 400', async () => {
    expect(
      (
        await call('POST', '/marketing/audiences', {
          body: { ...input(), extra: 1 },
        })
      ).status
    ).toBe(400);
    const created = await create();
    const res = await call('POST', `/marketing/audiences/${created.id}/ids`, {
      body: { list: 'include', add: ['a'], expectedVersion: 1, extra: 1 },
    });
    expect(res.status).toBe(400);
  });

  it('limit and cursor query params are bounded', async () => {
    const created = await create();
    const base = `/marketing/audiences/${created.id}/ids?list=include`;
    for (const limit of ['0', '1001', 'abc', '-1', '1.5']) {
      expect((await call('GET', `${base}&limit=${limit}`)).status).toBe(400);
    }
    expect(
      (await call('GET', `${base}&cursor=${'x'.repeat(300)}`)).status
    ).toBe(400);
    expect((await call('GET', `${base}&limit=1000`)).status).toBe(200);
    const values = '/marketing/audience/dimensions/plan/values';
    for (const limit of ['0', '101', 'abc']) {
      expect((await call('GET', `${values}?limit=${limit}`)).status).toBe(400);
    }
    expect((await call('GET', `${values}?limit=100`)).status).toBe(200);
  });

  describe('resolve', () => {
    let logs: ReturnType<typeof spyOn>[];
    afterEach(() => {
      for (const spy of logs) {
        spy.mockRestore();
      }
    });
    function capture() {
      const lines: string[] = [];
      logs = (['log', 'error', 'warn', 'info'] as const).map((level) =>
        spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(' '));
        })
      );
      return lines;
    }

    it('resolve with a pasted phone returns its id; the response, any error and captured console output contain none of the inputs', async () => {
      const lines = capture();
      const ok = await call('POST', '/marketing/audience/resolve', {
        body: { inputs: [PHONE, '+910000000000'] },
      });
      const okText = await ok.text();
      expect(JSON.parse(okText)).toEqual({
        ids: ['m0001'],
        unmatchedPositions: [1],
      });
      expect(okText).not.toContain('9800000001');

      const many = Array.from(
        { length: OVER_RESOLVE_LIMIT },
        (_, i) => `+9177${String(i).padStart(8, '0')}`
      );
      const tooMany = await call('POST', '/marketing/audience/resolve', {
        body: { inputs: many },
      });
      expect(tooMany.status).toBe(400);
      const tooManyText = await tooMany.text();

      sourceOverride = {
        resolve: (given: string[]) => {
          throw new Error(`lookup failed for ${given.join(',')}`);
        },
      } as unknown as AudienceSource;
      const thrown = await call('POST', '/marketing/audience/resolve', {
        body: { inputs: [PHONE] },
      });
      expect(thrown.status).toBe(500);
      const everything = [tooManyText, await thrown.text(), ...lines].join(
        '\n'
      );
      for (const secret of [
        PHONE,
        '9800000001',
        '+9177',
        ...many.slice(0, 3),
      ]) {
        expect(everything).not.toContain(secret);
      }
    });
  });

  it('count while the source is down is 503 source_unavailable and saving still works', async () => {
    const created = await create();
    down = true;
    const res = await call('POST', `/marketing/audiences/${created.id}/count`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(
      'source_unavailable'
    );
    const saved = await call('PUT', `/marketing/audiences/${created.id}`, {
      body: { ...input({ name: 'Renamed' }), expectedVersion: created.version },
    });
    expect(saved.status).toBe(200);
  });

  it('a protocol failure is 502 source_error and an auth failure 409 source_auth_failed', async () => {
    const created = await create();
    const { SourceAuthError, SourceProtocolError } = await import(
      '../audience/errors'
    );
    for (const [error, status, code] of [
      [new SourceProtocolError('bad'), 502, 'source_error'],
      [new SourceAuthError('no'), 409, 'source_auth_failed'],
    ] as const) {
      sourceOverride = {
        count: () => Promise.reject(error),
      } as unknown as AudienceSource;
      const res = await call(
        'POST',
        `/marketing/audiences/${created.id}/count`
      );
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
  });

  it('a stored-source project gets 409 source_not_http on count and freeze', async () => {
    const created = await create({ mode: 'snapshot' });
    hasSource = false;
    for (const route of ['count', 'freeze']) {
      const res = await call(
        'POST',
        `/marketing/audiences/${created.id}/${route}`
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        'source_not_http'
      );
    }
  });

  it('audience/dimensions with a key containing a quote is signed correctly', async () => {
    const key = `it's "q"`;
    let verdict: { ok: boolean } = { ok: false };
    const fetcher = (async (url: string, init: RequestInit) => {
      const received = new URL(new Request(url).url);
      verdict = await verifyRequest({
        headers: init.headers as Record<string, string>,
        method: 'GET',
        path: `${received.pathname}${received.search}`,
        body: '',
        keys: [{ id: 'k1', secret: 'topsecret' }],
        now: Math.floor(Date.now() / 1000),
        nonces: { seenBefore: async () => false },
      });
      return Response.json({ values: [{ value: 'a', label: 'A' }] });
    }) as unknown as typeof fetch;
    const real = createSourceResolver({ sql, cfg, redis, fetch: fetcher });
    const server = createServer({
      cfg,
      sql,
      redis,
      sources: real,
      sourceFetch: fetcher,
    });
    const saved = await call('PUT', '/marketing/audience-source', {
      server,
      body: {
        kind: 'http',
        baseUrl: 'https://owner.test/api',
        keyId: 'k1',
        secret: 'topsecret',
      },
    });
    expect(saved.status).toBe(200);
    const res = await call(
      'GET',
      `/marketing/audience/dimensions/${encodeURIComponent(key)}/values?q=x`,
      { server }
    );
    expect(res.status).toBe(200);
    expect(verdict.ok).toBe(true);
  });

  it('project A cannot read project B’s audience', async () => {
    const created = await create({}, 'proj-b');
    const base = `/marketing/audiences/${created.id}`;
    expect((await call('GET', base)).status).toBe(404);
    expect(
      (
        await call('PUT', base, {
          body: { ...input(), expectedVersion: created.version },
        })
      ).status
    ).toBe(404);
    expect((await call('DELETE', base)).status).toBe(404);
    expect((await call('GET', `${base}/ids?list=include`)).status).toBe(404);
    for (const route of ['count', 'freeze']) {
      expect((await call('POST', `${base}/${route}`)).status).toBe(404);
    }
    expect(
      (await call('POST', `${base}/explain`, { body: { id: 'm0001' } })).status
    ).toBe(404);
    const list = (await (await call('GET', '/marketing/audiences')).json()) as {
      audiences: Row[];
    };
    expect(list.audiences).toEqual([]);
  });

  it('created_by is the forwarded user id', async () => {
    const res = await call('POST', '/marketing/audiences', {
      body: input(),
      user: 'user-9',
    });
    expect(((await res.json()) as Row).createdBy).toBe('user-9');
  });

  it('two concurrent freezes: exactly one runs, the other is 409 freeze_in_progress', async () => {
    const created = await create({ mode: 'snapshot' });
    pageDelayMs = FREEZE_DELAY_MS;
    const freeze = () =>
      call('POST', `/marketing/audiences/${created.id}/freeze`);
    const results = await Promise.all([freeze(), freeze()]);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = results.find((res) => res.status === 409);
    expect(((await loser?.json()) as { error: string }).error).toBe(
      'freeze_in_progress'
    );
    // The lock is released afterwards.
    expect((await freeze()).status).toBe(200);
  });
});
