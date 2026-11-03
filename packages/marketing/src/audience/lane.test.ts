import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { SourceBusyError } from './errors';
import { campaignLaneCap, withCampaignLane } from './lane';
import { createSourceLimiter } from './limiter';
import type { AudienceSource } from './source';

const redis = getRedisCache();
const PROJECT_ID = `test-${randomUUID()}`;
const LANE_KEY = `marketing:source-sem:${PROJECT_ID}:campaign-lane`;
const SHARED_KEY = `marketing:source-sem:${PROJECT_ID}`;
const SLOT_TTL_MS = 60_000;
const SETTLE_MS = 100;
const SHORT_WAIT_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await redis.del(LANE_KEY, SHARED_KEY);
});

afterAll(async () => {
  await redis.del(LANE_KEY, SHARED_KEY);
  redis.disconnect();
});

// Inner source whose count() takes a shared slot and holds it until released.
function createHeldSource(sharedCap: number) {
  const shared = createSourceLimiter(redis, {
    key: PROJECT_ID,
    cap: sharedCap,
    slotTtlMs: SLOT_TTL_MS,
  });
  const gates: (() => void)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failNext = false;
  const source = {
    async count() {
      const release = await shared.acquire();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        await new Promise<void>((resolve) => gates.push(resolve));
        return { count: 1 };
      } finally {
        inFlight -= 1;
        await release();
      }
    },
  } as unknown as AudienceSource;
  return {
    shared,
    source,
    releaseAll: () => {
      for (const gate of gates.splice(0)) {
        gate();
      }
    },
    failNextCall: () => {
      failNext = true;
    },
    maxInFlight: () => maxInFlight,
  };
}

const callCount = (source: AudienceSource) => source.count({} as never);

describe('campaign lane', () => {
  it('reserves one slot: cap is concurrency - 1, never below 1', () => {
    expect(campaignLaneCap(4)).toBe(3);
    expect(campaignLaneCap(1)).toBe(1);
  });

  it('with concurrency 4 at most 3 campaign-lane calls run at once', async () => {
    const held = createHeldSource(4);
    const lane = withCampaignLane(held.source, {
      redis,
      projectId: PROJECT_ID,
      sourceConcurrency: 4,
    });
    const calls = Array.from({ length: 5 }, () => callCount(lane));
    await sleep(SETTLE_MS);
    expect(held.maxInFlight()).toBe(3);
    expect(await redis.zcard(LANE_KEY)).toBe(3);
    // Release until all five have run, so no promise dangles.
    for (let i = 0; i < 5; i += 1) {
      held.releaseAll();
      await sleep(SETTLE_MS);
    }
    await Promise.all(calls);
    expect(held.maxInFlight()).toBe(3);
  });

  it('a journey call through the shared limiter acquires while 3 campaign-lane calls are in flight', async () => {
    const held = createHeldSource(4);
    const lane = withCampaignLane(held.source, {
      redis,
      projectId: PROJECT_ID,
      sourceConcurrency: 4,
    });
    const calls = Array.from({ length: 3 }, () => callCount(lane));
    await sleep(SETTLE_MS);
    expect(await redis.zcard(SHARED_KEY)).toBe(3);
    const journeyLimiter = createSourceLimiter(redis, {
      key: PROJECT_ID,
      cap: 4,
      slotTtlMs: SLOT_TTL_MS,
      maxWaitMs: SHORT_WAIT_MS,
    });
    const release = await journeyLimiter.acquire();
    await release();
    held.releaseAll();
    await Promise.all(calls);
  });

  it('with concurrency 1 the lane cap is 1 and campaign calls still proceed', async () => {
    const held = createHeldSource(1);
    const lane = withCampaignLane(held.source, {
      redis,
      projectId: PROJECT_ID,
      sourceConcurrency: 1,
    });
    const first = callCount(lane);
    await sleep(SETTLE_MS);
    held.releaseAll();
    expect(await first).toEqual({ count: 1 });
    const second = callCount(lane);
    await sleep(SETTLE_MS);
    held.releaseAll();
    expect(await second).toEqual({ count: 1 });
  });

  it('a lane wait over maxWaitMs throws SourceBusyError', async () => {
    const held = createHeldSource(4);
    const lane = withCampaignLane(held.source, {
      redis,
      projectId: PROJECT_ID,
      sourceConcurrency: 2,
      maxWaitMs: SHORT_WAIT_MS,
    });
    const holder = callCount(lane);
    await sleep(SETTLE_MS);
    const error = await callCount(lane).catch((e) => e);
    expect(error).toBeInstanceOf(SourceBusyError);
    held.releaseAll();
    await holder;
  });

  it('an error inside the call releases the lane slot', async () => {
    const held = createHeldSource(4);
    const lane = withCampaignLane(held.source, {
      redis,
      projectId: PROJECT_ID,
      sourceConcurrency: 2,
    });
    held.failNextCall();
    await expect(callCount(lane)).rejects.toThrow('boom');
    expect(await redis.zcard(LANE_KEY)).toBe(0);
  });
});
