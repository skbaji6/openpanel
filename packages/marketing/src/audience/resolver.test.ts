import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { getRedisCache } from '@openpanel/redis';
import { encryptCredential } from '@openpanel/shared/server';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createSourceResolver } from './resolver';

const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  MARKETING_PROXY_SECRET: 'p',
  MARKETING_PUBLIC_URL: 'https://marketing.test',
});
const redis = getRedisCache();
const CACHE_MS = 30_000;

let clock = 0;
const resolver = createSourceResolver({ sql, cfg, redis, now: () => clock });

async function put(projectId: string, kind: 'stored' | 'http') {
  const http = kind === 'http';
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.audience_sources (project_id, kind, base_url, key_id, secret_encrypted)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id) DO UPDATE SET kind = EXCLUDED.kind, base_url = EXCLUDED.base_url,
       key_id = EXCLUDED.key_id, secret_encrypted = EXCLUDED.secret_encrypted`,
    projectId,
    kind,
    http ? 'https://x.test' : null,
    http ? 'k1' : null,
    http ? encryptCredential(cfg.encryptionKey, 'secret') : null
  );
}

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  clock = 1_700_000_000_000;
  await resetMarketingTables();
});
afterAll(async () => {
  redis.disconnect();
  await sql.$disconnect();
});

describe('source resolver', () => {
  it('returns null for stored and for a missing row', async () => {
    await put('p-stored', 'stored');
    expect(await resolver.forProject('p-stored')).toBeNull();
    expect(await resolver.forProject('p-missing')).toBeNull();
  });

  it('returns a source for http', async () => {
    await put('p-http', 'http');
    expect(await resolver.forProject('p-http')).not.toBeNull();
  });

  it('caches for 30 seconds and refreshes after a PUT', async () => {
    await put('p-cache', 'http');
    const first = await resolver.forProject('p-cache');
    expect(await resolver.forProject('p-cache')).toBe(first);
    await put('p-cache', 'stored');
    expect(await resolver.forProject('p-cache')).toBe(first);
    resolver.invalidate('p-cache');
    expect(await resolver.forProject('p-cache')).toBeNull();
    await put('p-cache', 'http');
    clock += CACHE_MS - 1;
    expect(await resolver.forProject('p-cache')).toBeNull();
    clock += 1;
    expect(await resolver.forProject('p-cache')).not.toBeNull();
  });
});
