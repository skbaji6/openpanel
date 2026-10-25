import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Recipient, RenderedMessage, SendOptions } from './types';
import { createWebhookAdapter } from './webhook';

const SECRET = 'whsec-first-0123456789';
const ROTATED_SECRET = 'whsec-second-0123456789';
const HANG_MS = 5000;

interface Received {
  headers: Headers;
  body: string;
}

let received: Received[] = [];
let status = 200;
let hang = false;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    received.push({ headers: request.headers, body: await request.text() });
    if (hang) {
      await Bun.sleep(HANG_MS);
    }
    if (status >= 300 && status < 400) {
      return new Response(null, {
        status,
        headers: { location: 'http://127.0.0.1:1/elsewhere' },
      });
    }
    return new Response('secret-bearing body', { status });
  },
});

const LOCAL_URL = `http://127.0.0.1:${server.port}/hook`;

const message: RenderedMessage = {
  subject: 'Hello',
  body: 'Come back',
  meta: { projectId: 'p1', enrollmentId: 'e1', ruleId: 'r1', stepIndex: 2 },
};
const recipient: Recipient = {
  profileId: 'u1',
  deviceTokens: [],
  attributes: {},
};
const opts: SendOptions = {
  idempotencyKey: 'e1:2',
  unsubscribeUrl: 'https://nudge.test/u',
};

const allowlisted = createWebhookAdapter({ allowHosts: ['127.0.0.1'] });

function sendLocal(adapter = allowlisted) {
  return adapter.send(
    message,
    recipient,
    { url: LOCAL_URL, secrets: [SECRET, ROTATED_SECRET] },
    opts
  );
}

describe('webhook adapter', () => {
  beforeEach(() => {
    received = [];
    status = 200;
    hang = false;
  });
  afterAll(() => {
    server.stop(true);
  });

  it('signature equals HMAC of timestamp.body with the first secret', async () => {
    expect(await sendLocal()).toEqual({ ok: true });
    const [request] = received;
    const timestamp = request?.headers.get('x-nudge-timestamp') ?? '';
    expect(timestamp).toMatch(/^\d+$/);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(5);
    const expected = createHmac('sha256', SECRET)
      .update(`${timestamp}.${request?.body}`)
      .digest('hex');
    expect(request?.headers.get('x-nudge-signature')).toBe(
      `sha256=${expected}`
    );
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(request?.body ?? '')).toEqual({
      projectId: 'p1',
      profileId: 'u1',
      channel: 'webhook',
      subject: 'Hello',
      body: 'Come back',
      ruleId: 'r1',
      enrollmentId: 'e1',
      stepIndex: 2,
    });
  });

  it('sends idempotency-key header', async () => {
    await sendLocal();
    expect(received[0]?.headers.get('idempotency-key')).toBe('e1:2');
  });

  it('429 and 503 are retryable, 400 is not', async () => {
    for (const [code, retryable] of [
      [429, true],
      [503, true],
      [400, false],
    ] as const) {
      status = code;
      expect(await sendLocal()).toEqual({
        ok: false,
        retryable,
        reason: `http ${code}`,
      });
    }
  });

  it('an internal host not in the allowlist is rejected as non-retryable and an allowlisted host is called', async () => {
    const strict = createWebhookAdapter({ allowHosts: [] });
    const httpsLoopback = `https://127.0.0.1:${server.port}/hook`;
    expect(
      await strict.send(
        message,
        recipient,
        { url: httpsLoopback, secrets: [SECRET] },
        opts
      )
    ).toEqual({ ok: false, retryable: false, reason: 'blocked url' });
    expect(await sendLocal(strict)).toEqual({
      ok: false,
      retryable: false,
      reason: 'blocked url',
    });
    expect(received).toHaveLength(0);

    const caseInsensitive = createWebhookAdapter({
      allowHosts: ['LocalHost', '127.0.0.1'],
    });
    expect(await sendLocal(caseInsensitive)).toEqual({ ok: true });
    expect(received).toHaveLength(1);
  });

  it('a redirect from an allowlisted host is not followed and not retried', async () => {
    status = 302;
    expect(await sendLocal()).toEqual({
      ok: false,
      retryable: false,
      reason: 'http 302',
    });
    expect(received).toHaveLength(1);
  });

  it('a hanging target times out as a retryable failure', async () => {
    hang = true;
    const quick = createWebhookAdapter({
      allowHosts: ['127.0.0.1'],
      timeoutMs: 50,
    });
    expect(await sendLocal(quick)).toEqual({
      ok: false,
      retryable: true,
      reason: 'timeout',
    });
  });

  it('a network error is retryable', async () => {
    const result = await allowlisted.send(
      message,
      recipient,
      { url: 'http://127.0.0.1:1/hook', secrets: [SECRET] },
      opts
    );
    expect(result).toEqual({
      ok: false,
      retryable: true,
      reason: 'network error',
    });
  });

  it('config schema requires https, or http only for allowlisted hosts, and 1-2 secrets of 16+ chars', () => {
    const parse = (config: unknown) =>
      allowlisted.configSchema.safeParse(config).success;
    expect(parse({ url: LOCAL_URL, secrets: [SECRET] })).toBe(true);
    expect(parse({ url: 'https://hooks.example.com', secrets: [SECRET] })).toBe(
      true
    );
    expect(parse({ url: 'http://hooks.example.com', secrets: [SECRET] })).toBe(
      false
    );
    expect(parse({ url: 'ftp://127.0.0.1/x', secrets: [SECRET] })).toBe(false);
    expect(parse({ url: LOCAL_URL, secrets: [] })).toBe(false);
    expect(parse({ url: LOCAL_URL, secrets: ['short'] })).toBe(false);
    expect(parse({ url: LOCAL_URL, secrets: [SECRET, SECRET, SECRET] })).toBe(
      false
    );
  });
});
