import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../config';
import type { Sql } from '../engine/engine';
import { HttpError } from './http';
import { createServer } from './server';

const cfg = loadConfig({
  DATABASE_URL: 'postgres://unused',
  REDIS_URL: 'redis://unused',
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  MARKETING_PROXY_SECRET: 'proxy-secret-for-tests',
  MARKETING_PUBLIC_URL: 'https://marketing.test',
});

describe('server error body', () => {
  it('serialises HttpError details', async () => {
    // The api-key lookup is the first query of a sync request, so a throw there reaches the error handler.
    const sql = {
      $queryRawUnsafe: () =>
        Promise.reject(
          new HttpError(409, 'confirmation_required', undefined, { count: 5 })
        ),
    } as unknown as Sql;
    const app = createServer({ cfg, sql });
    const res = await app.fetch(
      new Request('http://marketing.internal/marketing/devices', {
        method: 'PUT',
        headers: {
          'x-marketing-api-key': `${crypto.randomUUID()}.${'a'.repeat(30)}`,
        },
      })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'confirmation_required',
      details: { count: 5 },
    });
  });
});
