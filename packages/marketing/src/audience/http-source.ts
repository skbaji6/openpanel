import { z } from 'zod';
import type { createBreaker } from './breaker';
import {
  type LookupEntry,
  MAX_LOOKUP_IDS,
  MAX_PAGE_SIZE,
  MAX_RESOLVE_INPUTS,
  zCountResponse,
  zExplanation,
  zLookupResponse,
  zMembersResponse,
  zResolveResponse,
  zSchema,
} from './contract';
import {
  SourceAuthError,
  SourceProtocolError,
  SourceUnavailableError,
} from './errors';
import type { createSourceLimiter } from './limiter';
import { newNonce, signRequest } from './signing';
import type { AudienceSource } from './source';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 30_000;
const COUNT_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MS_PER_SECOND = 1000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;

const zValueItem = z.object({ value: z.string(), label: z.string() });
// The owner's contract does not pin this shape; accept a bare array or {values}.
const zDimensionValues = z.union([
  z.array(zValueItem),
  z.object({ values: z.array(zValueItem) }).transform((v) => v.values),
]);

interface HttpSourceOptions {
  baseUrl: string;
  keyId: string;
  secret: string;
  limiter: ReturnType<typeof createSourceLimiter>;
  breaker: ReturnType<typeof createBreaker>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  // Returns a cancel function; injectable so timeout tests need no real waiting.
  setTimer?: (fn: () => void, ms: number) => () => void;
}

// Internal marker for failures worth another attempt.
class RetryableError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultSetTimer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function parseRetryAfter(header: string | null, nowMs: number) {
  if (!header) {
    return;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * MS_PER_SECOND;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

async function readBody(res: Response, label: string): Promise<string> {
  const tooLarge = new SourceProtocolError(`${label}: response too large`);
  if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) {
    await res.body?.cancel();
    throw tooLarge;
  }
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttpSource(opts: HttpSourceOptions): AudienceSource {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const base = new URL(opts.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');

  async function send(
    method: string,
    route: string,
    label: string,
    body: string,
    timeoutMs: number
  ): Promise<string> {
    const controller = new AbortController();
    const cancelTimer = setTimer(() => controller.abort(), timeoutMs);
    try {
      const path = `${basePath}${route}`;
      const headers: Record<string, string> = signRequest({
        method,
        path,
        body,
        keyId: opts.keyId,
        secret: opts.secret,
        timestamp: Math.floor(now() / MS_PER_SECOND),
        nonce: newNonce(),
      });
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
      }
      const res = await doFetch(`${base.origin}${path}`, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        signal: controller.signal,
      });
      const status = res.status;
      if (status === 401 || status === 403) {
        await res.body?.cancel();
        throw new SourceAuthError(`${label}: ${status}`);
      }
      if (status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR) {
        const retryAfter = parseRetryAfter(
          res.headers.get('retry-after'),
          now()
        );
        await res.body?.cancel();
        throw new RetryableError(`${label}: ${status}`, retryAfter);
      }
      if (status < HTTP_OK_MIN || status >= HTTP_OK_MAX) {
        await res.body?.cancel();
        throw new SourceProtocolError(`${label}: ${status}`);
      }
      return await readBody(res, label);
    } catch (error) {
      if (
        error instanceof SourceAuthError ||
        error instanceof SourceProtocolError ||
        error instanceof RetryableError
      ) {
        throw error;
      }
      // fetch TypeError, abort/timeout, or a body read failing mid-stream.
      throw new RetryableError(`${label}: network error`);
    } finally {
      cancelTimer();
    }
  }

  // The limiter slot is held only around one attempt, never across backoff sleeps.
  async function attempt(
    method: string,
    route: string,
    label: string,
    body: string,
    timeoutMs: number
  ) {
    const release = await opts.limiter.acquire();
    try {
      return await send(method, route, label, body, timeoutMs);
    } finally {
      await release();
    }
  }

  function call<T>(
    method: string,
    route: string,
    payload: unknown,
    schema: z.ZodType<T>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    // The query string can carry search text, so errors name the bare route only.
    const label = route.split('?')[0] ?? route;
    return opts.breaker.run(async () => {
      for (let n = 1; ; n++) {
        try {
          const text = await attempt(method, route, label, body, timeoutMs);
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw new SourceProtocolError(`${label}: invalid JSON`);
          }
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new SourceProtocolError(`${label}: schema mismatch`);
          }
          return parsed.data;
        } catch (error) {
          if (!(error instanceof RetryableError)) {
            throw error;
          }
          if (n >= MAX_ATTEMPTS) {
            throw new SourceUnavailableError(error.message);
          }
          const backoff = random() * BACKOFF_BASE_MS * 2 ** (n - 1);
          await sleep(
            Math.min(BACKOFF_CAP_MS, Math.max(backoff, error.retryAfterMs ?? 0))
          );
        }
      }
    });
  }

  return {
    schema: () => call('GET', '/schema', undefined, zSchema),
    dimensionValues: (key, q, limit) =>
      call(
        'GET',
        `/dimensions/${encodeURIComponent(key)}/values?q=${encodeURIComponent(q)}&limit=${limit}`,
        undefined,
        zDimensionValues
      ),
    count: (filter) =>
      call(
        'POST',
        '/audience/count',
        { filter },
        zCountResponse,
        COUNT_TIMEOUT_MS
      ),
    members(req) {
      if (
        !Number.isInteger(req.limit) ||
        req.limit < 1 ||
        req.limit > MAX_PAGE_SIZE
      ) {
        throw new Error(`members limit must be 1..${MAX_PAGE_SIZE}`);
      }
      return call('POST', '/audience/members', req, zMembersResponse);
    },
    explain: (filter, id) =>
      call('POST', '/audience/explain', { filter, id }, zExplanation),
    async lookup(ids, channel) {
      const unique = [...new Set(ids)];
      const byId = new Map<string, LookupEntry>();
      for (const part of chunk(unique, MAX_LOOKUP_IDS)) {
        const wanted = new Set(part);
        const res = await call(
          'POST',
          '/members/lookup',
          { ids: part, channel },
          zLookupResponse
        );
        for (const entry of res.entries) {
          if (wanted.has(entry.id) && !byId.has(entry.id)) {
            byId.set(entry.id, entry);
          }
        }
      }
      return unique.map(
        (id): LookupEntry => byId.get(id) ?? { id, status: 'not_found' }
      );
    },
    async resolve(inputs) {
      const matches: { input: string; id: string }[] = [];
      const unmatched: string[] = [];
      for (const part of chunk(inputs, MAX_RESOLVE_INPUTS)) {
        const res = await call(
          'POST',
          '/members/resolve',
          { inputs: part },
          zResolveResponse
        );
        matches.push(...res.matches);
        unmatched.push(...res.unmatched);
      }
      return { matches, unmatched };
    },
  };
}
