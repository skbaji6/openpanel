import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { readFileSync } from 'node:fs';
import { parseMapping } from '../examples/audience-api-postgres/mapping';
import { createServer } from '../examples/audience-api-postgres/server';
import { newNonce, signRequest } from '../src/audience/signing';
import { runConformance } from './run';
import referenceMapping from './seed/reference-mapping.json';

const KEY = { id: 'conformance', secret: 'conformance-test-secret' };
const BASE_PATH = '/internal/audience';
const SLOW_STEP_MS = 3000;

const databaseUrl = (process.env.DATABASE_URL ?? '').split('?')[0] ?? '';
const sql = new SQL(databaseUrl);

const reference = createServer({
  mapping: parseMapping(referenceMapping),
  keys: [KEY],
  basePath: BASE_PATH,
  db: {
    async query(text, params) {
      return { rows: [...(await sql.unsafe(text, params as never[]))] };
    },
  },
});

// Re-signs every request with the real key, so the target accepts anything, and fails on SQL-looking input.
async function brokenFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === 'GET' ? '' : await req.text();
  if (decodeURIComponent(`${url.search}${body}`).includes('DROP')) {
    return new Response('boom', { status: 500 });
  }
  const path = `${url.pathname}${url.search}`;
  const headers = signRequest({
    method: req.method,
    path,
    body,
    keyId: KEY.id,
    secret: KEY.secret,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: newNonce(),
  });
  return reference.fetch(
    new Request(req.url, {
      method: req.method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: req.method === 'GET' ? undefined : body,
    })
  );
}

let referenceServer: ReturnType<typeof Bun.serve>;
let brokenServer: ReturnType<typeof Bun.serve>;
const target = (server: ReturnType<typeof Bun.serve>) => ({
  baseUrl: `http://127.0.0.1:${server.port}${BASE_PATH}`,
  keyId: KEY.id,
  secret: KEY.secret,
});

beforeAll(async () => {
  await sql.unsafe(
    readFileSync(new URL('seed/seed.sql', import.meta.url), 'utf8')
  );
  referenceServer = Bun.serve({ port: 0, fetch: reference.fetch });
  brokenServer = Bun.serve({ port: 0, fetch: brokenFetch });
});

afterAll(async () => {
  referenceServer?.stop(true);
  brokenServer?.stop(true);
  await sql.unsafe('DROP SCHEMA IF EXISTS conformance_demo CASCADE');
  await sql.close();
});

describe('conformance suite', () => {
  it('the reference service on the conformance seed passes every check', async () => {
    const result = await runConformance(target(referenceServer));
    expect(result.failed).toEqual([]);
    expect(result.passed).toBeGreaterThan(20);
    expect(result.warnings.map((w) => w.check)).not.toContain(
      'service_level_count'
    );
  });

  it('a target that skips the signature check and 500s on injection fails those checks', async () => {
    const result = await runConformance(target(brokenServer));
    const failed = result.failed.map((f) => f.check).sort();
    expect(failed).toEqual([
      'injection',
      'security_no_key',
      'security_replayed_nonce',
      'security_stale_timestamp',
      'security_tampered_body',
      'security_wrong_key',
    ]);
    for (const failure of result.failed) {
      expect(failure.detail).not.toContain(KEY.secret);
    }
  });

  it('slow responses are warnings, not failures', async () => {
    let clock = 0;
    const result = await runConformance(target(referenceServer), {
      clock: () => {
        clock += SLOW_STEP_MS;
        return clock;
      },
    });
    expect(result.failed).toEqual([]);
    const warned = result.warnings.map((w) => w.check);
    expect(warned).toContain('service_level_count');
    expect(warned).toContain('service_level_page');
    expect(warned).toContain('service_level_lookup');
  });
});
