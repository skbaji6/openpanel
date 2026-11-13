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
  startFakeMsg91,
  WHATSAPP_PATH,
} from './fakes/msg91-server';
import {
  createMsg91WhatsAppAdapter,
  zMsg91WhatsAppConfig,
} from './msg91-whatsapp';

const AUTH_KEY = 'msg91-auth-key-0123456789';
const INTEGRATED = '918700000001';
const OTHER_INTEGRATED = '918700000002';
const NAMESPACE = 'deb1b607_3dd6_482e_a211';
const CONCURRENCY = 2;
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
  fake.script(WHATSAPP_PATH, () => ({
    status: 200,
    body: { status: 'success', hasError: false, request_id: 'req-0123456789' },
  }));
});

const config = () => ({
  authKey: AUTH_KEY,
  integratedNumber: INTEGRATED,
  baseUrl: fake.baseUrl,
});
const phoneOf = (n: number) => `9198${String(n).padStart(8, '0')}`;

function item(
  n: number,
  over: {
    phone?: string | null;
    templateName?: string;
    integratedNumber?: string;
    variables?: { slot: string; value: string }[];
  } = {}
): BatchItem {
  const message: ProviderMessage = {
    kind: 'provider',
    version: {
      templateId: 't1',
      version: 1,
      displayName: 'x',
      category: 'promotional',
      providerRef: {
        templateName: over.templateName ?? 'welcome_offer',
        namespace: NAMESPACE,
        language: 'en',
        ...(over.integratedNumber
          ? { integratedNumber: over.integratedNumber }
          : {}),
      },
      approvedText: 'x',
      variables: [],
      createdBy: 'u',
      createdAt: '2026-01-01T00:00:00Z',
    },
    variables: over.variables ?? [
      { slot: 'header_1', value: `Head${n}` },
      { slot: 'body_1', value: `Name${n}` },
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
  adapterOpts: Parameters<typeof createMsg91WhatsAppAdapter>[0] = {},
  sendOpts: {
    concurrency?: number;
    signal?: AbortSignal;
    deadlineAt?: number;
  } = {}
) =>
  createMsg91WhatsAppAdapter(adapterOpts).sendBatch(batch, config(), {
    concurrency: CONCURRENCY,
    ...sendOpts,
  });
const count = (results: { outcome: string }[], outcome: string) =>
  results.filter((r) => r.outcome === outcome).length;

interface WaBody {
  integrated_number: string;
  content_type: string;
  payload: {
    messaging_product: string;
    type: string;
    template: {
      name: string;
      namespace: string;
      language: { code: string; policy: string };
      to_and_components: {
        to: string[];
        components: Record<string, Record<string, string>>;
      }[];
    };
  };
}

describe('msg91 whatsapp adapter', () => {
  it('the request carries name, namespace, language with policy deterministic, the integrated number and header_1/body_1 per recipient', async () => {
    const results = await run(items(2));
    expect(count(results, 'sent')).toBe(2);
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    expect(request?.path).toBe(WHATSAPP_PATH);
    expect(request?.authkey).toBe(AUTH_KEY);
    expect(request?.body).toEqual({
      integrated_number: INTEGRATED,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: 'welcome_offer',
          language: { code: 'en', policy: 'deterministic' },
          namespace: NAMESPACE,
          to_and_components: [1, 2].map((n) => ({
            to: [phoneOf(n)],
            components: {
              header_1: { type: 'text', value: `Head${n}` },
              body_1: { type: 'text', value: `Name${n}` },
            },
          })),
        },
      },
    });
  });

  it('button_1 is sent as a url button', async () => {
    await run([
      item(1, {
        variables: [
          { slot: 'body_1', value: 'Ada' },
          { slot: 'button_1', value: 'abc123' },
        ],
      }),
    ]);
    const body = fake.requests[0]?.body as WaBody;
    expect(
      body.payload.template.to_and_components[0]?.components.button_1
    ).toEqual({ type: 'text', value: 'abc123', subtype: 'url' });
  });

  it('a template integratedNumber overrides the channel one and splits the group', async () => {
    await run([item(1), item(2, { integratedNumber: OTHER_INTEGRATED })]);
    const numbers = fake.requests
      .map((r) => (r.body as WaBody).integrated_number)
      .sort();
    expect(numbers).toEqual([INTEGRATED, OTHER_INTEGRATED]);
  });

  it('groups by template name and chunks at 100', async () => {
    const batch = [
      ...items(150),
      item(151, { templateName: 'other_template' }),
    ];
    const results = await run(batch);
    expect(count(results, 'sent')).toBe(151);
    const sizes = fake.requests
      .map((r) => (r.body as WaBody).payload.template.to_and_components.length)
      .sort((a, b) => a - b);
    expect(sizes).toEqual([1, 50, 100]);
  });

  it('success marks all sent with request_id', async () => {
    const results = await run(items(3));
    expect(
      results.every(
        (r) => r.outcome === 'sent' && r.providerRef === 'req-0123456789'
      )
    ).toBe(true);
  });

  it('a partial response marks listed failures failed, listed successes sent and unlisted recipients uncertain', async () => {
    fake.script(WHATSAPP_PATH, () => ({
      status: 200,
      body: {
        status: 'success',
        hasError: true,
        request_id: 'req-0123456789',
        results: [
          { to: phoneOf(1), status: 'success' },
          { to: phoneOf(2), status: 'failed', error_code: 'invalid_number' },
          { to: phoneOf(3), status: 'failed', error_code: 'bad code!' },
        ],
      },
    }));
    const results = await run(items(4));
    const by = Object.fromEntries(results.map((r) => [r.profileId, r]));
    expect(by.p1).toMatchObject({
      outcome: 'sent',
      providerRef: 'req-0123456789',
    });
    expect(by.p2).toMatchObject({
      outcome: 'failed',
      reason: 'msg91 invalid_number',
      providerRef: 'req-0123456789',
    });
    expect(by.p3).toMatchObject({
      outcome: 'failed',
      reason: 'msg91 failed',
    });
    expect(by.p4).toMatchObject({
      outcome: 'uncertain',
      providerRef: 'req-0123456789',
    });
  });

  it('the fake partial response shape round-trips', async () => {
    fake.script(WHATSAPP_PATH, responses.partial([phoneOf(2)]));
    const results = await run(items(3));
    expect(count(results, 'sent')).toBe(2);
    expect(results.find((r) => r.profileId === 'p2')?.outcome).toBe('failed');
  });

  it('an error_code that is a phone number never reaches the reason', async () => {
    fake.script(WHATSAPP_PATH, () => ({
      status: 200,
      body: {
        status: 'success',
        hasError: true,
        request_id: 'req-0123456789',
        results: [
          { to: phoneOf(1), status: 'failed', error_code: phoneOf(1) },
          { to: phoneOf(2), status: 'failed', error_code: INTEGRATED },
        ],
      },
    }));
    const results = await run(items(2));
    expect(results.map((r) => r.reason)).toEqual([
      'msg91 failed',
      'msg91 failed',
    ]);
  });

  it('hasError true without results is uncertain', async () => {
    fake.script(WHATSAPP_PATH, () => ({
      status: 200,
      body: { status: 'success', hasError: true, request_id: 'req-0123456789' },
    }));
    const results = await run(items(2));
    expect(count(results, 'uncertain')).toBe(2);
    expect(results[0]?.providerRef).toBe('req-0123456789');
  });

  it('two recipients with the same phone both take that phone result', async () => {
    fake.script(WHATSAPP_PATH, responses.partial([phoneOf(1)]));
    const results = await run([item(1), item(2, { phone: phoneOf(1) })]);
    expect(count(results, 'failed')).toBe(2);
  });

  it('429 with Retry-After 7 is rate_limited 7,000 ms', async () => {
    fake.script(WHATSAPP_PATH, responses.rateLimited(RETRY_AFTER_SECONDS));
    const results = await run(items(3));
    expect(
      results.every(
        (r) =>
          r.outcome === 'rate_limited' &&
          r.retryAfterMs === RETRY_AFTER_SECONDS * MS_PER_SECOND
      )
    ).toBe(true);
  });

  it('401 is channel_error', async () => {
    fake.script(WHATSAPP_PATH, responses.authFailed());
    const results = await run(items(3));
    expect(count(results, 'channel_error')).toBe(3);
    expect(count(results, 'failed')).toBe(0);
  });

  it('a 400 caused by one bad phone fails only that phone and sends the rest once', async () => {
    const batch = items(20);
    batch[12] = item(13, { phone: BAD_PHONE });
    fake.script(WHATSAPP_PATH, responses.badRequestIfPhone(BAD_PHONE));
    const results = await run(batch);
    expect(count(results, 'sent')).toBe(19);
    expect(results.filter((r) => r.outcome === 'failed')).toHaveLength(1);
    expect([...fake.delivered.values()].every((n) => n === 1)).toBe(true);
  });

  it('a hang past the timeout is uncertain', async () => {
    fake.script(WHATSAPP_PATH, 'hang');
    const results = await run(items(3), { timeoutMs: SHORT_TIMEOUT_MS });
    expect(count(results, 'uncertain')).toBe(3);
  });

  it('a malformed 200 body is uncertain', async () => {
    fake.script(WHATSAPP_PATH, responses.malformed());
    expect(count(await run(items(2)), 'uncertain')).toBe(2);
  });

  it('an error body quoting the phone yields a code-only reason', async () => {
    fake.script(WHATSAPP_PATH, () => ({
      status: 400,
      body: { code: phoneOf(1), message: `bad ${phoneOf(1)} ${AUTH_KEY}` },
    }));
    const results = await run(items(1));
    expect(results[0]?.reason).toBe('msg91 400');
    expect(JSON.stringify(results)).not.toContain(phoneOf(1));
    expect(JSON.stringify(results)).not.toContain(AUTH_KEY);
  });

  it('an item without a phone is failed no_phone without a call', async () => {
    const results = await run([item(1, { phone: null })]);
    expect(results).toEqual([
      { profileId: 'p1', outcome: 'failed', reason: 'no_phone' },
    ]);
    expect(fake.requests).toHaveLength(0);
  });

  it('a non-provider message throws before any call', async () => {
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
    const past = await run(items(3), {}, { deadlineAt: 1000 });
    expect(
      past.every((r) => r.outcome === 'retry' && r.reason === 'deadline')
    ).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(
      count(await run(items(3), {}, { signal: controller.signal }), 'retry')
    ).toBe(3);
    expect(fake.requests).toHaveLength(0);
  });

  it('results echo phones with a plus or spaces and still match; results for unknown phones are ignored', async () => {
    fake.script(WHATSAPP_PATH, () => ({
      status: 200,
      body: {
        status: 'success',
        hasError: true,
        request_id: 'req-0123456789',
        results: [
          { to: `+${phoneOf(1)}`, status: 'success' },
          {
            to: ` ${phoneOf(2).slice(0, 2)} ${phoneOf(2).slice(2)}`,
            status: 'failed',
            error_code: 'blocked',
          },
          { to: '919999999999', status: 'failed', error_code: 'other' },
        ],
      },
    }));
    const results = await run(items(3));
    const by = Object.fromEntries(results.map((r) => [r.profileId, r]));
    expect(by.p1?.outcome).toBe('sent');
    expect(by.p2).toMatchObject({ outcome: 'failed', reason: 'msg91 blocked' });
    expect(by.p3?.outcome).toBe('uncertain');
  });

  it('a phone listed twice with conflicting statuses is uncertain; the same status twice stands', async () => {
    fake.script(WHATSAPP_PATH, () => ({
      status: 200,
      body: {
        status: 'success',
        hasError: true,
        request_id: 'req-0123456789',
        results: [
          { to: phoneOf(1), status: 'success' },
          { to: phoneOf(1), status: 'failed', error_code: 'blocked' },
          { to: phoneOf(2), status: 'success' },
          { to: phoneOf(2), status: 'success' },
        ],
      },
    }));
    const by = Object.fromEntries(
      (await run(items(2))).map((r) => [r.profileId, r])
    );
    expect(by.p1?.outcome).toBe('uncertain');
    expect(by.p2?.outcome).toBe('sent');
  });

  it('an empty results array is uncertain for everyone', async () => {
    fake.script(WHATSAPP_PATH, () => ({
      status: 200,
      body: {
        status: 'success',
        hasError: false,
        request_id: 'req-0123456789',
        results: [],
      },
    }));
    expect(count(await run(items(3)), 'uncertain')).toBe(3);
  });

  describe('breaker probe', () => {
    const bad = [1, 2, 3].map((n) => phoneOf(n));
    const hasBad = (body: unknown) =>
      bad.some((phone) => extractPhones(body).includes(phone));

    it('a probe answered 2xx but listed failed disarms the breaker and the good recipients are sent once', async () => {
      const partial = responses.partial([phoneOf(5)]);
      fake.script(WHATSAPP_PATH, (body, index) =>
        hasBad(body)
          ? { status: 400, body: { message: 'bad' } }
          : partial(body, index)
      );
      const results = await run(items(20), {}, { concurrency: 1 });
      expect(
        results
          .filter((r) => r.outcome === 'failed')
          .map((r) => r.profileId)
          .sort()
      ).toEqual(['p1', 'p2', 'p3', 'p5']);
      expect(count(results, 'sent')).toBe(16);
      expect(fake.delivered.size).toBe(16);
      expect([...fake.delivered.values()].every((n) => n === 1)).toBe(true);
    });

    it('a probe answered 5xx is uncertain, the rest are retry breaker and nothing else is sent', async () => {
      fake.script(WHATSAPP_PATH, (body, index) =>
        hasBad(body)
          ? { status: 400, body: { message: 'bad' } }
          : responses.serverError()(body, index)
      );
      const results = await run(items(20), {}, { concurrency: 1 });
      const retried = results.filter((r) => r.outcome === 'retry');
      expect(retried.length).toBeGreaterThan(0);
      expect(retried.every((r) => r.reason === 'breaker')).toBe(true);
      expect(count(results, 'failed')).toBe(3);
      expect(count(results, 'uncertain')).toBe(17 - retried.length);
      expect(fake.delivered.size).toBe(0);
    });
  });

  it('the config requires an integrated number and a valid base url', () => {
    expect(
      zMsg91WhatsAppConfig.safeParse({
        authKey: AUTH_KEY,
        integratedNumber: INTEGRATED,
      }).success
    ).toBe(true);
    expect(zMsg91WhatsAppConfig.safeParse({ authKey: AUTH_KEY }).success).toBe(
      false
    );
    expect(
      zMsg91WhatsAppConfig.safeParse({
        authKey: AUTH_KEY,
        integratedNumber: INTEGRATED,
        baseUrl: 'http://evil.example',
      }).success
    ).toBe(false);
  });
});
