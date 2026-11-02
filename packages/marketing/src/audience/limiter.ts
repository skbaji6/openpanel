import { randomUUID } from 'node:crypto';
import type { Redis } from '@openpanel/redis';
import { SourceUnavailableError } from './errors';

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

  return {
    async acquire(): Promise<() => Promise<void>> {
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
          throw new SourceUnavailableError('limiter_timeout');
        }
        await sleep(POLL_MS + Math.random() * POLL_JITTER_MS);
      }
      return async () => {
        await redis.zrem(redisKey, slotId);
      };
    },
  };
}
