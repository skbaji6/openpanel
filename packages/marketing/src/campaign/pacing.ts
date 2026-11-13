import type { Redis } from '@openpanel/redis';
import { retryAfterMs } from '../channels/retry-after';
import type { Queryable } from '../engine/engine';
import { countChannelSendsSince } from '../engine/ledger';
import { zonedTimeToUtc } from './schedule-time';

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;
const BUCKET_MIN_TTL_MS = 60_000;
const MAX_CLAIM = 500;
const CLAIM_SECONDS_OF_TOKENS = 10;
const MAX_MIDNIGHT_SEARCH_HOURS = 3;

// Without an injected clock (ARGV[1] empty) time is Redis TIME, so every replica shares one clock.
// Tokens are a float string; a backwards step only clamps elapsed to 0 and never moves ts back.
const TAKE_SCRIPT = `
local now = tonumber(ARGV[1])
if now == nil then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local rate = tonumber(ARGV[2])
local wanted = tonumber(ARGV[3])
local capacity = math.max(1, rate)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)
ts = math.max(ts, now)
local granted = math.min(wanted, math.floor(tokens))
tokens = tokens - granted
local wait = 0
if granted < wanted then
  wait = math.ceil((1 - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.9f', tokens), 'ts', string.format('%.0f', ts))
-- Outlive a full refill, or an idle slow bucket would come back full.
redis.call('PEXPIRE', KEYS[1], math.max(${BUCKET_MIN_TTL_MS}, math.ceil(capacity / rate * 1000)))
return {granted, wait}`;

// The value is the Redis-clock epoch ms the backoff ends at, so a shorter one never overwrites a longer one.
const BACKOFF_SCRIPT = `
local t = redis.call('TIME')
local untilMs = t[1] * 1000 + math.floor(t[2] / 1000) + tonumber(ARGV[1])
local current = tonumber(redis.call('GET', KEYS[1]))
if current == nil or current < untilMs then
  redis.call('SET', KEYS[1], string.format('%.0f', untilMs), 'PX', ARGV[1])
end
return 1`;

export interface RateBucket {
  take(
    key: string,
    ratePerSecond: number,
    wanted: number
  ): Promise<{ granted: number; waitMs: number }>;
}

export function createRateBucket(
  redis: Redis,
  opts: { now?: () => number }
): RateBucket {
  const { now } = opts;
  return {
    async take(key, ratePerSecond, wanted) {
      if (!(ratePerSecond > 0)) {
        throw new RangeError('ratePerSecond must be positive');
      }
      const whole = Math.floor(wanted);
      if (!(whole > 0)) {
        return { granted: 0, waitMs: 0 };
      }
      const [granted, waitMs] = (await redis.eval(
        TAKE_SCRIPT,
        1,
        `marketing:rate:${key}`,
        now ? String(now()) : '',
        String(ratePerSecond),
        String(whole)
      )) as [number, number];
      return { granted, waitMs };
    },
  };
}

export async function acquireTokens(
  bucket: RateBucket,
  key: string,
  ratePerSecond: number | null,
  wanted: number,
  budgetMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<number> {
  if (ratePerSecond === null) {
    return wanted;
  }
  let got = 0;
  let waited = 0;
  while (got < wanted) {
    const { granted, waitMs } = await bucket.take(
      key,
      ratePerSecond,
      wanted - got
    );
    got += granted;
    if (got >= wanted || waited + waitMs > budgetMs) {
      return got;
    }
    waited += waitMs;
    await sleep(waitMs);
  }
  return got;
}

export function createChannelBackoff(redis: Redis) {
  const key = (projectId: string, channel: string) =>
    `marketing:channel-backoff:${projectId}:${channel}`;
  return {
    async set(projectId: string, channel: string, ms: number): Promise<void> {
      if (!(ms > 0)) {
        return;
      }
      await redis.eval(
        BACKOFF_SCRIPT,
        1,
        key(projectId, channel),
        String(Math.ceil(ms))
      );
    },
    async until(projectId: string, channel: string): Promise<number | null> {
      const [value, [seconds, micros]] = await Promise.all([
        redis.get(key(projectId, channel)),
        redis.time(),
      ]);
      const until = Number(value);
      const redisNow =
        Number(seconds) * MS_PER_SECOND +
        Math.floor(Number(micros) / MS_PER_SECOND);
      return until > redisNow ? until : null;
    },
  };
}

function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

// A zone that skips local midnight (a DST jump at 00:00) starts its day at the first hour that exists.
function localMidnight(date: string, timeZone: string): Date {
  for (let hour = 0; hour <= MAX_MIDNIGHT_SEARCH_HOURS; hour++) {
    const instant = zonedTimeToUtc(
      `${date}T${String(hour).padStart(2, '0')}:00`,
      timeZone
    );
    if (instant) {
      return instant;
    }
  }
  throw new Error(`no local midnight for ${date} in ${timeZone}`);
}

export function quotaDayStart(now: Date, timeZone: string): Date {
  return localMidnight(localDate(now, timeZone), timeZone);
}

export function nextQuotaDayStart(now: Date, timeZone: string): Date {
  const today = Date.parse(`${localDate(now, timeZone)}T00:00:00Z`);
  const tomorrow = new Date(today + MS_PER_DAY).toISOString().slice(0, 10);
  return localMidnight(tomorrow, timeZone);
}

export async function remainingQuota(
  tx: Queryable,
  args: {
    projectId: string;
    channel: string;
    dailyQuota: number;
    quotaTimezone: string;
    now: Date;
  }
): Promise<number> {
  const sent = await countChannelSendsSince(
    tx,
    args.projectId,
    args.channel,
    quotaDayStart(args.now, args.quotaTimezone)
  );
  return Math.max(0, args.dailyQuota - sent);
}

export function claimSize(ratePerSecond: number | null): number {
  if (ratePerSecond === null) {
    return MAX_CLAIM;
  }
  return Math.min(
    MAX_CLAIM,
    Math.max(1, Math.ceil(ratePerSecond * CLAIM_SECONDS_OF_TOKENS))
  );
}

export { retryAfterMs };
