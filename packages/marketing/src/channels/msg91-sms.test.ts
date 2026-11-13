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
  type FakeMsg91,
  responses,
  SMS_PATH,
  startFakeMsg91,
} from './fakes/msg91-server';
import { createMsg91SmsAdapter } from './msg91-sms';

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

  it('three chunks over keep-alive use at most concurrency connections', async () => {
    const before = fake.connections();
    await run(items(250), {}, { concurrency: 1 });
    expect(fake.connections() - before).toBeLessThanOrEqual(1);
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

  it('the deadline passing mid-run stops later chunks and bisection halves, never the one in flight', async () => {
    let clock = 0;
    // The clock jumps past the deadline once the first request went out.
    fake.script(SMS_PATH, () => {
      clock = 10;
      return {
        status: 200,
        body: { type: 'success', message: 'req-0123456789' },
      };
    });
    const results = await run(
      items(250),
      { now: () => clock },
      { deadlineAt: 5, concurrency: 1 }
    );
    expect(count(results, 'sent')).toBe(100);
    expect(count(results, 'retry')).toBe(150);
    expect(fake.requests).toHaveLength(1);
  });
});
