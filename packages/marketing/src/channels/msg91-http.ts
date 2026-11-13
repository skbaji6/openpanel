import { z } from 'zod';
import { retryAfterMs } from '../campaign/pacing';
import type { BatchItem, DeliveryOutcome } from './batch';
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
const PROVIDER_CODE = /^[A-Za-z0-9_]{1,32}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
// Errors Bun's fetch raises before a single byte of the request could have left; anything else may have been delivered.
const NOT_SENT_ERROR_CODES = new Set([
  'ConnectionRefused',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export const zMsg91BaseUrl = z
  .string()
  .max(200)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        const secure =
          url.protocol === 'https:' ||
          (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
        return (
          secure &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    },
    { message: 'must be an https origin (http only for localhost)' }
  );

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

export interface Msg91BatchSpec {
  url: string;
  authKey: string;
  maxBatch: number;
  concurrency: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
  now?: () => number;
  buildBody: (items: BatchItem[]) => unknown;
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

/**
 * Sends each group in chunks of `maxBatch` with at most `concurrency` requests in flight.
 * A whole-request 400/422 is bisected so only the recipients the provider rejects end failed.
 * A recipient is `retry` only when the provider certainly did not accept it.
 */
export async function sendMsg91Groups(
  groups: BatchItem[][],
  spec: Msg91BatchSpec
): Promise<DeliveryOutcome[]> {
  const now = spec.now ?? Date.now;
  const timeoutMs = spec.timeoutMs ?? SEND_TIMEOUT_MS;
  const mustStop = () =>
    spec.signal?.aborted === true ||
    (spec.deadlineAt !== undefined && now() >= spec.deadlineAt);

  async function sendChunk(items: BatchItem[]): Promise<DeliveryOutcome[]> {
    if (mustStop()) {
      return outcomes(items, { outcome: 'retry', reason: 'deadline' });
    }
    const posted = await postMsg91(
      spec.url,
      spec.authKey,
      spec.buildBody(items),
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
    if (rejected && items.length > 1) {
      const middle = Math.ceil(items.length / 2);
      const first = await sendChunk(items.slice(0, middle));
      const second = await sendChunk(items.slice(middle));
      return [...first, ...second];
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
    return outcomes(items, {
      outcome: 'failed',
      reason: failureReason(status, json, secrets),
    });
  }

  const chunks: BatchItem[][] = [];
  for (const group of groups) {
    for (let at = 0; at < group.length; at += spec.maxBatch) {
      chunks.push(group.slice(at, at + spec.maxBatch));
    }
  }
  const results: DeliveryOutcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      if (chunk) {
        results.push(...(await sendChunk(chunk)));
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
