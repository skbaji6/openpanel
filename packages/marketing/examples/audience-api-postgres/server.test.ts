import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import {
  zCountResponse,
  zExplanation,
  zLookupResponse,
  zMembersResponse,
  zResolveResponse,
  zSchema,
} from '../../src/audience/contract';
import { newNonce, signRequest } from '../../src/audience/signing';
import { parseMapping } from './mapping';
import example from './mapping.example.json';
import { createServer } from './server';

const KEY = { id: 'k1', secret: 'secret-one' };
const SECOND_KEY = { id: 'k2', secret: 'secret-two' };
const NOW_MS = 1_800_000_000_000;
const ORIGIN = 'http://audience.test';
const mapping = parseMapping(example);

const databaseUrl = (process.env.DATABASE_URL ?? '').split('?')[0] ?? '';
const sql = new SQL(databaseUrl);
const db = {
  async query(text: string, params: unknown[]) {
    const rows = await sql.unsafe(text, params as never[]);
    return { rows: [...rows] };
  },
};

function build(basePath = '') {
  return createServer({
    mapping,
    db,
    keys: [KEY, SECOND_KEY],
    now: () => NOW_MS,
    basePath,
  });
}

function signedRequest(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    key?: typeof KEY;
    timestamp?: number;
    nonce?: string;
  } = {}
) {
  const method = init.method ?? 'POST';
  const body = init.body === undefined ? '' : JSON.stringify(init.body);
  const headers = signRequest({
    method,
    path,
    body,
    keyId: (init.key ?? KEY).id,
    secret: (init.key ?? KEY).secret,
    timestamp: init.timestamp ?? NOW_MS / 1000,
    nonce: init.nonce ?? newNonce(),
  });
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : body,
  });
}

async function call<T>(
  app: ReturnType<typeof build>,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  method = 'POST'
): Promise<T> {
  const res = await app.fetch(signedRequest(path, { method, body }));
  if (res.status !== 200 || res.headers.get('cache-control') !== 'no-store') {
    throw new Error(`unexpected response ${res.status}`);
  }
  // Every response must satisfy the exact schema the client parses with.
  return schema.parse(await res.json());
}

const app = build();
const allStudents = { dimension: 'id', op: 'not_in', values: ['none'] };

async function pageAll(limit: number) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(
      app,
      '/audience/members',
      { filter: allStudents, cursor, limit, fields: 'id' },
      zMembersResponse
    );
    ids.push(...page.members.map((m) => m.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

beforeAll(async () => {
  await sql.unsafe(readFileSync(new URL('seed.sql', import.meta.url), 'utf8'));
});

afterAll(async () => {
  await sql.unsafe('DROP SCHEMA IF EXISTS reference_demo CASCADE');
  await sql.close();
});

describe('authentication', () => {
  it('401 without credentials', async () => {
    const res = await app.fetch(new Request(`${ORIGIN}/schema`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('401 with a stale timestamp', async () => {
    const res = await app.fetch(
      signedRequest('/schema', { method: 'GET', timestamp: NOW_MS / 1000 - 61 })
    );
    expect(res.status).toBe(401);
  });

  it('401 on a replayed nonce', async () => {
    const nonce = newNonce();
    const first = await app.fetch(
      signedRequest('/schema', { method: 'GET', nonce })
    );
    const replay = await app.fetch(
      signedRequest('/schema', { method: 'GET', nonce })
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'unauthorized' });
  });

  it('401 with a wrong secret, and either of the two keys works', async () => {
    const wrong = await app.fetch(
      signedRequest('/schema', {
        method: 'GET',
        key: { id: 'k1', secret: 'nope' },
      })
    );
    expect(wrong.status).toBe(401);
    const second = await app.fetch(
      signedRequest('/schema', { method: 'GET', key: SECOND_KEY })
    );
    expect(second.status).toBe(200);
  });
});

describe('audience routes', () => {
  it('schema validates and exposes purchase_status', async () => {
    const schema = await call(app, '/schema', undefined, zSchema, 'GET');
    expect(schema.dimensions.map((d) => d.key)).toContain('purchase_status');
    expect(schema.dimensions.find((d) => d.key === 'course')?.multiValued).toBe(
      true
    );
  });

  it('count equals the number of ids paged out', async () => {
    const { count } = await call(
      app,
      '/audience/count',
      { filter: allStudents },
      zCountResponse
    );
    const ids = await pageAll(2);
    expect(count).toBe(6);
    expect(ids).toHaveLength(count);
  });

  it('keyset paging has no duplicates across pages', async () => {
    const ids = await pageAll(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it('a multi-valued course filter counts distinct students', async () => {
    const filter = { dimension: 'course', op: 'in', values: ['c1', 'c3'] };
    const { count } = await call(
      app,
      '/audience/count',
      { filter },
      zCountResponse
    );
    // s001 matches both courses but is one student.
    expect(count).toBe(5);
  });

  it('purchase_status PURCHASED means an active, unexpired purchase', async () => {
    const page = await call(
      app,
      '/audience/members',
      {
        filter: {
          dimension: 'purchase_status',
          op: 'eq',
          values: ['PURCHASED'],
        },
        limit: 10,
        fields: 'id',
      },
      zMembersResponse
    );
    expect(page.members.map((m) => m.id)).toEqual(['s001', 's004']);
    expect(page.nextCursor).toBeNull();
  });

  it('preview masks the display name', async () => {
    const page = await call(
      app,
      '/audience/members',
      { filter: allStudents, limit: 1, fields: 'preview' },
      zMembersResponse
    );
    expect(page.members[0]).toEqual({ id: 's001', displayName: 'A*** R***' });
  });

  it('explain says which conditions matched', async () => {
    const explanation = await call(
      app,
      '/audience/explain',
      {
        filter: {
          op: 'and',
          children: [
            { dimension: 'university', op: 'eq', values: ['u1'] },
            { dimension: 'semester', op: 'gt', values: [3] },
          ],
        },
        id: 's001',
      },
      zExplanation
    );
    expect(explanation.matches).toBe(false);
    expect(explanation.conditions.map((c) => c.matched)).toEqual([true, false]);
  });

  it('dimension values are searchable', async () => {
    const res = await app.fetch(
      signedRequest('/dimensions/university/values?q=beta&limit=5', {
        method: 'GET',
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { value: 'u2', label: 'Beta University' },
    ]);
  });

  it('resolve matches emails and phones and reports the rest', async () => {
    const out = await call(
      app,
      '/members/resolve',
      {
        inputs: ['ASHA@example.test', '+91 90000 00002', 'ghost@example.test'],
      },
      zResolveResponse
    );
    expect(out.matches).toEqual([
      { input: 'ASHA@example.test', id: 's001' },
      { input: '+91 90000 00002', id: 's002' },
    ]);
    expect(out.unmatched).toEqual(['ghost@example.test']);
  });
});

describe('lookup', () => {
  const lookup = (ids: string[], channel: string) =>
    call(app, '/members/lookup', { ids, channel }, zLookupResponse);

  it('returns one entry per id and never a password column', async () => {
    const ids = ['s001', 's002', 's004', 'missing'];
    const raw = await app.fetch(
      signedRequest('/members/lookup', { body: { ids, channel: 'email' } })
    );
    const text = await raw.text();
    expect(text).not.toContain('secret-hash');
    expect(text).not.toContain('password');
    const { entries } = zLookupResponse.parse(JSON.parse(text));
    expect(entries.map((e) => [e.id, e.status])).toEqual([
      ['s001', 'ok'],
      ['s002', 'unreachable'],
      ['s004', 'suppressed'],
      ['missing', 'not_found'],
    ]);
    expect(entries[1]?.reason).toBe('unverified_email');
  });

  it('push returns only active tokens, email is not leaked on push', async () => {
    const { entries } = await lookup(['s001', 's003'], 'push');
    expect(entries[0]?.devices).toEqual([
      { token: 'tok-s001-a', platform: 'android' },
    ]);
    expect(entries[0]?.email).toBeUndefined();
    expect(entries[1]).toMatchObject({
      status: 'unreachable',
      reason: 'no_active_device',
    });
  });

  it('sms returns a digits-only phone and reports a missing one', async () => {
    const { entries } = await lookup(['s001', 's003'], 'sms');
    expect(entries[0]?.phone).toBe('919000000001');
    expect(entries[0]?.traits).toEqual({ firstName: 'Asha' });
    expect(entries[1]?.reason).toBe('no_valid_phone');
  });
});

describe('limits and validation', () => {
  const rejected = async (path: string, body: unknown) => {
    const res = await app.fetch(signedRequest(path, { body }));
    if (res.status !== 400) {
      throw new Error(`expected 400, got ${res.status}`);
    }
    return JSON.stringify(await res.json());
  };

  it('a page limit of 1001 is rejected with 400', async () => {
    await rejected('/audience/members', {
      filter: allStudents,
      limit: 1001,
      fields: 'id',
    });
  });

  it('501 lookup ids and 201 resolve inputs are rejected', async () => {
    await rejected('/members/lookup', {
      ids: Array.from({ length: 501 }, (_, i) => `s${i}`),
      channel: 'none',
    });
    await rejected('/members/resolve', {
      inputs: Array.from({ length: 201 }, (_, i) => `a${i}@x.test`),
    });
  });

  it('validation errors never echo input values', async () => {
    const secret = 'TOP-SECRET-VALUE-123';
    const body = await rejected('/audience/count', {
      filter: { dimension: secret, op: 'eq', values: [secret] },
    });
    expect(body).not.toContain(secret);
    const typed = await rejected('/audience/count', {
      filter: { dimension: 'semester', op: 'eq', values: [secret] },
    });
    expect(typed).not.toContain(secret);
  });

  it('injection strings in filter values are inert', async () => {
    const { count } = await call(
      app,
      '/audience/count',
      {
        filter: {
          dimension: 'university',
          op: 'eq',
          values: ["u1' OR '1'='1"],
        },
      },
      zCountResponse
    );
    expect(count).toBe(0);
  });

  it('an unknown route is 404 once authenticated', async () => {
    const res = await app.fetch(signedRequest('/nope', { method: 'GET' }));
    expect(res.status).toBe(404);
  });
});

describe('basePath', () => {
  const prefixed = build('/internal/audience');

  it('serves routes under the prefix and signs the full path', async () => {
    const res = await prefixed.fetch(
      signedRequest('/internal/audience/schema', { method: 'GET' })
    );
    expect(res.status).toBe(200);
    zSchema.parse(await res.json());
    const count = await prefixed.fetch(
      signedRequest('/internal/audience/audience/count', {
        body: { filter: allStudents },
      })
    );
    expect(zCountResponse.parse(await count.json()).count).toBe(6);
  });

  it('does not serve the unprefixed path', async () => {
    const res = await prefixed.fetch(
      signedRequest('/schema', { method: 'GET' })
    );
    expect(res.status).toBe(404);
  });
});
