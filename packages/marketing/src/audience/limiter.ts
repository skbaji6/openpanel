import { randomUUID } from 'node:crypto';
import type { Redis } from '@openpanel/redis';
import { SourceBusyError } from './errors';

const KEY_PREFIX = 'marketing:source-sem:';
const DEFAULT_MAX_WAIT_MS = 10_000;
const POLL_MS = 25;
const POLL_JITTER_MS = 25;

// Caller-supplied `now` (ms) is the slot score, so a fake clock can expire slots in tests.
const ACQUIRE_SCRIPT = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[3]))
  if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
    return 1
  end
  return 0
`;

// XX: a slot already evicted is never re-added, so a refresh cannot push the set past the cap.
const RENEW_SCRIPT = `
  if redis.call('ZADD', KEYS[1], 'XX', 'CH', ARGV[1], ARGV[2]) == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
    return 1
  end
  return 0
`;
const RENEW_INTERVAL_DIVISOR = 3;

interface LimiterOptions {
  key: string;
  cap: number;
  slotTtlMs: number;
  now?: () => number;
  maxWaitMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Pass the fail-fast cache client (getRedisCache style), not a queue client with maxRetriesPerRequest null; slotTtlMs must exceed the worst-case request time.
export function createSourceLimiter(redis: Redis, options: LimiterOptions) {
  const redisKey = `${KEY_PREFIX}${options.key}`;
  const now = options.now ?? Date.now;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  async function acquireSlot() {
    const slotId = randomUUID();
    const startedAt = now();
    for (;;) {
      const acquired = await redis.eval(
        ACQUIRE_SCRIPT,
        1,
        redisKey,
        now(),
        slotId,
        options.slotTtlMs,
        options.cap
      );
      if (acquired === 1) {
        break;
      }
      if (now() - startedAt >= maxWaitMs) {
        throw new SourceBusyError('limiter_timeout');
      }
      await sleep(POLL_MS + Math.random() * POLL_JITTER_MS);
    }
    return {
      slotId,
      release: async () => {
        await redis.zrem(redisKey, slotId);
      },
    };
  }

  return {
    async acquire(): Promise<() => Promise<void>> {
      return (await acquireSlot()).release;
    },
    // Keeps the slot alive for calls that outlast slotTtlMs; released in finally.
    async withSlot<T>(run: () => Promise<T>): Promise<T> {
      const { slotId, release } = await acquireSlot();
      const timer = setInterval(() => {
        redis
          .eval(RENEW_SCRIPT, 1, redisKey, now(), slotId, options.slotTtlMs)
          .catch(() => undefined);
      }, options.slotTtlMs / RENEW_INTERVAL_DIVISOR);
      try {
        return await run();
      } finally {
        clearInterval(timer);
        await release();
      }
    },
  };
}
