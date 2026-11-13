import { afterAll, describe, expect, it } from 'bun:test';
import {
  type BatchItem,
  classifySendResult,
  type DeliveryOutcome,
  perRecipientBatch,
} from './batch';
import { createEmailAdapter } from './email';
import { createFakeFcm } from './fakes/fcm';
import { createPushAdapter } from './push';
import type { ChannelAdapter, RenderedMessage, SendResult } from './types';
import { createWebhookAdapter } from './webhook';

const SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'p',
  client_email: 'a@p.iam',
  private_key: 'k',
});
const message: RenderedMessage = {
  body: 'hi',
  meta: { projectId: 'p1', campaignId: 'c1' },
};

function item(profileId: string, deviceTokens: string[] = []): BatchItem {
  return {
    profileId,
    to: { profileId, deviceTokens, attributes: {} },
    message,
    idempotencyKey: `c1:${profileId}`,
    unsubscribeUrl: 'https://marketing.test/u',
  };
}

function stubAdapter(
  send: ChannelAdapter<unknown>['send']
): ChannelAdapter<unknown> {
  return { id: 'webhook', configSchema: {} as never, send };
}

function fail(retryable: boolean, reason: string): SendResult {
  return { ok: false, retryable, reason };
}

describe('classifySendResult', () => {
  // Each row is a SendResult the real adapters produce.
  const table: [SendResult, DeliveryOutcome['outcome']][] = [
    [{ ok: true }, 'sent'],
    [fail(false, 'no device tokens'), 'failed'],
    [fail(false, 'smtp 550'), 'failed'],
    [fail(false, 'http 404'), 'failed'],
    [fail(false, 'blocked url'), 'failed'],
    [fail(true, 'fcm messaging/quota-exceeded'), 'rate_limited'],
    [fail(false, 'fcm messaging/message-rate-exceeded'), 'rate_limited'],
    [fail(true, 'http 429'), 'rate_limited'],
    [fail(true, 'smtp 421'), 'rate_limited'],
    [fail(true, 'smtp 450'), 'rate_limited'],
    [fail(true, 'smtp 451'), 'rate_limited'],
    [fail(true, 'smtp 452'), 'rate_limited'],
    [fail(false, 'fcm app/invalid-credential'), 'channel_error'],
    [fail(false, 'smtp EAUTH'), 'channel_error'],
    [fail(false, 'http 401'), 'channel_error'],
    [fail(false, 'http 403'), 'channel_error'],
    [fail(true, 'smtp ECONNREFUSED'), 'retry'],
    [fail(true, 'network error'), 'uncertain'],
    [fail(true, 'timeout'), 'uncertain'],
    [fail(true, 'http 503'), 'uncertain'],
    [fail(true, 'smtp ECONNRESET'), 'uncertain'],
    [fail(true, 'fcm unknown'), 'uncertain'],
  ];

  it('maps each listed reason as above', () => {
    for (const [result, outcome] of table) {
      expect(classifySendResult(result).outcome).toBe(outcome);
    }
  });

  it('passes invalid tokens through', () => {
    expect(classifySendResult({ ok: true, invalidTokens: ['t'] })).toEqual({
      outcome: 'sent',
      invalidTokens: ['t'],
    });
  });
});

const SHORT_TIMEOUT_MS = 2000;
let webhookStatus = 200;
const webhookServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response('x', { status: webhookStatus }),
});
afterAll(() => {
  webhookServer.stop(true);
});

function closedPort(): number {
  const probe = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => undefined },
  });
  const { port } = probe;
  probe.stop(true);
  return port;
}

describe('classifySendResult on real adapter results', () => {
  const recipient = {
    profileId: 'u1',
    email: 'ada@example.test',
    deviceTokens: ['t'],
    attributes: {},
  };
  const sendOpts = {
    idempotencyKey: 'k',
    unsubscribeUrl: 'https://marketing.test/u',
  };

  async function emailOutcome(host: string, port: number) {
    const adapter = createEmailAdapter({ timeoutMs: SHORT_TIMEOUT_MS });
    const result = await adapter.send(
      message,
      recipient,
      { host, port, secure: false, from: 'a@b.test' },
      sendOpts
    );
    return classifySendResult(result);
  }

  it('a refused SMTP port is retry', async () => {
    expect((await emailOutcome('127.0.0.1', closedPort())).outcome).toBe(
      'retry'
    );
  });

  it('an unresolvable SMTP host is retry', async () => {
    expect((await emailOutcome('nonexistent.invalid', 25)).outcome).toBe(
      'retry'
    );
  });

  it('webhook 401, 403, 429 and 500 classify as channel_error, channel_error, rate_limited, uncertain', async () => {
    const adapter = createWebhookAdapter({ allowHosts: ['127.0.0.1'] });
    const config = {
      url: `http://127.0.0.1:${webhookServer.port}/h`,
      secrets: ['0123456789abcdef'],
    };
    const got: Record<number, string> = {};
    for (const status of [401, 403, 429, 500]) {
      webhookStatus = status;
      const result = await adapter.send(message, recipient, config, sendOpts);
      got[status] = classifySendResult(result).outcome;
    }
    expect(got).toEqual({
      401: 'channel_error',
      403: 'channel_error',
      429: 'rate_limited',
      500: 'uncertain',
    });
  });

  it('push quota-exceeded, message-rate-exceeded and invalid-credential', async () => {
    const got: Record<string, string> = {};
    for (const code of [
      'messaging/quota-exceeded',
      'messaging/message-rate-exceeded',
      'app/invalid-credential',
    ]) {
      const adapter = createPushAdapter({
        sendMulticast: createFakeFcm({ failCode: () => code }),
      });
      const result = await adapter.send(
        message,
        recipient,
        { serviceAccountJson: SERVICE_ACCOUNT },
        sendOpts
      );
      got[code] = classifySendResult(result).outcome;
    }
    expect(got).toEqual({
      'messaging/quota-exceeded': 'rate_limited',
      'messaging/message-rate-exceeded': 'rate_limited',
      'app/invalid-credential': 'channel_error',
    });
  });

  it('a push with one rate-limited and one possibly-delivered token is uncertain, never rate_limited', async () => {
    const fcm = createFakeFcm({
      failCode: (token) =>
        token === 'a' ? 'messaging/quota-exceeded' : 'messaging/internal-error',
    });
    const adapter = createPushAdapter({ sendMulticast: fcm });
    const result = await adapter.send(
      message,
      { ...recipient, deviceTokens: ['a', 'b'] },
      { serviceAccountJson: SERVICE_ACCOUNT },
      sendOpts
    );
    expect(classifySendResult(result).outcome).toBe('uncertain');
  });
});

describe('perRecipientBatch', () => {
  it('with concurrency 3 never has more than 3 sends in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const adapter = stubAdapter(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
      return { ok: true };
    });
    const items = Array.from({ length: 10 }, (_, i) => item(`u${i}`));
    const outcomes = await perRecipientBatch(adapter).sendBatch(
      items,
      {},
      {
        concurrency: 3,
      }
    );
    expect(peak).toBe(3);
    expect(outcomes).toHaveLength(10);
  });

  it('returns one outcome per item when one send throws', async () => {
    const adapter = stubAdapter((_msg, to) => {
      if (to.profileId === 'u1') {
        throw new Error('secret https://x.test/token');
      }
      return Promise.resolve({ ok: true });
    });
    const outcomes = await perRecipientBatch(adapter).sendBatch(
      [item('u0'), item('u1'), item('u2')],
      {},
      { concurrency: 2 }
    );
    expect(outcomes).toHaveLength(3);
    expect(outcomes.find((o) => o.profileId === 'u1')).toEqual({
      profileId: 'u1',
      outcome: 'uncertain',
      reason: 'exception',
    });
  });

  it('push with the fake FCM marks a recipient with only invalid tokens failed and returns the tokens', async () => {
    const fcm = createFakeFcm({ invalidTokens: new Set(['bad']) });
    const batch = perRecipientBatch(createPushAdapter({ sendMulticast: fcm }));
    const outcomes = await batch.sendBatch(
      [item('u1', ['bad']), item('u2', ['good'])],
      { serviceAccountJson: SERVICE_ACCOUNT },
      { concurrency: 2 }
    );
    expect(outcomes.find((o) => o.profileId === 'u1')).toEqual({
      profileId: 'u1',
      outcome: 'failed',
      reason: 'fcm messaging/registration-token-not-registered',
      invalidTokens: ['bad'],
    });
    expect(outcomes.find((o) => o.profileId === 'u2')?.outcome).toBe('sent');
    expect(fcm.delivered.get('good')).toBe(1);
  });

  it('fcm messaging/quota-exceeded is rate_limited', async () => {
    const fcm = createFakeFcm({ failCode: () => 'messaging/quota-exceeded' });
    const batch = perRecipientBatch(createPushAdapter({ sendMulticast: fcm }));
    const [outcome] = await batch.sendBatch(
      [item('u1', ['t'])],
      { serviceAccountJson: SERVICE_ACCOUNT },
      { concurrency: 1 }
    );
    expect(outcome?.outcome).toBe('rate_limited');
  });

  it('items not started before the deadline come back as retry/deadline and are never sent', async () => {
    let clock = 0;
    const sent: string[] = [];
    const adapter = stubAdapter((_msg, to) => {
      sent.push(to.profileId);
      clock += 10;
      return Promise.resolve({ ok: true });
    });
    const outcomes = await perRecipientBatch(adapter, () => clock).sendBatch(
      [item('u0'), item('u1'), item('u2')],
      {},
      { concurrency: 1, deadlineAt: 10 }
    );
    expect(outcomes).toHaveLength(3);
    const deadlined = outcomes
      .filter((o) => o.outcome === 'retry' && o.reason === 'deadline')
      .map((o) => o.profileId);
    expect(sent).toHaveLength(1);
    expect([...sent, ...deadlined].sort()).toEqual(['u0', 'u1', 'u2']);
  });

  it('an aborted signal stops new sends', async () => {
    const controller = new AbortController();
    const sent: string[] = [];
    const adapter = stubAdapter((_msg, to) => {
      sent.push(to.profileId);
      controller.abort();
      return Promise.resolve({ ok: true });
    });
    const outcomes = await perRecipientBatch(adapter).sendBatch(
      [item('u0'), item('u1')],
      {},
      { concurrency: 1, signal: controller.signal }
    );
    expect(sent).toEqual(['u0']);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['retry', 'sent']);
  });

  it.each([
    Number.NaN,
    0,
    -2,
    1.5,
  ])('concurrency %p still returns one outcome per item', async (concurrency) => {
    const adapter = stubAdapter(() => Promise.resolve({ ok: true }));
    const outcomes = await perRecipientBatch(adapter).sendBatch(
      [item('u0'), item('u1'), item('u2')],
      {},
      { concurrency }
    );
    expect(outcomes).toHaveLength(3);
  });

  it('a throwing now() loses no outcome', async () => {
    const adapter = stubAdapter(() => Promise.resolve({ ok: true }));
    const throwingNow = () => {
      throw new Error('clock');
    };
    const outcomes = await perRecipientBatch(adapter, throwingNow).sendBatch(
      [item('u0'), item('u1')],
      {},
      { concurrency: 1, deadlineAt: 1 }
    );
    expect(outcomes).toEqual([
      { profileId: 'u0', outcome: 'retry', reason: 'deadline' },
      { profileId: 'u1', outcome: 'retry', reason: 'deadline' },
    ]);
  });

  it('a provider message is a wiring bug: it throws before anything is sent', async () => {
    let sends = 0;
    const adapter = stubAdapter(() => {
      sends++;
      return Promise.resolve({ ok: true });
    });
    const providerItem = {
      ...item('u1'),
      message: {
        kind: 'provider' as const,
        version: {} as never,
        variables: [],
      },
    };
    await expect(
      perRecipientBatch(adapter).sendBatch(
        [item('u0'), providerItem],
        {},
        {
          concurrency: 2,
        }
      )
    ).rejects.toThrow();
    expect(sends).toBe(0);
  });
});
