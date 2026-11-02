import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  appFor,
  createPushAdapter,
  MAX_FIREBASE_APPS,
  type MulticastSender,
} from './push';
import type { Recipient, RenderedMessage, SendOptions } from './types';

const HANG_MS = 5000;
const BATCH_DELAY_MS = 60;
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
  unsubscribeUrl: 'https://marketing.test/u',
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

function tokens(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${i}`);
}

// Answers each batch by its position: a delay, then all-success, a per-token mapping, or a throw.
function scriptedSender(
  script: Array<'ok' | 'throw' | Record<number, string>>,
  delayMs = 0
) {
  const calls: string[][] = [];
  const sender: MulticastSender = async (_json, multicast) => {
    const step = script[calls.length] ?? 'ok';
    calls.push(multicast.tokens);
    await Bun.sleep(delayMs);
    if (step === 'throw') {
      throw Object.assign(new Error('boom'), { code: 'app/network-error' });
    }
    return {
      responses: multicast.tokens.map((_token, index) => {
        const code = step === 'ok' ? undefined : step[index];
        return code === undefined
          ? { success: true }
          : { success: false, error: { code } };
      }),
    };
  };
  return { sender, calls };
}

const NOT_REGISTERED = 'messaging/registration-token-not-registered';

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

  it('after a timeout no further batch is sent', async () => {
    const { sender, calls } = scriptedSender([], BATCH_DELAY_MS);
    const adapter = createPushAdapter({ sendMulticast: sender, timeoutMs: 50 });
    expect(
      await adapter.send(message, recipient(tokens(1500)), config, opts)
    ).toEqual({ ok: false, retryable: true, reason: 'timeout' });
    await Bun.sleep(BATCH_DELAY_MS * 3);
    expect(calls).toHaveLength(1);
  });

  it('a timeout after a delivered batch reports success, so the delivered tokens are not pushed again', async () => {
    const { sender, calls } = scriptedSender(
      [{ 0: NOT_REGISTERED }],
      BATCH_DELAY_MS
    );
    const adapter = createPushAdapter({
      sendMulticast: sender,
      timeoutMs: BATCH_DELAY_MS * 1.5,
    });
    expect(
      await adapter.send(message, recipient(tokens(1500)), config, opts)
    ).toEqual({ ok: true, invalidTokens: ['t0'] });
    await Bun.sleep(BATCH_DELAY_MS * 3);
    expect(calls).toHaveLength(2);
  });

  it('a later batch throwing after an earlier one delivered is still a success with the invalid tokens so far', async () => {
    const { sender } = scriptedSender([{ 1: NOT_REGISTERED }, 'throw']);
    const adapter = createPushAdapter({ sendMulticast: sender });
    expect(
      await adapter.send(message, recipient(tokens(600)), config, opts)
    ).toEqual({ ok: true, invalidTokens: ['t1'] });
  });

  it('the first batch throwing with nothing delivered is a retryable failure', async () => {
    const { sender, calls } = scriptedSender(['throw']);
    const adapter = createPushAdapter({ sendMulticast: sender });
    expect(
      await adapter.send(message, recipient(tokens(600)), config, opts)
    ).toEqual({ ok: false, retryable: true, reason: 'fcm app/network-error' });
    expect(calls).toHaveLength(1);
  });

  it('per-token results are combined across batches', async () => {
    const allInvalid = Object.fromEntries(
      Array.from({ length: FCM_BATCH_LIMIT }, (_, i) => [i, NOT_REGISTERED])
    );
    const { sender } = scriptedSender([
      allInvalid,
      { 0: 'messaging/server-unavailable' },
    ]);
    const adapter = createPushAdapter({ sendMulticast: sender });
    const result = await adapter.send(
      message,
      recipient(tokens(502)),
      config,
      opts
    );
    expect(result.ok).toBe(true);
    expect(result.invalidTokens).toEqual(tokens(FCM_BATCH_LIMIT));
  });

  it('failures without an error code are retryable', async () => {
    const adapter = createPushAdapter({
      sendMulticast: async (_json, multicast) => ({
        responses: multicast.tokens.map(() => ({ success: false })),
      }),
    });
    expect(await adapter.send(message, recipient(['a']), config, opts)).toEqual(
      { ok: false, retryable: true, reason: 'fcm unknown' }
    );
    const throwing = createPushAdapter({
      sendMulticast: () => Promise.reject(new Error('no code')),
    });
    expect(
      await throwing.send(message, recipient(['a']), config, opts)
    ).toEqual({ ok: false, retryable: true, reason: 'fcm unknown' });
  });

  it(`keeps at most ${MAX_FIREBASE_APPS} firebase apps and deletes the evicted ones`, async () => {
    const { getApps } = await import('firebase-admin/app');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const accounts = Array.from({ length: MAX_FIREBASE_APPS + 2 }, (_, i) =>
      JSON.stringify({
        project_id: `demo-${i}`,
        client_email: `svc@demo-${i}.iam.gserviceaccount.com`,
        private_key: pem,
      })
    );
    // Names are read up front: a deleted app throws on property access.
    const names: string[] = [];
    let last = await appFor(accounts[0] ?? '');
    for (const account of accounts) {
      last = await appFor(account);
      names.push(last.name);
    }
    expect(await appFor(accounts.at(-1) ?? '')).toBe(last);
    await Bun.sleep(50);
    const live = getApps().map((app) => app.name);
    expect(live).toHaveLength(MAX_FIREBASE_APPS);
    expect(live).not.toContain(names[0]);
    expect(live).not.toContain(names[1]);
    expect(live).toContain(names.at(-1) ?? '');
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
