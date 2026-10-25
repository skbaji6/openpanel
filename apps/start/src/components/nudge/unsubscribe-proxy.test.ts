import { describe, expect, test } from 'vitest';
import { createUnsubscribeProxy } from './unsubscribe-proxy';

const DASHBOARD = 'https://dash.example.com';
const NUDGE = 'http://nudge.internal:4100';
const TOKEN_QUERY = '?t=signed.token';
const TEST_TIMEOUT_MS = 20;
const SIXTY_FOUR_KIB = 64 * 1024;
const WORKER_CSP = "default-src 'none'; form-action 'self'";

interface Call {
  url: string;
  init: RequestInit;
}

function workerPage() {
  return new Response('<html>Unsubscribe</html>', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': WORKER_CSP,
      'cache-control': 'no-store',
      'set-cookie': 'tracking=1',
      'x-powered-by': 'worker',
      'access-control-allow-origin': '*',
    },
  });
}

function setup({
  nudgeUrl = NUDGE,
  respond = (_call: Call): Promise<Response> => Promise.resolve(workerPage()),
} = {}) {
  const calls: Call[] = [];
  const proxy = createUnsubscribeProxy({
    nudgeUrl: () => nudgeUrl,
    timeoutMs: TEST_TIMEOUT_MS,
    fetch: (input, init = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      return respond(call);
    },
  });
  return { proxy, calls };
}

function request(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
) {
  return new Request(`${DASHBOARD}${path}`, init);
}

describe('unsubscribe proxy', () => {
  test('forwards GET with the query string to the worker and nothing else', async () => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`, {
        headers: {
          cookie: 'session=abc',
          authorization: 'Bearer x',
          'x-nudge-proxy-secret': 'spoofed',
        },
      })
    );
    expect(response.status).toBe(200);
    const [call] = calls;
    expect(call?.url).toBe(`${NUDGE}/nudge/unsubscribe${TOKEN_QUERY}`);
    expect(call?.init.method).toBe('GET');
    expect(call?.init.body).toBeNull();
    expect(call?.init.redirect).toBe('manual');
    expect(call?.init.headers).toEqual({});
  });

  test('passes x-forwarded-for verbatim without appending', async () => {
    const { proxy, calls } = setup();
    await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`, {
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
      })
    );
    expect(calls[0]?.init.headers).toEqual({
      'x-forwarded-for': '203.0.113.9, 10.0.0.2',
    });
  });

  test('forwards a POST body and its content type', async () => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      })
    );
    expect(response.status).toBe(200);
    const [call] = calls;
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(new TextDecoder().decode(call?.init.body as ArrayBuffer)).toBe(
      'List-Unsubscribe=One-Click'
    );
  });

  test('rejects a POST body over 64 KiB without calling the worker', async () => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`, {
        method: 'POST',
        body: 'x'.repeat(SIXTY_FOUR_KIB + 1),
      })
    );
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  test('returns only the allowlisted response headers', async () => {
    const { proxy } = setup();
    const response = await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`)
    );
    expect(await response.text()).toBe('<html>Unsubscribe</html>');
    expect(response.headers.get('content-security-policy')).toBe(WORKER_CSP);
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8'
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('passes the worker status through', async () => {
    const { proxy } = setup({
      respond: () =>
        Promise.resolve(
          Response.json({ error: 'invalid_token' }, { status: 400 })
        ),
    });
    const response = await proxy.handle(request('/nudge/unsubscribe?t=bad'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });

  test.each([
    '/nudge/unsubscribe/x',
    '/nudge/unsubscribe/',
    '/nudge/rules',
    '/nudge/unsubscribe%2f..',
  ])('serves only exactly /nudge/unsubscribe, not %s', async (path) => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(request(path));
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test.each(['PUT', 'DELETE', 'PATCH'])('rejects %s', async (method) => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`, { method })
    );
    expect(response.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  test('is off (404) when NUDGE_URL is blank', async () => {
    const { proxy, calls } = setup({ nudgeUrl: '' });
    const response = await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`)
    );
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test('answers 504 when the worker does not respond in time', async () => {
    const { proxy } = setup({
      respond: ({ init }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason)
          );
        }),
    });
    const response = await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`)
    );
    expect(response.status).toBe(504);
  });

  test('answers 502 when the worker is unreachable', async () => {
    const { proxy } = setup({
      respond: () => Promise.reject(new TypeError('connect ECONNREFUSED')),
    });
    const response = await proxy.handle(
      request(`/nudge/unsubscribe${TOKEN_QUERY}`)
    );
    expect(response.status).toBe(502);
  });
});
