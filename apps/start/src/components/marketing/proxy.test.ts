import { describe, expect, test } from 'vitest';
import { createMarketingProxy, type ProxyEnv } from './proxy';

const DASHBOARD = 'https://dash.example.com';
const API = 'https://api.example.com';
const MARKETING = 'http://marketing.internal:4100';
const SECRET = 'proxy-secret-value';
const PROJECT = 'proj_1';
const ORGANIZATION = 'org_1';
const USER = 'user_1';
const COOKIE = 'session=abc';
const ONE_MIB = 1024 * 1024;
const TEST_TIMEOUT_MS = 20;

interface Call {
  url: string;
  init: RequestInit;
}

function trpcResponse(data: unknown) {
  return Response.json({ result: { data: { json: data } } });
}

function hangUntilAborted(signal: AbortSignal | null | undefined) {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

function setup({
  env = {},
  role = 'admin',
  projectStatus = 200,
  hang,
}: {
  env?: Partial<ProxyEnv>;
  role?: string | null;
  projectStatus?: number;
  hang?: 'core' | 'marketing';
} = {}) {
  const calls: Call[] = [];
  let now = 0;
  const fetchMock = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const target = url.startsWith(API) ? 'core' : 'marketing';
    if (hang === target) {
      return hangUntilAborted(init.signal);
    }
    if (url.startsWith(`${API}/trpc/auth.session`)) {
      return Promise.resolve(trpcResponse({ userId: USER }));
    }
    if (url.startsWith(`${API}/trpc/project.getProjectWithClients`)) {
      return Promise.resolve(
        projectStatus === 200
          ? trpcResponse({ id: PROJECT, organizationId: ORGANIZATION })
          : new Response('{}', { status: projectStatus })
      );
    }
    if (url.startsWith(`${API}/trpc/organization.myAccess`)) {
      return Promise.resolve(trpcResponse(role === null ? null : { role }));
    }
    return Promise.resolve(
      Response.json(
        { ok: true },
        { headers: { 'x-marketing-proxy-secret': SECRET, 'set-cookie': 'x=1' } }
      )
    );
  };
  const proxy = createMarketingProxy({
    env: () => ({
      marketingUrl: MARKETING,
      proxySecret: SECRET,
      apiUrl: API,
      dashboardUrl: DASHBOARD,
      ...env,
    }),
    fetch: fetchMock as typeof fetch,
    now: () => now,
    timeouts: { coreMs: TEST_TIMEOUT_MS, marketingMs: TEST_TIMEOUT_MS },
  });
  return {
    proxy,
    calls,
    marketingCalls: () =>
      calls.filter((call) => call.url.startsWith(MARKETING)),
    coreCalls: () => calls.filter((call) => call.url.startsWith(API)),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function request(
  path: string,
  {
    method = 'GET',
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: string } = {}
) {
  const mutating = method !== 'GET';
  return new Request(`${DASHBOARD}/marketing-api/${path}`, {
    method,
    body,
    headers: {
      cookie: COOKIE,
      'x-marketing-project-id': PROJECT,
      ...(mutating
        ? {
            'x-marketing-csrf': '1',
            origin: DASHBOARD,
            'sec-fetch-site': 'same-origin',
          }
        : {}),
      ...headers,
    },
  });
}

describe('marketing proxy', () => {
  test('forwards an allowed request with its own identity headers', async () => {
    const { proxy, marketingCalls } = setup();
    const response = await proxy.handle(request('results?ruleId=abc'));
    expect(response.status).toBe(200);
    const [call] = marketingCalls();
    expect(call?.url).toBe(`${MARKETING}/marketing/results?ruleId=abc`);
    const headers = new Headers(call?.init.headers);
    expect(headers.get('x-marketing-proxy-secret')).toBe(SECRET);
    expect(headers.get('x-marketing-project-id')).toBe(PROJECT);
    expect(headers.get('x-marketing-user-id')).toBe(USER);
    expect(headers.get('cookie')).toBeNull();
  });

  test('replaces client-supplied marketing headers and never returns upstream headers', async () => {
    const { proxy, marketingCalls, coreCalls } = setup();
    const response = await proxy.handle(
      request('rules', {
        headers: {
          'x-marketing-proxy-secret': 'guess',
          'x-marketing-user-id': 'someone-else',
          'x-forwarded-for': '1.2.3.4',
        },
      })
    );
    const headers = new Headers(marketingCalls()[0]?.init.headers);
    expect(headers.get('x-marketing-proxy-secret')).toBe(SECRET);
    expect(headers.get('x-marketing-user-id')).toBe(USER);
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(response.headers.get('x-marketing-proxy-secret')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    for (const call of coreCalls()) {
      expect(
        new Headers(call.init.headers).get('x-marketing-proxy-secret')
      ).toBeNull();
    }
  });

  test('returns 404 when MARKETING_URL is unset', async () => {
    const { proxy, calls } = setup({ env: { marketingUrl: undefined } });
    expect((await proxy.handle(request('rules'))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test.each([
    'unsubscribe',
    'contacts/p1',
    'devices',
    '../config',
    'rules/%2e%2e/%2e%2e/config',
    'rules/%2e%2e',
    'reference-sets/a%2Fb',
    'reference-sets/a%5Cb',
    'rules/a/b',
    '',
  ])('does not forward %s', async (path) => {
    const { proxy, marketingCalls } = setup();
    const response = await proxy.handle(request(path));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(marketingCalls()).toHaveLength(0);
  });

  test('rejects a method the path does not allow', async () => {
    const { proxy, marketingCalls } = setup();
    const response = await proxy.handle(
      request('results', { method: 'DELETE' })
    );
    expect(response.status).toBe(405);
    expect(marketingCalls()).toHaveLength(0);
  });

  test.each([
    ['missing csrf header', { 'x-marketing-csrf': '' }],
    ['foreign origin', { origin: 'https://evil.example.com' }],
    ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
  ])('rejects a mutating request with %s', async (_label, headers) => {
    const { proxy, marketingCalls } = setup();
    const response = await proxy.handle(
      request('rules', { method: 'POST', body: '{}', headers })
    );
    expect(response.status).toBe(403);
    expect(marketingCalls()).toHaveLength(0);
  });

  test('rejects a mutating request without an Origin header', async () => {
    const { proxy, marketingCalls } = setup();
    const req = request('rules', { method: 'POST', body: '{}' });
    const headers = new Headers(req.headers);
    headers.delete('origin');
    const response = await proxy.handle(
      new Request(req.url, { method: 'POST', body: '{}', headers })
    );
    expect(response.status).toBe(403);
    expect(marketingCalls()).toHaveLength(0);
  });

  test('returns 403 when core denies the project', async () => {
    const { proxy, marketingCalls } = setup({ projectStatus: 403 });
    expect((await proxy.handle(request('rules'))).status).toBe(403);
    expect(marketingCalls()).toHaveLength(0);
  });

  test('returns 403 without a session cookie', async () => {
    const { proxy, coreCalls } = setup();
    const response = await proxy.handle(
      request('rules', { headers: { cookie: '' } })
    );
    expect(response.status).toBe(403);
    expect(coreCalls()).toHaveLength(0);
  });

  test('a member who is not an organization admin may read rules but not change them', async () => {
    const { proxy, marketingCalls } = setup({ role: 'member' });
    expect((await proxy.handle(request('rules'))).status).toBe(200);
    expect(
      (await proxy.handle(request('preview', { method: 'POST', body: '{}' })))
        .status
    ).toBe(200);
    const denied = [
      request('rules', { method: 'POST', body: '{}' }),
      request('channels/email'),
      request('api-keys', { method: 'POST', body: '{}' }),
      request('reference-sets/k', { method: 'PUT', body: '{}' }),
    ];
    for (const req of denied) {
      expect((await proxy.handle(req)).status).toBe(403);
    }
    expect(marketingCalls()).toHaveLength(2);
  });

  test('audience source: an admin may read, save and test it; a member may do none of them', async () => {
    const calls = () => [
      request('audience-source'),
      request('audience-source', { method: 'PUT', body: '{}' }),
      request('audience-source/test', { method: 'POST', body: '{}' }),
    ];
    const admin = setup({ role: 'admin' });
    for (const req of calls()) {
      expect((await admin.proxy.handle(req)).status).toBe(200);
    }
    expect(admin.marketingCalls()).toHaveLength(3);
    const member = setup({ role: 'member' });
    for (const req of calls()) {
      expect((await member.proxy.handle(req)).status).toBe(403);
    }
    expect(member.marketingCalls()).toHaveLength(0);
  });

  test('audience source: other methods and sub-paths are rejected', async () => {
    const { proxy, marketingCalls } = setup();
    const statuses = await Promise.all(
      [
        request('audience-source', { method: 'DELETE' }),
        request('audience-source/test'),
        request('audience-source/test', { method: 'PUT', body: '{}' }),
        request('audience-source/other', { method: 'POST', body: '{}' }),
      ].map(async (req) => (await proxy.handle(req)).status)
    );
    expect(statuses).toEqual([405, 405, 405, 404]);
    expect(marketingCalls()).toHaveLength(0);
  });

  test('rejects a body over 1 MiB with 413', async () => {
    const { proxy, marketingCalls } = setup();
    const response = await proxy.handle(
      request('rules', { method: 'POST', body: 'x'.repeat(ONE_MIB + 1) })
    );
    expect(response.status).toBe(413);
    expect(marketingCalls()).toHaveLength(0);
  });

  test('caches the access decision for 30 seconds', async () => {
    const { proxy, coreCalls, advance } = setup();
    await proxy.handle(request('rules'));
    const afterFirst = coreCalls().length;
    advance(29_000);
    await proxy.handle(request('rules'));
    expect(coreCalls()).toHaveLength(afterFirst);
    advance(2000);
    await proxy.handle(request('rules'));
    expect(coreCalls().length).toBeGreaterThan(afterFirst);
  });

  test('keeps the access cache bounded', async () => {
    const { proxy } = setup();
    for (let index = 0; index < 1100; index++) {
      await proxy.handle(
        request('rules', { headers: { cookie: `session=${index}` } })
      );
    }
    expect(proxy.cacheSize()).toBeLessThanOrEqual(1000);
  });

  test('rejects a malformed project id', async () => {
    const { proxy, coreCalls } = setup();
    const response = await proxy.handle(
      request('rules', { headers: { 'x-marketing-project-id': '../x' } })
    );
    expect(response.status).toBe(400);
    expect(coreCalls()).toHaveLength(0);
  });

  test.each([
    'core',
    'marketing',
  ] as const)('answers 504 when %s does not respond in time', async (hang) => {
    const { proxy } = setup({ hang });
    const response = await proxy.handle(request('rules'));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: `${hang}_timeout` });
  });

  test('asks core for the role in the organization that owns the project', async () => {
    const { proxy, coreCalls } = setup();
    await proxy.handle(
      request('rules?organizationId=org_evil', {
        headers: { 'x-marketing-organization-id': 'org_evil' },
      })
    );
    const membership = coreCalls().find((call) =>
      call.url.startsWith(`${API}/trpc/organization.myAccess`)
    );
    const input = new URL(membership?.url ?? '', API).searchParams.get('input');
    expect(JSON.parse(input ?? 'null')).toEqual({
      json: { organizationId: ORGANIZATION },
    });
  });
});
