import { describe, expect, it } from 'bun:test';
import { createBreaker } from './breaker';
import {
  SourceAuthError,
  SourceProtocolError,
  SourceUnavailableError,
} from './errors';
import { createHttpSource, MAX_BODY_BYTES } from './http-source';
import type { createSourceLimiter } from './limiter';

type Limiter = ReturnType<typeof createSourceLimiter>;
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function setup(handler: FetchFn, extra: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  const slots = { active: 0, acquired: 0, activeDuringSleep: [] as number[] };
  const limiter = {
    acquire: async () => {
      slots.active += 1;
      slots.acquired += 1;
      return async () => {
        slots.active -= 1;
      };
    },
  } as unknown as Limiter;
  const source = createHttpSource({
    baseUrl: 'https://x.test/internal/audience',
    keyId: 'k1',
    secret: 'topsecret',
    limiter,
    breaker: createBreaker({ failureThreshold: 100, openMs: 1000 }),
    fetch: handler as unknown as typeof fetch,
    now: () => 1_700_000_000_000,
    sleep: async (ms) => {
      sleeps.push(ms);
      slots.activeDuringSleep.push(slots.active);
    },
    random: () => 1,
    ...extra,
  });
  return { source, sleeps, slots };
}

const entry = (id: string) => ({ id, status: 'ok' as const });

describe('http audience source', () => {
  it('signs every call', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const { source } = setup(async (url, init) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return json({ dimensions: [] });
    });
    await source.schema();
    const h = seen[0]?.headers ?? {};
    expect(seen[0]?.url).toBe('https://x.test/internal/audience/schema');
    expect(h.Authorization).toBe('Bearer k1.topsecret');
    expect(h['X-Timestamp']).toBe('1700000000');
    expect(h['X-Nonce']?.length).toBeGreaterThan(0);
    expect(h['X-Signature']?.length).toBe(64);
  });

  it('lookup returns one entry per requested id, synthesising not_found for ids the API omitted', async () => {
    const { source } = setup(async () => json({ entries: [entry('b')] }));
    const out = await source.lookup(['a', 'b', 'c'], 'email');
    expect(out).toEqual([
      { id: 'a', status: 'not_found' },
      entry('b'),
      { id: 'c', status: 'not_found' },
    ]);
  });

  it('lookup ignores ids that were not requested and duplicate entries', async () => {
    const { source } = setup(async () =>
      json({
        entries: [
          { id: 'zzz', status: 'ok' },
          { id: 'a', status: 'ok', email: 'first' },
          { id: 'a', status: 'suppressed' },
        ],
      })
    );
    const out = await source.lookup(['a'], 'email');
    expect(out).toEqual([{ id: 'a', status: 'ok', email: 'first' }]);
  });

  it('retries a 503 then succeeds', async () => {
    let calls = 0;
    const { source, sleeps } = setup(async () => {
      calls += 1;
      return calls === 1
        ? new Response('x', { status: 503 })
        : json({ dimensions: [] });
    });
    await source.schema();
    expect(calls).toBe(2);
    expect(sleeps).toEqual([200]);
  });

  it('honours Retry-After on a 429 using the injected sleep', async () => {
    let calls = 0;
    const { source, sleeps } = setup(async () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '7' } })
        : json({ dimensions: [] });
    });
    await source.schema();
    expect(sleeps).toEqual([7000]);
  });

  it('does not retry a 401 and throws SourceAuthError', async () => {
    let calls = 0;
    const { source } = setup(async () => {
      calls += 1;
      return new Response('', { status: 401 });
    });
    await expect(source.schema()).rejects.toBeInstanceOf(SourceAuthError);
    expect(calls).toBe(1);
  });

  it('a 200 with an HTML body is a SourceProtocolError', async () => {
    const { source } = setup(async () => new Response('<html></html>'));
    await expect(source.schema()).rejects.toBeInstanceOf(SourceProtocolError);
  });

  it('an 8 MiB plus body is a SourceProtocolError', async () => {
    const { source } = setup(
      async () => new Response('a'.repeat(MAX_BODY_BYTES + 1))
    );
    await expect(source.schema()).rejects.toBeInstanceOf(SourceProtocolError);
  });

  it('count times out after 5 seconds with a fake clock', async () => {
    let fire: (() => void) | undefined;
    let timeoutMs = 0;
    let calls = 0;
    const { source } = setup(
      (_url, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
          if (calls === 1) {
            queueMicrotask(() => fire?.());
          }
        });
      },
      {
        setTimer: (fn: () => void, ms: number) => {
          fire = fn;
          timeoutMs = ms;
          return () => undefined;
        },
      }
    );
    // Every attempt hangs, then its timer fires: three attempts, then unavailable.
    const pending = source.count({
      dimension: 'state',
      op: 'eq',
      values: ['x'],
    });
    const settled = pending.then(
      () => null,
      (e: unknown) => e
    );
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
      fire?.();
    }
    expect(await settled).toBeInstanceOf(SourceUnavailableError);
    expect(timeoutMs).toBe(5000);
  });

  it('lookup with 501 ids is split into two requests', async () => {
    const sizes: number[] = [];
    const { source } = setup(async (_url, init) => {
      sizes.push(JSON.parse(init.body as string).ids.length);
      return json({ entries: [] });
    });
    const ids = Array.from({ length: 501 }, (_, i) => `id${i}`);
    const out = await source.lookup(ids, 'push');
    expect(sizes).toEqual([500, 1]);
    expect(out).toHaveLength(501);
  });

  it('an error message never contains the response body', async () => {
    const { source } = setup(
      async () => new Response('SECRET-BODY student@x.com', { status: 400 })
    );
    const error = await source.schema().catch((e: Error) => e);
    expect(error).toBeInstanceOf(SourceProtocolError);
    expect((error as Error).message).toBe('/schema: 400');
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('holds a limiter slot only during the call', async () => {
    let calls = 0;
    const { source, slots } = setup(async () => {
      calls += 1;
      return calls < 3
        ? new Response('', { status: 500 })
        : json({ dimensions: [] });
    });
    await source.schema();
    expect(slots.acquired).toBe(3);
    expect(slots.active).toBe(0);
    expect(slots.activeDuringSleep).toEqual([0, 0]);
  });

  it('wraps network errors as SourceUnavailableError after 3 attempts', async () => {
    let calls = 0;
    const { source } = setup(async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    });
    await expect(source.schema()).rejects.toBeInstanceOf(
      SourceUnavailableError
    );
    expect(calls).toBe(3);
  });

  it('signs path plus query for dimension values', async () => {
    let url = '';
    const { source } = setup(async (u) => {
      url = u;
      return json([{ value: 'a', label: 'A' }]);
    });
    await source.dimensionValues('state', 'ka r', 5);
    expect(url).toBe(
      'https://x.test/internal/audience/dimensions/state/values?q=ka%20r&limit=5'
    );
  });
});
