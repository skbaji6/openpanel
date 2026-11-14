import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { BatchItem, ProviderMessage } from './batch';
import {
  extractPhones,
  type FakeMsg91,
  responses,
  SMS_PATH,
  startFakeMsg91,
} from './fakes/msg91-server';
import { MSG91_SMS_BASE_URL, sendMsg91Groups } from './msg91-http';
import {
  createMsg91SmsAdapter,
  msg91SmsConfigSchema,
  zMsg91SmsConfig,
} from './msg91-sms';
import { MSG91_WHATSAPP_BASE_URL } from './msg91-whatsapp';

const AUTH_KEY = 'msg91-auth-key-0123456789';
const CONCURRENCY = 2;
const FLOW_ID = 'flow123abc';
const SENDER = 'ACMEHQ';
const BAD_PHONE = '919800000013';
const MS_PER_SECOND = 1000;
const RETRY_AFTER_SECONDS = 7;
const SHORT_TIMEOUT_MS = 200;

let fake: FakeMsg91;
beforeAll(async () => {
  fake = await startFakeMsg91();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.requests.length = 0;
  fake.delivered.clear();
  fake.script(SMS_PATH, () => ({
    status: 200,
    body: { type: 'success', message: 'req-0123456789' },
  }));
});

const config = () => ({ authKey: AUTH_KEY, baseUrl: fake.baseUrl });
const phoneOf = (n: number) => `9198${String(n).padStart(8, '0')}`;

function item(
  n: number,
  over: { phone?: string | null; flowId?: string; senderId?: string } = {}
): BatchItem {
  const message: ProviderMessage = {
    kind: 'provider',
    version: {
      templateId: 't1',
      version: 1,
      displayName: 'x',
      category: 'promotional',
      providerRef: {
        flowId: over.flowId ?? FLOW_ID,
        senderId: over.senderId ?? SENDER,
      },
      approvedText: 'x',
      variables: [],
      createdBy: 'u',
      createdAt: '2026-01-01T00:00:00Z',
    },
    variables: [
      { slot: 'var1', value: `Name${n}` },
      { slot: 'var2', value: '10%' },
    ],
  };
  return {
    profileId: `p${n}`,
    to: {
      profileId: `p${n}`,
      phone: over.phone === null ? undefined : (over.phone ?? phoneOf(n)),
      deviceTokens: [],
      attributes: {},
    },
    message,
    idempotencyKey: `k${n}`,
    unsubscribeUrl: 'https://m.test/u',
  };
}

const items = (count: number) =>
  Array.from({ length: count }, (_, i) => item(i + 1));
const run = (
  batch: BatchItem[],
  adapterOpts: Parameters<typeof createMsg91SmsAdapter>[0] = {},
  sendOpts: {
    concurrency?: number;
    signal?: AbortSignal;
    deadlineAt?: number;
  } = {}
) =>
  createMsg91SmsAdapter(adapterOpts).sendBatch(batch, config(), {
    concurrency: CONCURRENCY,
    ...sendOpts,
  });
const count = (results: { outcome: string }[], outcome: string) =>
  results.filter((r) => r.outcome === outcome).length;

describe('msg91 sms adapter', () => {
  it('250 recipients go out as 100, 100, 50 with the flow id, sender and slot values', async () => {
    const results = await run(items(250));
    expect(count(results, 'sent')).toBe(250);
    const sizes = fake.requests
      .map((r) => (r.body as { recipients: unknown[] }).recipients.length)
      .sort((a, b) => a - b);
    expect(sizes).toEqual([50, 100, 100]);
    const first = fake.requests[0];
    expect(first?.authkey).toBe(AUTH_KEY);
    expect(first?.contentType).toContain('application/json');
    const body = first?.body as Record<string, unknown> & {
      recipients: Record<string, string>[];
    };
    expect(body).toMatchObject({
      template_id: FLOW_ID,
      short_url: '0',
      realTimeResponse: '1',
      sender: SENDER,
    });
    const sample = body.recipients.find((r) => r.var1 === 'Name1');
    expect(sample).toEqual({ mobiles: phoneOf(1), var1: 'Name1', var2: '10%' });
  });

  it('a success response marks all sent with the request id', async () => {
    const results = await run(items(3));
    expect(
      results.every(
        (r) => r.outcome === 'sent' && r.providerRef === 'req-0123456789'
      )
    ).toBe(true);
  });

  it('429 with Retry-After 7 is rate_limited 7,000 ms for every recipient', async () => {
    fake.script(SMS_PATH, responses.rateLimited(RETRY_AFTER_SECONDS));
    const results = await run(items(3));
    expect(
      results.every(
        (r) =>
          r.outcome === 'rate_limited' &&
          r.retryAfterMs === RETRY_AFTER_SECONDS * MS_PER_SECOND
      )
    ).toBe(true);
  });

  it('401 is channel_error and no recipient is failed', async () => {
    fake.script(SMS_PATH, responses.authFailed());
    const results = await run(items(3));
    expect(count(results, 'channel_error')).toBe(3);
    expect(count(results, 'failed')).toBe(0);
    expect(results[0]?.reason).toBe('msg91 auth');
  });

  it('a 400 caused by one bad phone in 100 fails only that phone and sends the other 99 once', async () => {
    const batch = items(100);
    batch[12] = item(13, { phone: BAD_PHONE });
    fake.script(SMS_PATH, responses.badRequestIfPhone(BAD_PHONE));
    const results = await run(batch);
    expect(count(results, 'sent')).toBe(99);
    const failed = results.filter((r) => r.outcome === 'failed');
    expect(failed.map((r) => r.profileId)).toEqual(['p13']);
    expect(failed[0]?.reason).toBe('msg91 400');
    expect(fake.delivered.get(BAD_PHONE)).toBeUndefined();
    expect(fake.delivered.size).toBe(99);
    expect([...fake.delivered.values()].every((n) => n === 1)).toBe(true);
  });

  it('a hang past the timeout is uncertain for the whole chunk', async () => {
    fake.script(SMS_PATH, 'hang');
    const results = await run(items(3), { timeoutMs: SHORT_TIMEOUT_MS });
    expect(count(results, 'uncertain')).toBe(3);
    expect(results[0]?.reason).toBe('timeout');
  });

  it('a reset after the request was written is uncertain', async () => {
    fake.script(SMS_PATH, 'reset');
    const results = await run(items(2));
    expect(count(results, 'uncertain')).toBe(2);
  });

  it('a refused connection is retry', async () => {
    const results = await createMsg91SmsAdapter().sendBatch(
      items(2),
      { authKey: AUTH_KEY, baseUrl: 'http://127.0.0.1:1' },
      { concurrency: 1 }
    );
    expect(count(results, 'retry')).toBe(2);
  });

  it('a 200 with type error is uncertain', async () => {
    fake.script(SMS_PATH, () => ({
      status: 200,
      body: { type: 'error', message: 'something odd' },
    }));
    const results = await run(items(2));
    expect(count(results, 'uncertain')).toBe(2);
  });

  it('a 200 with an unreadable body and a 500 are uncertain', async () => {
    fake.script(SMS_PATH, responses.malformed());
    expect(count(await run(items(2)), 'uncertain')).toBe(2);
    fake.script(SMS_PATH, responses.serverError());
    expect(count(await run(items(2)), 'uncertain')).toBe(2);
  });

  it('chunks across groups never exceed concurrency in flight, and keep-alive reuses connections', async () => {
    const slow = await startFakeMsg91({ delayMs: 60 });
    try {
      const batch = [
        ...items(300),
        ...Array.from({ length: 300 }, (_, i) =>
          item(i + 301, { flowId: 'otherflow9' })
        ),
      ];
      const results = await createMsg91SmsAdapter().sendBatch(
        batch,
        { authKey: AUTH_KEY, baseUrl: slow.baseUrl },
        { concurrency: CONCURRENCY }
      );
      expect(count(results, 'sent')).toBe(600);
      expect(slow.requests).toHaveLength(6);
      expect(slow.peakInFlight()).toBe(CONCURRENCY);
      expect(slow.connections()).toBeLessThanOrEqual(CONCURRENCY);
    } finally {
      await slow.close();
    }
  });

  it('an error body echoing the phone and the auth key yields a reason with neither', async () => {
    fake.script(SMS_PATH, () => ({
      status: 400,
      body: {
        type: 'error',
        code: phoneOf(1),
        message: `bad ${phoneOf(1)} with ${AUTH_KEY}`,
      },
    }));
    const results = await run(items(1));
    expect(results[0]?.outcome).toBe('failed');
    expect(results[0]?.reason).toBe('msg91 400');
    expect(JSON.stringify(results)).not.toContain(phoneOf(1));
    expect(JSON.stringify(results)).not.toContain(AUTH_KEY);
  });

  it('an error code echoing the digits of a phone stored with a plus and spaces yields a reason without it', async () => {
    const digits = phoneOf(1);
    const spaced = `+${digits.slice(0, 2)} ${digits.slice(2, 7)} ${digits.slice(7)}`;
    fake.script(SMS_PATH, () => ({
      status: 400,
      body: { type: 'error', code: digits },
    }));
    const results = await run([item(1, { phone: spaced })]);
    expect(results[0]?.reason).toBe('msg91 400');
  });

  it('a single recipient 422 with a clean provider code reports that code', async () => {
    fake.script(SMS_PATH, () => ({
      status: 422,
      body: { type: 'error', code: 'E_1001' },
    }));
    expect((await run(items(1)))[0]?.reason).toBe('msg91 E_1001');
  });

  it('a redirect is failed and never followed', async () => {
    fake.script(SMS_PATH, () => ({
      status: 302,
      headers: { location: `${fake.baseUrl}/elsewhere` },
      body: '',
    }));
    const results = await run(items(2));
    expect(count(results, 'failed')).toBe(2);
    expect(fake.requests).toHaveLength(1);
  });

  it('an item without a phone is failed no_phone without a call', async () => {
    const results = await run([item(1, { phone: null })]);
    expect(results).toEqual([
      { profileId: 'p1', outcome: 'failed', reason: 'no_phone' },
    ]);
    expect(fake.requests).toHaveLength(0);
  });

  it('groups items by flow id and sender before chunking', async () => {
    const results = await run([
      item(1),
      item(2, { flowId: 'otherflow9' }),
      item(3),
    ]);
    expect(count(results, 'sent')).toBe(3);
    const flows = fake.requests
      .map((r) => (r.body as { template_id: string }).template_id)
      .sort();
    expect(flows).toEqual([FLOW_ID, 'otherflow9']);
  });

  it('a non-provider message is a wiring bug and throws before any call', async () => {
    const bad: BatchItem = {
      ...item(1),
      message: {
        subject: 's',
        body: 'b',
        meta: { projectId: 'p', enrollmentId: 'e', ruleId: 'r', stepIndex: 0 },
      },
    };
    await expect(run([item(2), bad])).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  it('chunks not started after the deadline or an abort are retry deadline', async () => {
    const past = await run(items(3), {}, { deadlineAt: 1000, concurrency: 1 });
    expect(
      past.every((r) => r.outcome === 'retry' && r.reason === 'deadline')
    ).toBe(true);
    const controller = new AbortController();
    controller.abort();
    const aborted = await run(items(3), {}, { signal: controller.signal });
    expect(count(aborted, 'retry')).toBe(3);
    expect(fake.requests).toHaveLength(0);
  });

  it('the deadline passing mid-run stops bisection halves and later chunks, never the request in flight', async () => {
    let clock = 0;
    // The clock jumps past the deadline while the first (rejected) request is in flight.
    fake.script(SMS_PATH, () => {
      clock = 10;
      return { status: 400, body: { type: 'error', message: 'bad' } };
    });
    const results = await run(
      items(250),
      { now: () => clock },
      { deadlineAt: 5, concurrency: 1 }
    );
    expect(fake.requests).toHaveLength(1);
    expect(results).toHaveLength(250);
    expect(
      results.every((r) => r.outcome === 'retry' && r.reason === 'deadline')
    ).toBe(true);
  });

  it('bisection shares a chunk budget of three request timeouts', async () => {
    let clock = 0;
    fake.script(SMS_PATH, () => {
      clock = 1000;
      return { status: 400, body: { type: 'error', message: 'bad' } };
    });
    const results = await run(
      items(100),
      { now: () => clock, timeoutMs: 100 },
      { concurrency: 1 }
    );
    expect(fake.requests).toHaveLength(1);
    expect(count(results, 'retry')).toBe(100);
  });

  it('a systematically rejected template stops bisecting after a few probes', async () => {
    fake.script(SMS_PATH, () => ({
      status: 400,
      body: { type: 'error', code: 'TEMPLATE_NOT_FOUND' },
    }));
    const results = await run(items(250), {}, { concurrency: 1 });
    expect(count(results, 'failed')).toBe(250);
    expect(results.every((r) => r.reason === 'msg91 TEMPLATE_NOT_FOUND')).toBe(
      true
    );
    // Bisection to the third single rejection, one probe per pending half, then a chunk-level 400 and a probe per later chunk.
    expect(fake.requests.length).toBeLessThanOrEqual(25);
  });

  it('three bad phones at the start of the first chunk do not fail the good recipients', async () => {
    const bad = [1, 2, 3].map((n) => phoneOf(n));
    fake.script(SMS_PATH, (body) =>
      bad.some((phone) => extractPhones(body).includes(phone))
        ? { status: 400, body: { type: 'error' } }
        : { status: 200, body: { type: 'success', message: 'req-0123456789' } }
    );
    const results = await run(items(250), {}, { concurrency: 1 });
    expect(
      results
        .filter((r) => r.outcome === 'failed')
        .map((r) => r.profileId)
        .sort()
    ).toEqual(['p1', 'p2', 'p3']);
    expect(count(results, 'sent')).toBe(247);
    expect(fake.delivered.size).toBe(247);
    expect([...fake.delivered.values()].every((n) => n === 1)).toBe(true);
  });

  it('a probe that returns 429 leaves the rest rate_limited and unsent', async () => {
    const bad = [1, 2, 3].map((n) => phoneOf(n));
    fake.script(SMS_PATH, (body, index) =>
      bad.some((phone) => extractPhones(body).includes(phone))
        ? { status: 400, body: { type: 'error' } }
        : responses.rateLimited(RETRY_AFTER_SECONDS)(body, index)
    );
    const results = await run(items(250), {}, { concurrency: 1 });
    expect(
      results
        .filter((r) => r.outcome === 'failed')
        .map((r) => r.profileId)
        .sort()
    ).toEqual(['p1', 'p2', 'p3']);
    expect(count(results, 'rate_limited')).toBe(247);
    expect(fake.delivered.size).toBe(0);
  });

  it('a success in the group disarms the breaker so bad phones are still found one by one', async () => {
    const bad = [3, 40, 41, 77].map((n) => phoneOf(n));
    fake.script(SMS_PATH, (body) => {
      const phones = extractPhones(body);
      return bad.some((phone) => phones.includes(phone))
        ? { status: 400, body: { type: 'error' } }
        : {
            status: 200,
            body: { type: 'success', message: 'req-0123456789' },
          };
    });
    const results = await run(items(100), {}, { concurrency: 1 });
    expect(
      results
        .filter((r) => r.outcome === 'failed')
        .map((r) => r.profileId)
        .sort()
    ).toEqual(['p3', 'p40', 'p41', 'p77']);
    expect(count(results, 'sent')).toBe(96);
  });

  it('a probe that succeeds resets the breaker, so a later bad phone fails alone', async () => {
    const bad = [1, 2, 3, 150].map((n) => phoneOf(n));
    fake.script(SMS_PATH, (body) =>
      bad.some((phone) => extractPhones(body).includes(phone))
        ? { status: 400, body: { type: 'error' } }
        : { status: 200, body: { type: 'success', message: 'req-0123456789' } }
    );
    const results = await run(items(250), {}, { concurrency: 1 });
    expect(
      results
        .filter((r) => r.outcome === 'failed')
        .map((r) => r.profileId)
        .sort()
    ).toEqual(['p1', 'p150', 'p2', 'p3']);
    expect(results.some((r) => r.reason === 'breaker')).toBe(false);
    expect(count(results, 'sent')).toBe(246);
    expect([...fake.delivered.values()].every((n) => n === 1)).toBe(true);
  });

  it('a 429 on the first bisection half spares the sibling half', async () => {
    let calls = 0; // the responder index keeps counting across tests
    fake.script(SMS_PATH, (body, index) =>
      calls++ === 0
        ? { status: 400, body: { type: 'error' } }
        : responses.rateLimited(RETRY_AFTER_SECONDS)(body, index)
    );
    const results = await run(items(100), {}, { concurrency: 1 });
    expect(fake.requests).toHaveLength(2);
    expect(results).toHaveLength(100);
    expect(
      results.every(
        (r) => r.outcome === 'rate_limited' && r.retryAfterMs === 7000
      )
    ).toBe(true);
  });

  it('a 401 on the first bisection half spares the sibling half', async () => {
    let calls = 0; // the responder index keeps counting across tests
    fake.script(SMS_PATH, (body, index) =>
      calls++ === 0
        ? { status: 400, body: { type: 'error' } }
        : responses.authFailed()(body, index)
    );
    const results = await run(items(100), {}, { concurrency: 1 });
    expect(fake.requests).toHaveLength(2);
    expect(
      results.every(
        (r) => r.outcome === 'channel_error' && r.reason === 'msg91 auth'
      )
    ).toBe(true);
  });

  it('a throw while building one chunk keeps the other chunks and marks it retry exception', async () => {
    const batch = items(250);
    const poisoned = batch[150];
    if (poisoned?.message && 'kind' in poisoned.message) {
      Object.defineProperty(poisoned.message, 'variables', {
        get() {
          throw new Error('boom');
        },
      });
    }
    const results = await run(batch, {}, { concurrency: 2 });
    expect(results).toHaveLength(250);
    expect(count(results, 'sent')).toBe(150);
    const retried = results.filter((r) => r.outcome === 'retry');
    expect(retried).toHaveLength(100);
    expect(retried.every((r) => r.reason === 'exception')).toBe(true);
  });

  it('a throw after the request was issued is uncertain exception', async () => {
    const results = await sendMsg91Groups(
      [{ items: items(2), buildBody: () => ({}) }],
      {
        url: `${fake.baseUrl}${SMS_PATH}`,
        authKey: AUTH_KEY,
        maxBatch: 100,
        concurrency: 1,
        readSuccess: () => {
          throw new Error('boom');
        },
      }
    );
    expect(
      results.every(
        (r) => r.outcome === 'uncertain' && r.reason === 'exception'
      )
    ).toBe(true);
  });
});

describe('msg91 base url', () => {
  const msg91Host = new URL(MSG91_SMS_BASE_URL).hostname;
  const allowingFake = msg91SmsConfigSchema(['127.0.0.1']);

  it.each([
    [`${MSG91_SMS_BASE_URL}/`, MSG91_SMS_BASE_URL],
    [MSG91_SMS_BASE_URL, MSG91_SMS_BASE_URL],
    [MSG91_WHATSAPP_BASE_URL, MSG91_WHATSAPP_BASE_URL],
  ])('%s is normalised to its origin', (input, origin) => {
    const parsed = zMsg91SmsConfig.parse({ authKey: AUTH_KEY, baseUrl: input });
    expect(parsed.baseUrl).toBe(origin);
  });

  it.each([
    `${MSG91_SMS_BASE_URL}/x`,
    `${MSG91_SMS_BASE_URL}?x`,
    `${MSG91_SMS_BASE_URL}/?`,
    `https://u@${msg91Host}`,
    `http://${msg91Host}`,
    `ftp://${msg91Host}`,
    'https://evil.example',
    'http://127.0.0.1',
    'https://127.0.0.1',
    'https://[::1]',
    `https://${msg91Host}.evil.example`,
    `https://${msg91Host.split('.').slice(1).join('.')}`,
  ])('%s is rejected', (input) => {
    expect(
      zMsg91SmsConfig.safeParse({ authKey: AUTH_KEY, baseUrl: input }).success
    ).toBe(false);
  });

  it('an allow-listed host passes, over http too, and only when allow-listed', () => {
    expect(
      allowingFake.parse({
        authKey: AUTH_KEY,
        baseUrl: 'http://127.0.0.1:8080/',
      }).baseUrl
    ).toBe('http://127.0.0.1:8080');
    expect(
      zMsg91SmsConfig.safeParse({
        authKey: AUTH_KEY,
        baseUrl: 'http://127.0.0.1:8080',
      }).success
    ).toBe(false);
    expect(
      allowingFake.safeParse({
        authKey: AUTH_KEY,
        baseUrl: 'https://evil.example',
      }).success
    ).toBe(false);
  });

  it('the adapter checks the base url with the allow list it was built with', () => {
    const config = { authKey: AUTH_KEY, baseUrl: fake.baseUrl };
    expect(createMsg91SmsAdapter().configSchema.safeParse(config).success).toBe(
      false
    );
    expect(
      createMsg91SmsAdapter({
        allowHosts: ['127.0.0.1'],
      }).configSchema.safeParse(config).success
    ).toBe(true);
  });
});
