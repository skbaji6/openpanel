import { beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from '../api/server';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import type { Sql } from '../engine/engine';
import { linkKey } from './keys';
import { LINK_TOKEN_TTL_DAYS, sealLinkToken } from './token';

const ENCRYPTION_KEY = 'cd'.repeat(32);
const BASE = 'http://marketing.internal';
const TARGET_URL = 'https://school.test/landing?a=1&b=2';
const SOURCE_REF = 'campaign:11111111-2222-3333-4444-555555555555:student-77';
const MS_PER_DAY = 86_400_000;
const RATE_LIMIT = 30;
const CLICKS = 1000;
const CLICKS_TEST_TIMEOUT_MS = 60_000;
const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY,
  MARKETING_PROXY_SECRET: 'proxy-secret-for-tests',
  MARKETING_PUBLIC_URL: 'https://marketing.test',
  MARKETING_TRUST_PROXY: 'true',
});

let app = createServer({ cfg, sql });

const get = (token: string, ip = '10.0.0.1') =>
  app.fetch(
    new Request(`${BASE}/marketing/r/${token}`, {
      headers: { 'x-forwarded-for': ip },
    })
  );

function tokenFor(projectId: string, linkId: string, expiresAt?: Date) {
  return sealLinkToken(linkKey(ENCRYPTION_KEY, projectId), projectId, {
    sourceRef: SOURCE_REF,
    linkId,
    expiresAt:
      expiresAt ?? new Date(Date.now() + LINK_TOKEN_TTL_DAYS * MS_PER_DAY),
  });
}

async function addLink(projectId: string) {
  const [row] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.tracked_links (id, project_id, url)
     VALUES (gen_random_uuid(), $1, $2) RETURNING id::text AS id`,
    projectId,
    TARGET_URL
  );
  return row?.id ?? '';
}

async function addMessage(status: string, projectId = 'p1') {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.message_tracking (source_ref, project_id, profile_id, status, sent_at)
     VALUES ($1, $2, 'student-77', $3, now())`,
    SOURCE_REF,
    projectId,
    status
  );
}

async function message() {
  const rows = await sql.$queryRawUnsafe<
    { status: string; clicked_at: Date | null; accepted_at: Date | null }[]
  >(
    'SELECT status, clicked_at, accepted_at FROM marketing.message_tracking WHERE source_ref = $1',
    SOURCE_REF
  );
  return rows[0];
}

type Execute = (query: string, ...params: unknown[]) => Promise<number>;

function withExecute(wrap: (real: Execute) => Execute): Sql {
  return new Proxy(sql, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === '$executeRawUnsafe') {
        return wrap((query, ...params) =>
          (value as Execute).call(target, query, ...params)
        );
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Sql;
}

beforeEach(async () => {
  app = createServer({ cfg, sql });
  await migrate();
  await resetMarketingTables();
});

describe('redirect endpoint', () => {
  it('a valid token redirects 302 to the stored url and records clicked', async () => {
    const linkId = await addLink('p1');
    await addMessage('sent');
    const res = await get(tokenFor('p1', linkId));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TARGET_URL);
    const row = await message();
    expect(row?.status).toBe('clicked');
    expect(row?.clicked_at).toBeInstanceOf(Date);
    expect(row?.accepted_at).toBeInstanceOf(Date);
  });

  it('a ?url= query and a forged link id never change the Location', async () => {
    const linkId = await addLink('p1');
    const res = await app.fetch(
      new Request(
        `${BASE}/marketing/r/${tokenFor('p1', linkId)}?url=https://evil.test`
      )
    );
    expect(res.headers.get('location')).toBe(TARGET_URL);
    const forged = await get(
      tokenFor('p1', '00000000-0000-4000-8000-000000000000')
    );
    expect(forged.status).toBe(404);
    expect(forged.headers.get('location')).toBeNull();
  });

  it('a link id from another project is 404', async () => {
    const otherLink = await addLink('p2');
    const res = await get(tokenFor('p1', otherLink));
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('an expired token is 410', async () => {
    const linkId = await addLink('p1');
    const res = await get(tokenFor('p1', linkId, new Date(Date.now() - 5000)));
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('This link has expired');
  });

  it('a garbage token is 404 and the 31st garbage token from one ip in a window is 429', async () => {
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect((await get(`garbage${i}`, '10.9.9.9')).status).toBe(404);
    }
    expect((await get('garbage-x', '10.9.9.9')).status).toBe(429);
    expect((await get('garbage-x', '10.9.9.8')).status).toBe(404);
  });

  it(
    '1,000 clicks on one valid link redirect every time and update the row once',
    async () => {
      const linkId = await addLink('p1');
      await addMessage('sent');
      let changed = 0;
      app = createServer({
        cfg,
        sql: withExecute((real) => async (query, ...params) => {
          const count = await real(query, ...params);
          if (query.trim().startsWith('UPDATE marketing.message_tracking')) {
            changed += count;
          }
          return count;
        }),
      });
      const token = tokenFor('p1', linkId);
      const statuses = new Set<number>();
      for (let i = 0; i < CLICKS; i++) {
        statuses.add((await get(token)).status);
      }
      expect([...statuses]).toEqual([302]);
      expect(changed).toBe(1);
    },
    CLICKS_TEST_TIMEOUT_MS
  );

  it('a purged message still redirects', async () => {
    const linkId = await addLink('p1');
    const res = await get(tokenFor('p1', linkId));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TARGET_URL);
  });

  it('a click on a converted message keeps status converted and sets clicked_at', async () => {
    const linkId = await addLink('p1');
    await addMessage('converted');
    await get(tokenFor('p1', linkId));
    const row = await message();
    expect(row?.status).toBe('converted');
    expect(row?.clicked_at).toBeInstanceOf(Date);
  });

  it('a click for a message of another project changes nothing', async () => {
    const linkId = await addLink('p1');
    await addMessage('sent', 'p2');
    expect((await get(tokenFor('p1', linkId))).status).toBe(302);
    expect((await message())?.clicked_at).toBeNull();
  });

  it('a click write failure still redirects', async () => {
    const linkId = await addLink('p1');
    app = createServer({
      cfg,
      sql: withExecute(() => () => Promise.reject(new Error('db down'))),
    });
    const res = await get(tokenFor('p1', linkId));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TARGET_URL);
  });

  it('responses carry no-store, no-referrer and noindex', async () => {
    const linkId = await addLink('p1');
    for (const res of [
      await get(tokenFor('p1', linkId)),
      await get('garbage'),
      await get(tokenFor('p1', linkId, new Date(0))),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
    }
  });
});
