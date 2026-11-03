import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { SourceBusyError } from './errors';
import { createSourceLimiter } from './limiter';

const redis = getRedisCache();
const KEY = `test-${randomUUID()}`;
const REDIS_KEY = `marketing:source-sem:${KEY}`;
const SLOT_TTL_MS = 60_000;
const HOLD_MS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await redis.del(REDIS_KEY);
});

afterAll(async () => {
  await redis.del(REDIS_KEY);
  redis.disconnect();
});

describe('source limiter', () => {
  it('two replicas never exceed the cap', async () => {
    const replicaA = createSourceLimiter(redis, {
      key: KEY,
      cap: 2,
      slotTtlMs: SLOT_TTL_MS,
    });
    const replicaB = createSourceLimiter(redis, {
      key: KEY,
      cap: 2,
      slotTtlMs: SLOT_TTL_MS,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const work = async (limiter: typeof replicaA) => {
      const release = await limiter.acquire();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(HOLD_MS);
      inFlight -= 1;
      await release();
    };
    await Promise.all([
      work(replicaA),
      work(replicaB),
      work(replicaA),
      work(replicaB),
      work(replicaA),
    ]);
    expect(maxInFlight).toBe(2);
  });

  it("a crashed holder's slot expires after slotTtlMs", async () => {
    let now = 1_000_000;
    const limiter = createSourceLimiter(redis, {
      key: KEY,
      cap: 1,
      slotTtlMs: 1000,
      now: () => now,
    });
    await limiter.acquire(); // never released
    now += 1001;
    const release = await limiter.acquire();
    await release();
  });

  it('release frees a slot and is idempotent', async () => {
    const limiter = createSourceLimiter(redis, {
      key: KEY,
      cap: 1,
      slotTtlMs: SLOT_TTL_MS,
    });
    const release = await limiter.acquire();
    let second = false;
    const pending = limiter.acquire().then((r) => {
      second = true;
      return r;
    });
    await sleep(HOLD_MS * 2);
    expect(second).toBe(false);
    await release();
    await release();
    const releaseSecond = await pending;
    expect(second).toBe(true);
    await releaseSecond();
    expect(await redis.zcard(REDIS_KEY)).toBe(0);
  });

  it('acquire gives up with limiter_timeout when the cap stays full', async () => {
    const limiter = createSourceLimiter(redis, {
      key: KEY,
      cap: 1,
      slotTtlMs: SLOT_TTL_MS,
      maxWaitMs: 150,
    });
    await limiter.acquire();
    const error = await limiter.acquire().catch((e) => e);
    expect(error).toBeInstanceOf(SourceBusyError);
    expect(error.message).toBe('limiter_timeout');
  });
});

describe('source limiter withSlot', () => {
  it('keeps the slot past slotTtlMs while the call runs, then releases it', async () => {
    const limiter = createSourceLimiter(redis, {
      key: KEY,
      cap: 1,
      slotTtlMs: 300,
      maxWaitMs: 100,
    });
    const call = limiter.withSlot(() => sleep(900));
    await sleep(700);
    const error = await limiter.acquire().catch((e) => e);
    expect(error).toBeInstanceOf(SourceBusyError);
    await call;
    expect(await redis.zcard(REDIS_KEY)).toBe(0);
  });

  it('a renew does not re-add an evicted slot', async () => {
    const limiter = createSourceLimiter(redis, {
      key: KEY,
      cap: 1,
      slotTtlMs: 300,
    });
    const call = limiter.withSlot(() => sleep(400));
    await sleep(50);
    await redis.del(REDIS_KEY);
    await call;
    expect(await redis.zcard(REDIS_KEY)).toBe(0);
  });
});
