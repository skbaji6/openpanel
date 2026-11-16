import { describe, expect, test } from 'vitest';
import { createTrackingProxy } from './tracking-proxy';

const DASHBOARD = 'https://dash.example.com';
const MARKETING = 'http://marketing.internal:4100';
const TOKEN = 'proj_1.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_';
const WEBHOOK_PATH =
  '/marketing/webhooks/msg91/proj_1/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA';
const SIX_HUNDRED_KIB = 600 * 1024;
const TEST_TIMEOUT_MS = 20;

interface Call {
  url: string;
  init: RequestInit;
}

function setup(respond: (call: Call) => Response = () => new Response('ok')) {
  const calls: Call[] = [];
  const proxy = createTrackingProxy({
    marketingUrl: () => MARKETING,
    timeoutMs: TEST_TIMEOUT_MS,
    fetch: (input, init = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
  });
  return { proxy, calls };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${DASHBOARD}${path}`, { headers });

const post = (path: string, body: BodyInit, headers = {}) =>
  new Request(`${DASHBOARD}${path}`, { method: 'POST', body, headers });

const sentHeaders = (call: Call | undefined) =>
  (call?.init.headers ?? {}) as Record<string, string>;

describe('redirect path', () => {
  test('a 302 from upstream passes location', async () => {
    const { proxy, calls } = setup(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://example.com/a',
            'set-cookie': 'x=1',
            'cache-control': 'no-store',
          },
        })
    );
    const response = await proxy.handle(get(`/marketing/r/${TOKEN}`));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/a');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(calls[0]?.url).toBe(`${MARKETING}/marketing/r/${TOKEN}`);
    expect(calls[0]?.init.redirect).toBe('manual');
  });

  test('a 200 never passes location', async () => {
    const { proxy } = setup(
      () =>
        new Response('x', {
          status: 200,
          headers: {
            location: 'https://evil.example',
            'x-robots-tag': 'noindex',
          },
        })
    );
    const response = await proxy.handle(get(`/marketing/r/${TOKEN}`));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });

  test('credentials are never forwarded, and the query is dropped', async () => {
    const { proxy, calls } = setup();
    await proxy.handle(
      get(`/marketing/r/${TOKEN}?x=1`, {
        cookie: 'session=1',
        authorization: 'Bearer x',
      })
    );
    expect(sentHeaders(calls[0]).cookie).toBeUndefined();
    expect(sentHeaders(calls[0]).authorization).toBeUndefined();
    expect(calls[0]?.url).toBe(`${MARKETING}/marketing/r/${TOKEN}`);
  });

  test('x-forwarded-for is forwarded', async () => {
    const { proxy, calls } = setup();
    await proxy.handle(
      get(`/marketing/r/${TOKEN}`, { 'x-forwarded-for': '1.2.3.4' })
    );
    expect(sentHeaders(calls[0])['x-forwarded-for']).toBe('1.2.3.4');
  });

  test('an unknown path is 404 without calling upstream', async () => {
    const { proxy, calls } = setup();
    for (const path of [
      '/marketing/r/',
      '/marketing/r/short',
      `/marketing/r/${TOKEN}/extra`,
      `/marketing/r/${TOKEN}/`,
      '/marketing/r/a%2Fb%2E%2E%2Fcccccccccccccccccccccc',
      '/marketing/campaigns',
      '/marketing/unsubscribe',
      '/marketing/webhooks/msg91/proj_1',
      `/marketing/webhooks/msg91/proj_1/${'a'.repeat(300)}`,
    ]) {
      expect((await proxy.handle(get(path))).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  test('a POST on the redirect path is rejected without calling upstream', async () => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(post(`/marketing/r/${TOKEN}`, 'x'));
    expect([404, 405]).toContain(response.status);
    expect(calls).toHaveLength(0);
  });
});

describe('webhook path', () => {
  test('a POST is forwarded with its content type', async () => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(
      post(WEBHOOK_PATH, '[]', { 'content-type': 'application/json' })
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(`${MARKETING}${WEBHOOK_PATH}`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(sentHeaders(calls[0])['content-type']).toBe('application/json');
  });

  test('GET on the webhook path is 405 or 404', async () => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(get(WEBHOOK_PATH));
    expect([404, 405]).toContain(response.status);
    expect(calls).toHaveLength(0);
  });

  test('a 600 KiB webhook body is 413', async () => {
    const { proxy, calls } = setup();
    const response = await proxy.handle(
      post(WEBHOOK_PATH, new Uint8Array(SIX_HUNDRED_KIB))
    );
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  test('an upstream timeout is 504 and nothing is logged', async () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const proxy = createTrackingProxy({
        marketingUrl: () => MARKETING,
        timeoutMs: TEST_TIMEOUT_MS,
        fetch: () => Promise.reject(new DOMException('t', 'TimeoutError')),
      });
      expect((await proxy.handle(post(WEBHOOK_PATH, '[]'))).status).toBe(504);
    } finally {
      console.error = original;
    }
    expect(logged).toEqual([]);
  });
});
