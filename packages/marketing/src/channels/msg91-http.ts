import { z } from 'zod';
import type { BatchItem, DeliveryOutcome } from './batch';
import { retryAfterMs } from './retry-after';
import { SEND_TIMEOUT_MS } from './timeouts';

export const MSG91_SMS_BASE_URL = 'https://control.msg91.com';

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
// Requests carry phone numbers and the auth key, so they may only go to MSG91 itself.
const MSG91_HOST_SUFFIX = '.msg91.com';
const BASE_URL_MESSAGE =
  'must be an https origin on a msg91.com host (or an allow-listed host)';

function toOrigin(value: string, allowHosts: Set<string>): string | null {
  try {
    const url = new URL(value);
    const isMsg91 =
      url.protocol === 'https:' &&
      url.hostname.endsWith(MSG91_HOST_SUFFIX) &&
      url.hostname.length > MSG91_HOST_SUFFIX.length;
    const isAllowListed =
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      allowHosts.has(url.hostname);
    const bare =
      !(url.username || url.password || url.search || url.hash) &&
      url.pathname === '/' &&
      !value.includes('?') &&
      !value.includes('#');
    return (isMsg91 || isAllowListed) && bare ? url.origin : null;
  } catch {
    return null;
  }
}

// Stored as an origin, so appending a path can never produce a double slash.
export function msg91BaseUrl(allowHosts: readonly string[] = []) {
  const hosts = new Set(allowHosts.map((host) => host.toLowerCase()));
  return z
    .string()
    .max(200)
    .transform((value, ctx) => {
      const origin = toOrigin(value, hosts);
      if (origin === null) {
        ctx.addIssue({ code: 'custom', message: BASE_URL_MESSAGE });
        return z.NEVER;
      }
      return origin;
    });
}

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
  // A 2xx that judges recipients one by one; takes precedence over `success`.
  perItem?: (item: BatchItem) => Omit<DeliveryOutcome, 'profileId'>;
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

// Stored with the recipient row, so an id that echoes a phone number or the key is dropped.
function requestIdOf(
  reading: Msg91Reading,
  secrets: string[]
): { providerRef?: string } {
  const id = reading.requestId;
  const usable =
    typeof id === 'string' &&
    REQUEST_ID.test(id) &&
    !secrets.some((secret) => id.includes(secret));
  return usable ? { providerRef: id } : {};
}

export const digitsOf = (phone: string) => phone.replace(/\D/g, '');

// A provider may echo a phone in either form, so both count as secrets.
export const phoneSecrets = (phone: string | undefined): string[] =>
  phone ? [phone, digitsOf(phone)].filter(Boolean) : [];

// A code that echoes a phone number, the integrated number or the key is not a code.
export function providerReason(
  code: unknown,
  secrets: string[],
  fallback: string | number
): string {
  const usable =
    typeof code === 'string' &&
    PROVIDER_CODE.test(code) &&
    !secrets.some((secret) => code.includes(secret));
  return `msg91 ${usable ? code : fallback}`;
}

function failureReason(
  status: number,
  json: unknown,
  secrets: string[]
): string {
  return providerReason(field(json, 'code'), secrets, status);
}

// What a group has shown so far: a template the provider rejects fails every recipient.
interface GroupState {
  singleRejections: number;
  succeeded: boolean;
}

const breakerTripped = (state: GroupState) =>
  state.singleRejections >= BREAKER_SINGLE_REJECTIONS && !state.succeeded;

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

  // Suspicion alone never fails unsent items: one probe from the end of the chunk (bad numbers cluster at the front) decides.
  async function probeThenSettle(
    items: BatchItem[],
    group: Msg91Group,
    state: GroupState,
    chunkEnd: number
  ): Promise<DeliveryOutcome[]> {
    const probeItem = items.at(-1);
    if (!probeItem) {
      return [];
    }
    const rest = items.slice(0, -1);
    const probe = await sendChunk(
      [probeItem],
      group,
      state,
      chunkEnd,
      true,
      true
    );
    if (rest.length === 0) {
      return probe;
    }
    if (state.succeeded) {
      return [
        ...probe,
        ...(await sendChunk(rest, group, state, chunkEnd, false)),
      ];
    }
    const [first] = probe;
    if (first && (first.outcome === 'failed' || isStoppingOutcome(first))) {
      const { profileId: _profileId, ...verdict } = first;
      return [...probe, ...outcomes(rest, verdict)];
    }
    return [
      ...probe,
      ...outcomes(rest, {
        outcome: 'retry',
        reason: first?.reason === 'deadline' ? 'deadline' : 'breaker',
      }),
    ];
  }

  async function sendChunk(
    items: BatchItem[],
    group: Msg91Group,
    state: GroupState,
    chunkEnd: number,
    isHalf: boolean,
    isProbe = false
  ): Promise<DeliveryOutcome[]> {
    if (!isProbe && isHalf && breakerTripped(state)) {
      return probeThenSettle(items, group, state, chunkEnd);
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
      const secrets = [
        spec.authKey,
        ...items.flatMap((item) => phoneSecrets(item.to.phone)),
      ].filter(Boolean);
      if (status >= HTTP_OK_MIN && status < HTTP_REDIRECT_MIN) {
        const reading = spec.readSuccess(json);
        // Any 2xx shows the provider takes the template, so it disarms the breaker.
        state.succeeded = true;
        if (reading.perItem) {
          const { perItem } = reading;
          const settled = items.map((item) => ({
            profileId: item.profileId,
            ...perItem(item),
            ...requestIdOf(reading, secrets),
          }));
          return settled;
        }
        if (reading.success) {
          return outcomes(items, {
            outcome: 'sent',
            ...requestIdOf(reading, secrets),
          });
        }
        return outcomes(items, {
          outcome: 'uncertain',
          reason: `msg91 ${status}`,
          ...requestIdOf(reading, secrets),
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
        // Read after the await: a success may have landed while this request was in flight.
        if (breakerTripped(state)) {
          return probeThenSettle(items, group, state, chunkEnd);
        }
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
      const reason = failureReason(status, json, secrets);
      if (rejected && items.length === 1) {
        state.singleRejections += 1;
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
