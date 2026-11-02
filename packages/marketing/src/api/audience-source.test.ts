import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { getRedisCache } from '@openpanel/redis';
import { createSourceResolver } from '../audience/resolver';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createServer } from './server';

const PROXY_SECRET = 'proxy-secret-for-tests';
const SECRET = 'super-secret-value';
const URL_PATH = '/marketing/audience-source';
const valid = {
  kind: 'http',
  baseUrl: 'https://owner.test/api/',
  keyId: 'k1',
  secret: SECRET,
};
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
let fakeStatus = 200;
const fakeFetch = (() =>
  Promise.resolve(
    new Response(JSON.stringify({ dimensions: [] }), { status: fakeStatus })
  )) as unknown as typeof fetch;
const sources = createSourceResolver({ sql, cfg, redis });
const app = createServer({ cfg, sql, redis, sources, sourceFetch: fakeFetch });

function call(method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://marketing.internal${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-marketing-proxy-secret': PROXY_SECRET,
        'x-marketing-project-id': 'proj-a',
        'x-marketing-user-id': 'user-1',
        'x-marketing-csrf': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  fakeStatus = 200;
  await resetMarketingTables();
});
afterAll(async () => {
  redis.disconnect();
  await sql.$disconnect();
});

describe('audience source routes', () => {
  it('GET never contains the secret', async () => {
    await call('PUT', URL_PATH, valid);
    const text = await (await call('GET', URL_PATH)).text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({
      kind: 'http',
      baseUrl: 'https://owner.test/api',
      keyId: 'k1',
      hasSecret: true,
      status: 'unknown',
    });
  });

  it('GET returns the status the ticker recorded, and a PUT resets it', async () => {
    await call('PUT', URL_PATH, valid);
    await sql.$executeRawUnsafe(
      "UPDATE marketing.audience_sources SET status = 'source_auth_failed', status_at = now()"
    );
    const read = async () =>
      ((await (await call('GET', URL_PATH)).json()) as { status: string })
        .status;
    expect(await read()).toBe('source_auth_failed');
    await call('PUT', URL_PATH, { ...valid, secret: 'rotated-secret' });
    expect(await read()).toBe('unknown');
  });

  it('PUT rejects an http:// base URL that is not localhost', async () => {
    for (const baseUrl of [
      'http://owner.test',
      'https://u:p@owner.test',
      'https://owner.test?x=1',
      'https://owner.test#f',
    ]) {
      const res = await call('PUT', URL_PATH, { ...valid, baseUrl });
      expect(res.status).toBe(400);
    }
    const local = await call('PUT', URL_PATH, {
      ...valid,
      baseUrl: 'http://localhost:9000',
    });
    expect(local.status).toBe(200);
  });

  it('PUT with an empty secret keeps the old secret', async () => {
    await call('PUT', URL_PATH, valid);
    const read = () =>
      sql.$queryRawUnsafe<{ s: string; k: string }[]>(
        'SELECT secret_encrypted AS s, key_id AS k FROM marketing.audience_sources'
      );
    const [before] = await read();
    const res = await call('PUT', URL_PATH, { ...valid, secret: '' });
    expect(res.status).toBe(200);
    const [after] = await read();
    expect(after?.s).toBe(before?.s);
    expect(after?.k).toBe('k1');
  });

  it('PUT needs a fresh secret when the base URL or key id changes', async () => {
    await call('PUT', URL_PATH, valid);
    const read = () =>
      sql.$queryRawUnsafe<{ u: string; k: string }[]>(
        'SELECT base_url AS u, key_id AS k FROM marketing.audience_sources'
      );
    const before = await read();
    for (const change of [
      { baseUrl: 'https://elsewhere.test/api' },
      { keyId: 'k2' },
    ]) {
      const res = await call('PUT', URL_PATH, {
        ...valid,
        ...change,
        secret: '',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'secret_required' });
      expect(await read()).toEqual(before);
    }
    // The stored base URL is normalised, so the same URL with a trailing slash is unchanged.
    const same = await call('PUT', URL_PATH, {
      ...valid,
      baseUrl: 'https://owner.test/api/',
      secret: '',
    });
    expect(same.status).toBe(200);
    const rotated = await call('PUT', URL_PATH, {
      ...valid,
      keyId: 'k2',
      secret: 'new-secret',
    });
    expect(rotated.status).toBe(200);
  });

  it('test returns source_auth_failed on a 401 from the fake API', async () => {
    await call('PUT', URL_PATH, valid);
    fakeStatus = 401;
    const res = await call('POST', `${URL_PATH}/test`);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'source_auth_failed',
    });
    fakeStatus = 200;
    const ok = (await (await call('POST', `${URL_PATH}/test`)).json()) as {
      ok: boolean;
      latencyMs: number;
    };
    expect(ok.ok).toBe(true);
    expect(typeof ok.latencyMs).toBe('number');
  });

  it('switching to http deletes the project contacts and devices but keeps opt-outs and dead tokens', async () => {
    for (const projectId of ['proj-a', 'proj-b']) {
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.contacts (project_id, profile_id, email) VALUES ($1, 'u1', 'a@example.test')`,
        projectId
      );
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.devices (token, project_id, profile_id, platform) VALUES ($1, $2, 'u1', 'ios')`,
        `tok-${projectId}`,
        projectId
      );
    }
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.opt_outs (project_id, profile_id, channel) VALUES ('proj-a', 'u1', 'email')`
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.dead_tokens (project_id, token_hash) VALUES ('proj-a', '\\x01')`
    );
    expect((await call('PUT', URL_PATH, valid)).status).toBe(200);
    const counts = await sql.$queryRawUnsafe<
      { t: string; project_id: string }[]
    >(
      `SELECT 'contacts' AS t, project_id FROM marketing.contacts
       UNION ALL SELECT 'devices', project_id FROM marketing.devices
       UNION ALL SELECT 'opt_outs', project_id FROM marketing.opt_outs
       UNION ALL SELECT 'dead_tokens', project_id FROM marketing.dead_tokens
       ORDER BY 1, 2`
    );
    expect(counts).toEqual([
      { t: 'contacts', project_id: 'proj-b' },
      { t: 'dead_tokens', project_id: 'proj-a' },
      { t: 'devices', project_id: 'proj-b' },
      { t: 'opt_outs', project_id: 'proj-a' },
    ]);
  });

  it('a contact a sync commits while the switch to http waits on the source row is still purged', async () => {
    await call('PUT', URL_PATH, { kind: 'stored' });
    let switched: Promise<Response> | undefined;
    // Plays a sync that passed its source check: it holds the row share lock and writes a contact.
    await sql.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT kind FROM marketing.audience_sources WHERE project_id = 'proj-a' FOR SHARE"
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO marketing.contacts (project_id, profile_id, email) VALUES ('proj-a', 'u1', 'a@example.test')`
      );
      switched = call('PUT', URL_PATH, valid);
      for (;;) {
        const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype IN ('transactionid', 'tuple') AND NOT granted"
        );
        if (row?.n) {
          break;
        }
        await Bun.sleep(10);
      }
    });
    expect((await switched)?.status).toBe(200);
    const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM marketing.contacts'
    );
    expect(row?.n).toBe(0);
  });

  it('the stored secret in the database is not the plaintext', async () => {
    await call('PUT', URL_PATH, valid);
    const [row] = await sql.$queryRawUnsafe<{ s: string }[]>(
      'SELECT secret_encrypted AS s FROM marketing.audience_sources'
    );
    expect(row?.s).toBeTruthy();
    expect(row?.s).not.toContain(SECRET);
  });
});
