import { describe, expect, it } from 'bun:test';
import { createPushAdapter, type MulticastSender } from './push';
import type { Recipient, RenderedMessage, SendOptions } from './types';

const HANG_MS = 5000;
const FCM_BATCH_LIMIT = 500;
const SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'demo',
  client_email: 'svc@demo.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
});

const message: RenderedMessage = {
  title: 'Still thinking?',
  body: 'Your cart is waiting',
  meta: { projectId: 'p1', enrollmentId: 'e1', ruleId: 'r1', stepIndex: 0 },
};
const opts: SendOptions = {
  idempotencyKey: 'e1:0',
  unsubscribeUrl: 'https://nudge.test/u',
};

function recipient(deviceTokens: string[]): Recipient {
  return { profileId: 'u1', deviceTokens, attributes: {} };
}

type Outcome = { success: true } | { success: false; code: string };

// Answers each token with the outcome mapped for it (success by default) and records every call.
function fakeSender(outcomes: Record<string, Outcome> = {}) {
  const calls: Parameters<MulticastSender>[] = [];
  const sender: MulticastSender = async (serviceAccountJson, multicast) => {
    calls.push([serviceAccountJson, multicast]);
    return {
      responses: multicast.tokens.map((token) => {
        const outcome = outcomes[token] ?? { success: true };
        return outcome.success
          ? { success: true }
          : { success: false, error: { code: outcome.code } };
      }),
    };
  };
  return { sender, calls };
}

const config = { serviceAccountJson: SERVICE_ACCOUNT };

describe('push adapter', () => {
  it('invalid tokens are reported in invalidTokens', async () => {
    const { sender, calls } = fakeSender({
      gone: {
        success: false,
        code: 'messaging/registration-token-not-registered',
      },
      bad: { success: false, code: 'messaging/invalid-registration-token' },
    });
    const adapter = createPushAdapter({ sendMulticast: sender });
    const result = await adapter.send(
      message,
      recipient(['ok', 'gone', 'bad']),
      config,
      opts
    );
    expect(result).toEqual({ ok: true, invalidTokens: ['gone', 'bad'] });
    expect(calls[0]?.[0]).toBe(SERVICE_ACCOUNT);
    expect(calls[0]?.[1]).toEqual({
      tokens: ['ok', 'gone', 'bad'],
      notification: { title: 'Still thinking?', body: 'Your cart is waiting' },
    });
  });

  it('empty deviceTokens returns non-retryable failure', async () => {
    const { sender, calls } = fakeSender();
    const adapter = createPushAdapter({ sendMulticast: sender });
    expect(await adapter.send(message, recipient([]), config, opts)).toEqual({
      ok: false,
      retryable: false,
      reason: 'no device tokens',
    });
    expect(calls).toHaveLength(0);
  });

  it('splits more than 500 tokens into batches of at most 500', async () => {
    const { sender, calls } = fakeSender();
    const adapter = createPushAdapter({ sendMulticast: sender });
    const tokens = Array.from({ length: 1201 }, (_, i) => `t${i}`);
    expect(
      await adapter.send(message, recipient(tokens), config, opts)
    ).toEqual({ ok: true });
    expect(calls.map(([, m]) => m.tokens.length)).toEqual([
      FCM_BATCH_LIMIT,
      FCM_BATCH_LIMIT,
      201,
    ]);
  });

  it('all tokens failing transiently is retryable', async () => {
    const { sender } = fakeSender({
      a: { success: false, code: 'messaging/server-unavailable' },
      b: { success: false, code: 'messaging/internal-error' },
    });
    const adapter = createPushAdapter({ sendMulticast: sender });
    expect(
      await adapter.send(message, recipient(['a', 'b']), config, opts)
    ).toEqual({
      ok: false,
      retryable: true,
      reason: 'fcm messaging/server-unavailable',
    });
  });

  it('all tokens failing with a permanent error is not retryable and still reports invalid tokens', async () => {
    const { sender } = fakeSender({
      a: { success: false, code: 'messaging/server-unavailable' },
      b: {
        success: false,
        code: 'messaging/registration-token-not-registered',
      },
    });
    const adapter = createPushAdapter({ sendMulticast: sender });
    expect(
      await adapter.send(message, recipient(['a', 'b']), config, opts)
    ).toEqual({
      ok: false,
      retryable: false,
      reason: 'fcm messaging/server-unavailable',
      invalidTokens: ['b'],
    });
  });

  it('a thrown SDK error is classified by its code and never leaks its message', async () => {
    const adapter = createPushAdapter({
      sendMulticast: () =>
        Promise.reject(
          Object.assign(new Error(`bad key ${SERVICE_ACCOUNT}`), {
            code: 'app/invalid-credential',
          })
        ),
    });
    expect(await adapter.send(message, recipient(['a']), config, opts)).toEqual(
      { ok: false, retryable: false, reason: 'fcm app/invalid-credential' }
    );
  });

  it('the real firebase-admin path rejects a malformed key before any network call, without leaking it', async () => {
    const result = await createPushAdapter().send(
      message,
      recipient(['a']),
      config,
      opts
    );
    expect(result).toEqual({
      ok: false,
      retryable: false,
      reason: 'fcm app/invalid-credential',
    });
  });

  it('a hanging FCM call times out as a retryable failure', async () => {
    const adapter = createPushAdapter({
      timeoutMs: 50,
      sendMulticast: async () => {
        await Bun.sleep(HANG_MS);
        return { responses: [] };
      },
    });
    expect(await adapter.send(message, recipient(['a']), config, opts)).toEqual(
      { ok: false, retryable: true, reason: 'timeout' }
    );
  });

  it('config schema requires a service account JSON with project_id, client_email and private_key', () => {
    const parse = (serviceAccountJson: string) =>
      createPushAdapter().configSchema.safeParse({ serviceAccountJson })
        .success;
    expect(parse(SERVICE_ACCOUNT)).toBe(true);
    expect(parse('not json')).toBe(false);
    expect(parse(JSON.stringify({ project_id: 'demo' }))).toBe(false);
  });
});
