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
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { inQuietHours, nextAllowedTime } from '../engine/gates';
import { recordLedger } from '../engine/ledger';
import {
  acquireTokens,
  claimSize,
  createChannelBackoff,
  createRateBucket,
  nextQuotaDayStart,
  quotaDayStart,
  remainingQuota,
  retryAfterMs,
} from './pacing';

const redis = getRedisCache();
const PROJECT = `pacing-${randomUUID()}`;
const CHANNEL = 'sms';
const BUCKET_KEY = `${PROJECT}:${CHANNEL}`;
const SECOND_MS = 1000;
const START = Date.parse('2026-11-10T12:00:00.000Z');

function clock(start = START) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (value: number) => {
      t = value;
    },
  };
}

async function cleanKeys() {
  for (const prefix of ['marketing:rate:', 'marketing:channel-backoff:']) {
    const keys = await redis.keys(`${prefix}${PROJECT}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await cleanKeys();
  await resetMarketingTables();
});
afterAll(cleanKeys);

describe('createRateBucket', () => {
  it('rate 10 grants 10 at once and then 0 with waitMs about 100', async () => {
    const c = clock();
    const bucket = createRateBucket(redis, { now: c.now });
    expect(await bucket.take(BUCKET_KEY, 10, 25)).toEqual({
      granted: 10,
      waitMs: 100,
    });
    const next = await bucket.take(BUCKET_KEY, 10, 1);
    expect(next.granted).toBe(0);
    expect(next.waitMs).toBe(100);
  });

  it('two bucket clients on one key share the budget', async () => {
    const c = clock();
    const a = createRateBucket(redis, { now: c.now });
    const b = createRateBucket(redis, { now: c.now });
    let granted = 0;
    for (let i = 0; i < 20; i++) {
      granted += (await (i % 2 ? a : b).take(BUCKET_KEY, 10, 1)).granted;
    }
    expect(granted).toBe(10);
  });

  it('fractional rate 0.5 grants 1 then waits about 2,000 ms', async () => {
    const bucket = createRateBucket(redis, { now: clock().now });
    expect((await bucket.take(BUCKET_KEY, 0.5, 1)).granted).toBe(1);
    expect(await bucket.take(BUCKET_KEY, 0.5, 1)).toEqual({
      granted: 0,
      waitMs: 2000,
    });
  });

  it('wanted 0 grants 0 with waitMs 0', async () => {
    const bucket = createRateBucket(redis, { now: clock().now });
    expect(await bucket.take(BUCKET_KEY, 10, 0)).toEqual({
      granted: 0,
      waitMs: 0,
    });
  });

  it('a slow bucket outlives an idle minute instead of returning full', async () => {
    const c = clock();
    const bucket = createRateBucket(redis, { now: c.now });
    expect((await bucket.take(BUCKET_KEY, 0.01, 1)).granted).toBe(1);
    c.advance(70 * SECOND_MS);
    expect(await redis.pttl(`marketing:rate:${BUCKET_KEY}`)).toBeGreaterThan(
      60_000
    );
    expect((await bucket.take(BUCKET_KEY, 0.01, 1)).granted).toBe(0);
  });

  it('a stored ts far in the future does not starve the bucket', async () => {
    const c = clock();
    const bucket = createRateBucket(redis, { now: c.now });
    c.set(START + 3_600_000);
    expect((await bucket.take(BUCKET_KEY, 10, 10)).granted).toBe(10);
    c.set(START);
    expect((await bucket.take(BUCKET_KEY, 10, 1)).granted).toBe(0);
    c.set(START + 2000);
    expect((await bucket.take(BUCKET_KEY, 10, 20)).granted).toBe(10);
  });

  it('wanted 2.5 grants 2 and removes 2 tokens', async () => {
    const bucket = createRateBucket(redis, { now: clock().now });
    expect((await bucket.take(BUCKET_KEY, 10, 2.5)).granted).toBe(2);
    expect((await bucket.take(BUCKET_KEY, 10, 20)).granted).toBe(8);
    expect(await bucket.take(BUCKET_KEY, 10, -3)).toEqual({
      granted: 0,
      waitMs: 0,
    });
  });

  it('a clock going backwards grants nothing extra', async () => {
    const c = clock();
    const bucket = createRateBucket(redis, { now: c.now });
    await bucket.take(BUCKET_KEY, 10, 10);
    c.advance(-5 * SECOND_MS);
    expect((await bucket.take(BUCKET_KEY, 10, 5)).granted).toBe(0);
    c.set(START + 100);
    expect((await bucket.take(BUCKET_KEY, 10, 5)).granted).toBe(1);
  });
});

describe('acquireTokens', () => {
  it('for 25 at rate 10 waits about 1.5 s through the injected sleep', async () => {
    const c = clock();
    const bucket = createRateBucket(redis, { now: c.now });
    let slept = 0;
    const got = await acquireTokens(
      bucket,
      BUCKET_KEY,
      10,
      25,
      10_000,
      (ms) => {
        slept += ms;
        c.advance(ms);
        return Promise.resolve();
      }
    );
    expect(got).toBe(25);
    expect(slept).toBeGreaterThanOrEqual(1500);
    expect(slept).toBeLessThan(1700);
  });

  it('stops at budgetMs and returns what it got without sleeping past it', async () => {
    const c = clock();
    const bucket = createRateBucket(redis, { now: c.now });
    let slept = 0;
    const got = await acquireTokens(bucket, BUCKET_KEY, 10, 25, 500, (ms) => {
      slept += ms;
      c.advance(ms);
      return Promise.resolve();
    });
    expect(got).toBeGreaterThanOrEqual(10);
    expect(got).toBeLessThan(25);
    expect(slept).toBeLessThanOrEqual(500);
  });

  it('a null rate returns wanted immediately', async () => {
    const bucket = createRateBucket(redis, {});
    expect(
      await acquireTokens(bucket, BUCKET_KEY, null, 7, 0, () =>
        Promise.resolve()
      )
    ).toBe(7);
  });
});

describe('createChannelBackoff', () => {
  it('set 5 s then 1 s keeps 5 s', async () => {
    const backoff = createChannelBackoff(redis);
    await backoff.set(PROJECT, CHANNEL, 5000);
    await backoff.set(PROJECT, CHANNEL, 1000);
    const until = await backoff.until(PROJECT, CHANNEL);
    expect(until).not.toBeNull();
    expect((until as number) - Date.now()).toBeGreaterThan(3500);
    expect(await backoff.until(PROJECT, 'other')).toBeNull();
    await backoff.set(PROJECT, 'zero', 0);
    expect(await backoff.until(PROJECT, 'zero')).toBeNull();
  });
});

describe('retryAfterMs', () => {
  it('clamps seconds, defaults a missing header, parses HTTP dates', () => {
    expect(retryAfterMs('120')).toBe(60_000);
    expect(retryAfterMs('0')).toBe(1000);
    expect(retryAfterMs(null)).toBe(5000);
    expect(retryAfterMs('garbage')).toBe(5000);
    const date = new Date(Date.now() + 20_000).toUTCString();
    expect(retryAfterMs(date)).toBeGreaterThan(18_000);
    expect(retryAfterMs(date)).toBeLessThanOrEqual(20_000);
  });
});

describe('quota day', () => {
  it('quotaDayStart 2026-11-10T20:00Z in Asia/Kolkata is 2026-11-10T18:30Z', () => {
    expect(
      quotaDayStart(
        new Date('2026-11-10T20:00:00Z'),
        'Asia/Kolkata'
      ).toISOString()
    ).toBe('2026-11-10T18:30:00.000Z');
  });

  it('nextQuotaDayStart across a New York DST change is local midnight', () => {
    // US DST ends 2026-11-01: that local day is 25 hours long.
    expect(
      nextQuotaDayStart(
        new Date('2026-11-01T12:00:00Z'),
        'America/New_York'
      ).toISOString()
    ).toBe('2026-11-02T05:00:00.000Z');
    expect(
      quotaDayStart(
        new Date('2026-11-01T12:00:00Z'),
        'America/New_York'
      ).toISOString()
    ).toBe('2026-11-01T04:00:00.000Z');
  });

  it('remainingQuota counts ledger rows of today only (local day)', async () => {
    const now = new Date('2026-11-10T20:00:00Z');
    const row = (ref: string, sentAt: string) => ({
      sourceRef: ref,
      projectId: PROJECT,
      profileId: ref,
      channel: CHANNEL,
      sentAt: new Date(sentAt),
    });
    await recordLedger(sql, [
      row('a', '2026-11-10T18:29:00Z'),
      row('b', '2026-11-10T18:31:00Z'),
      row('c', '2026-11-10T19:00:00Z'),
    ]);
    const args = {
      projectId: PROJECT,
      channel: CHANNEL,
      quotaTimezone: 'Asia/Kolkata',
      now,
    };
    expect(await remainingQuota(sql, { ...args, dailyQuota: 10 })).toBe(8);
    expect(await remainingQuota(sql, { ...args, dailyQuota: 1 })).toBe(0);
  });
});

describe('claimSize', () => {
  it('claimSize(1) is 10, claimSize(100) is 500, claimSize(null) is 500', () => {
    expect(claimSize(1)).toBe(10);
    expect(claimSize(100)).toBe(500);
    expect(claimSize(null)).toBe(500);
    expect(claimSize(0.01)).toBe(1);
  });
});

describe('quiet hours 21:00 to 08:00 Asia/Kolkata', () => {
  const quiet = { start: '21:00', end: '08:00', timezone: 'Asia/Kolkata' };
  it('pins the gate edges', () => {
    expect(inQuietHours(new Date('2026-11-10T15:29:00Z'), quiet)).toBe(false);
    expect(inQuietHours(new Date('2026-11-10T15:30:00Z'), quiet)).toBe(true);
    expect(
      nextAllowedTime(new Date('2026-11-10T16:00:00Z'), quiet).toISOString()
    ).toBe('2026-11-11T02:30:00.000Z');
  });
});
