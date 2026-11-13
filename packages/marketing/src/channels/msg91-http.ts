import { z } from 'zod';
import type { BatchItem, DeliveryOutcome } from './batch';
import { retryAfterMs } from './retry-after';
import { SEND_TIMEOUT_MS } from './timeouts';

export const MSG91_SMS_BASE_URL = 'https://control.msg91.com';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const HTTP_OK_MIN = 200;
const HTTP_REDIRECT_MIN = 300;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_UNPROCESSABLE = 422;
const HTTP_RATE_LIMITED = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;
// Single recipients rejected before a group (one template) that never succeeded is written off.
const BREAKER_SINGLE_REJECTIONS = 3;
// Bisection requests share one budget of this many request timeouts per chunk.
const CHUNK_BUDGET_FACTOR = 3;
const PROVIDER_CODE = /^[A-Za-z0-9_]{1,32}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
// Errors Bun's fetch raises before a single byte of the request could have left; anything else may have been delivered.
const NOT_SENT_ERROR_CODES = new Set([
  'ConnectionRefused',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const BASE_URL_MESSAGE = 'must be an https origin (http only for localhost)';

function toOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const secure =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
    const bare =
      !(url.username || url.password || url.search || url.hash) &&
      url.pathname === '/' &&
      !value.includes('?') &&
      !value.includes('#');
    return secure && bare ? url.origin : null;
  } catch {
    return null;
  }
}

// Stored as an origin, so appending a path can never produce a double slash.
export const zMsg91BaseUrl = z
  .string()
  .max(200)
  .transform((value, ctx) => {
    const origin = toOrigin(value);
    if (origin === null) {
      ctx.addIssue({ code: 'custom', message: BASE_URL_MESSAGE });
      return z.NEVER;
    }
    return origin;
  });

export type Msg91Post =
  | {
      kind: 'response';
      status: number;
      json: unknown;
      retryAfter: string | null;
    }
  | { kind: 'not_sent' }
  | { kind: 'unknown'; reason: 'timeout' | 'network' };

export async function postMsg91(
  url: string,
  authKey: string,
  body: unknown,
  signal: AbortSignal
): Promise<Msg91Post> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authkey: authKey,
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && NOT_SENT_ERROR_CODES.has(code)) {
      return { kind: 'not_sent' };
    }
    return { kind: 'unknown', reason: signal.aborted ? 'timeout' : 'network' };
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // The status still tells most of the story; a 2xx without a readable body is judged by the caller.
  }
  return {
    kind: 'response',
    status: response.status,
    json,
    retryAfter: response.headers.get('retry-after'),
  };
}

function field(json: unknown, name: string): unknown {
  return typeof json === 'object' && json !== null
    ? (json as Record<string, unknown>)[name]
    : undefined;
}

export interface Msg91Reading {
  success: boolean;
  requestId?: unknown;
}

export interface Msg91Group {
  items: BatchItem[];
  buildBody: (items: BatchItem[]) => unknown;
}

export interface Msg91BatchSpec {
  url: string;
  authKey: string;
  maxBatch: number;
  concurrency: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  now?: () => number;
  readSuccess: (json: unknown) => Msg91Reading;
}

function outcomes(
  items: BatchItem[],
  rest: Omit<DeliveryOutcome, 'profileId'>
): DeliveryOutcome[] {
  return items.map((item) => ({ profileId: item.profileId, ...rest }));
}

function requestIdOf(reading: Msg91Reading): { providerRef?: string } {
  const id = reading.requestId;
  return typeof id === 'string' && REQUEST_ID.test(id)
    ? { providerRef: id }
    : {};
}

// A code that echoes a phone number or the key is not a code.
function failureReason(
  status: number,
  json: unknown,
  secrets: string[]
): string {
  const code = field(json, 'code');
  const usable =
    typeof code === 'string' &&
    PROVIDER_CODE.test(code) &&
    !secrets.some((secret) => code.includes(secret));
  return `msg91 ${usable ? code : status}`;
}

// What a group has shown so far: a template the provider rejects fails every recipient.
interface GroupState {
  singleRejections: number;
  succeeded: boolean;
  lastRejection: string;
}

const isStoppingOutcome = (outcome: DeliveryOutcome) =>
  outcome.outcome === 'rate_limited' || outcome.outcome === 'channel_error';

/**
 * Sends each group in chunks of `maxBatch` with at most `concurrency` requests in flight.
 * A whole-request 400/422 is bisected so only the recipients the provider rejects end failed,
 * until several single recipients were rejected and nothing in the group ever succeeded.
 * A recipient is `retry` only when the provider certainly did not accept it.
 */
export async function sendMsg91Groups(
  groups: Msg91Group[],
  spec: Msg91BatchSpec
): Promise<DeliveryOutcome[]> {
  const now = spec.now ?? Date.now;
  const timeoutMs = spec.timeoutMs ?? SEND_TIMEOUT_MS;

  async function sendChunk(
    items: BatchItem[],
    group: Msg91Group,
    state: GroupState,
    chunkEnd: number,
    isHalf: boolean
  ): Promise<DeliveryOutcome[]> {
    const breakerTripped =
      state.singleRejections >= BREAKER_SINGLE_REJECTIONS && !state.succeeded;
    if (breakerTripped && isHalf) {
      return outcomes(items, {
        outcome: 'failed',
        reason: state.lastRejection,
      });
    }
    if (spec.signal?.aborted === true || now() >= chunkEnd) {
      return outcomes(items, { outcome: 'retry', reason: 'deadline' });
    }
    let issued = false;
    try {
      const body = group.buildBody(items);
      issued = true;
      const posted = await postMsg91(
        spec.url,
        spec.authKey,
        body,
        AbortSignal.timeout(timeoutMs)
      );
      if (posted.kind === 'not_sent') {
        return outcomes(items, { outcome: 'retry', reason: 'not_sent' });
      }
      if (posted.kind === 'unknown') {
        return outcomes(items, { outcome: 'uncertain', reason: posted.reason });
      }
      const { status, json } = posted;
      if (status >= HTTP_OK_MIN && status < HTTP_REDIRECT_MIN) {
        const reading = spec.readSuccess(json);
        if (reading.success) {
          state.succeeded = true;
          return outcomes(items, { outcome: 'sent', ...requestIdOf(reading) });
        }
        return outcomes(items, {
          outcome: 'uncertain',
          reason: `msg91 ${status}`,
          ...requestIdOf(reading),
        });
      }
      if (status === HTTP_RATE_LIMITED) {
        return outcomes(items, {
          outcome: 'rate_limited',
          reason: 'msg91 429',
          retryAfterMs: retryAfterMs(posted.retryAfter),
        });
      }
      if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
        return outcomes(items, {
          outcome: 'channel_error',
          reason: 'msg91 auth',
        });
      }
      const rejected =
        status === HTTP_BAD_REQUEST || status === HTTP_UNPROCESSABLE;
      if (rejected && items.length > 1 && !breakerTripped) {
        const middle = Math.ceil(items.length / 2);
        const first = await sendChunk(
          items.slice(0, middle),
          group,
          state,
          chunkEnd,
          true
        );
        const second = items.slice(middle);
        const stop = first.find(isStoppingOutcome);
        if (stop) {
          // Never sent, so the same outcome is safe and spares a doomed request.
          const { profileId: _profileId, ...rest } = stop;
          return [...first, ...outcomes(second, rest)];
        }
        return [
          ...first,
          ...(await sendChunk(second, group, state, chunkEnd, true)),
        ];
      }
      if (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX) {
        return outcomes(items, {
          outcome: 'uncertain',
          reason: `msg91 ${status}`,
        });
      }
      const secrets = [
        spec.authKey,
        ...items.map((item) => item.to.phone ?? ''),
      ].filter(Boolean);
      const reason = failureReason(status, json, secrets);
      if (rejected) {
        if (items.length === 1) {
          state.singleRejections += 1;
        }
        state.lastRejection = reason;
      }
      return outcomes(items, { outcome: 'failed', reason });
    } catch {
      return outcomes(items, {
        outcome: issued ? 'uncertain' : 'retry',
        reason: 'exception',
      });
    }
  }

  const chunks: { items: BatchItem[]; group: Msg91Group; state: GroupState }[] =
    [];
  for (const group of groups) {
    const state: GroupState = {
      singleRejections: 0,
      succeeded: false,
      lastRejection: '',
    };
    for (let at = 0; at < group.items.length; at += spec.maxBatch) {
      chunks.push({
        items: group.items.slice(at, at + spec.maxBatch),
        group,
        state,
      });
    }
  }
  const results: DeliveryOutcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      if (chunk) {
        const chunkEnd = Math.min(
          spec.deadlineAt ?? Number.POSITIVE_INFINITY,
          now() + timeoutMs * CHUNK_BUDGET_FACTOR
        );
        results.push(
          ...(await sendChunk(
            chunk.items,
            chunk.group,
            chunk.state,
            chunkEnd,
            false
          ))
        );
      }
    }
  };
  const workers = Math.max(
    1,
    Math.min(Math.trunc(spec.concurrency) || 1, chunks.length)
  );
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
