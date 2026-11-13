import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BatchItem, DeliveryOutcome } from './batch';
import {
  createPooledEmailAdapter,
  type EmailConfig,
  type PooledEmailAdapter,
} from './email';
import { type FakeSmtp, startFakeSmtp } from './fakes/smtp-server';
import type { RenderedMessage } from './types';

const UNSUBSCRIBE_URL = 'https://marketing.test/unsubscribe?t=abc';
const SHORT_TIMEOUT_MS = 300;
const POLL_MS = 20;
const POLL_LIMIT = 100;

let smtp: FakeSmtp;
let adapters: PooledEmailAdapter[] = [];

const config = (overrides: Partial<EmailConfig> = {}): EmailConfig => ({
  host: '127.0.0.1',
  port: smtp.port,
  secure: false,
  from: 'Shop <shop@example.test>',
  ...overrides,
});

const message = (projectId = 'p1'): RenderedMessage => ({
  subject: 'Hello',
  body: '<p>Hi</p>',
  meta: { projectId, campaignId: 'c1' },
});

const item = (n: number, projectId = 'p1'): BatchItem => ({
  profileId: `u${n}`,
  to: {
    profileId: `u${n}`,
    email: `user${n}@example.test`,
    deviceTokens: [],
    attributes: {},
  },
  message: message(projectId),
  idempotencyKey: `c1:u${n}`,
  unsubscribeUrl: UNSUBSCRIBE_URL,
});

const pooled = (options: Parameters<typeof createPooledEmailAdapter>[0]) => {
  const adapter = createPooledEmailAdapter(options);
  adapters.push(adapter);
  return adapter;
};

const byProfile = (outcomes: DeliveryOutcome[]) =>
  Object.fromEntries(outcomes.map((o) => [o.profileId, o]));

async function until(condition: () => boolean): Promise<boolean> {
  for (let i = 0; i < POLL_LIMIT && !condition(); i++) {
    await Bun.sleep(POLL_MS);
  }
  return condition();
}

describe('pooled email adapter', () => {
  beforeEach(async () => {
    smtp = await startFakeSmtp();
  });
  afterEach(async () => {
    for (const adapter of adapters) {
      adapter.close();
    }
    adapters = [];
    await smtp.close();
  });

  it('200 messages with concurrency 3 use at most 3 connections', async () => {
    const items = Array.from({ length: 200 }, (_, n) => item(n));
    const outcomes = await pooled({}).sendBatch(items, config(), {
      concurrency: 3,
    });
    expect(outcomes).toHaveLength(200);
    expect(outcomes.every((o) => o.outcome === 'sent')).toBe(true);
    expect(smtp.messages).toHaveLength(200);
    expect(smtp.connections()).toBeLessThanOrEqual(3);
  });

  it('List-Unsubscribe is present on every message', async () => {
    const items = Array.from({ length: 5 }, (_, n) => item(n));
    await pooled({}).sendBatch(items, config(), { concurrency: 2 });
    expect(smtp.messages).toHaveLength(5);
    for (const sent of smtp.messages) {
      expect(sent.data).toContain(`List-Unsubscribe: <${UNSUBSCRIBE_URL}>`);
      expect(sent.data).toContain(
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
      );
    }
  });

  it('a 452 reply for one recipient is rate_limited', async () => {
    smtp.reply = (command) =>
      command.startsWith('RCPT') && command.includes('user1@')
        ? '452 try later'
        : undefined;
    const outcomes = byProfile(
      await pooled({}).sendBatch([item(0), item(1), item(2)], config(), {
        concurrency: 1,
      })
    );
    expect(outcomes.u1).toEqual({
      profileId: 'u1',
      outcome: 'rate_limited',
      reason: 'smtp 452',
    });
    expect(outcomes.u0?.outcome).toBe('sent');
    expect(outcomes.u2?.outcome).toBe('sent');
  });

  it('a 550 reply is failed with reason smtp 550', async () => {
    smtp.reply = (command) =>
      command.startsWith('RCPT') ? '550 no such user' : undefined;
    const [outcome] = await pooled({}).sendBatch([item(0)], config(), {
      concurrency: 1,
    });
    expect(outcome).toEqual({
      profileId: 'u0',
      outcome: 'failed',
      reason: 'smtp 550',
    });
  });

  it('EAUTH is channel_error', async () => {
    smtp.reply = (command) => {
      if (command.startsWith('EHLO')) {
        return '250-fake\r\n250 AUTH PLAIN LOGIN';
      }
      return command.startsWith('AUTH') ? '535 bad credentials' : undefined;
    };
    const [outcome] = await pooled({}).sendBatch(
      [item(0)],
      config({ user: 'u', pass: 'p' }),
      { concurrency: 1 }
    );
    expect(outcome?.outcome).toBe('channel_error');
    expect(outcome?.reason).toBe('smtp EAUTH');
  });

  it('a server that stops answering yields uncertain for in-flight items, retry for the rest, and closes the sockets', async () => {
    smtp.reply = (command) => (command === '.' ? null : undefined);
    const items = Array.from({ length: 6 }, (_, n) => item(n));
    const outcomes = await pooled({ timeoutMs: SHORT_TIMEOUT_MS }).sendBatch(
      items,
      config(),
      { concurrency: 2 }
    );
    expect(outcomes).toHaveLength(6);
    const kinds = outcomes.map((o) => `${o.outcome}:${o.reason}`);
    expect(kinds.filter((k) => k === 'uncertain:timeout')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'retry:pool closed')).toHaveLength(4);
    expect(
      await until(() => smtp.sessions.every((session) => session.closed))
    ).toBe(true);
  });

  it('items not yet handed over when the deadline passed or the signal aborted are retry deadline', async () => {
    const items = [item(0), item(1)];
    const late = await pooled({ now: () => 1000 }).sendBatch(items, config(), {
      concurrency: 1,
      deadlineAt: 1000,
    });
    expect(late.map((o) => `${o.outcome}:${o.reason}`)).toEqual([
      'retry:deadline',
      'retry:deadline',
    ]);
    const controller = new AbortController();
    controller.abort();
    const aborted = await pooled({}).sendBatch(items, config(), {
      concurrency: 1,
      signal: controller.signal,
    });
    expect(aborted.every((o) => o.outcome === 'retry')).toBe(true);
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.connections()).toBe(0);
  });

  it('gives exactly one outcome per item, including invalid recipients', async () => {
    const noEmail = item(1);
    noEmail.to = { ...noEmail.to, email: undefined };
    const badEmail = item(2);
    badEmail.to = { ...badEmail.to, email: 'nope\r\nBcc: x@evil.test' };
    const outcomes = byProfile(
      await pooled({}).sendBatch([item(0), noEmail, badEmail], config(), {
        concurrency: 2,
      })
    );
    expect(outcomes.u0?.outcome).toBe('sent');
    expect(outcomes.u1).toEqual({
      profileId: 'u1',
      outcome: 'failed',
      reason: 'no email',
    });
    expect(outcomes.u2).toEqual({
      profileId: 'u2',
      outcome: 'failed',
      reason: 'invalid email',
    });
    expect(smtp.messages).toHaveLength(1);
  });

  it('a throwing createTransport retries every item', async () => {
    const adapter = pooled({
      createTransport: () => {
        throw new Error('boom');
      },
    });
    const outcomes = await adapter.sendBatch([item(0), item(1)], config(), {
      concurrency: 2,
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(['retry', 'retry']);
  });

  it('a provider message is a wiring bug and throws before any send', async () => {
    const providerItem = {
      ...item(0),
      message: { kind: 'provider', version: {}, variables: [] },
    } as unknown as BatchItem;
    await expect(
      pooled({}).sendBatch([item(1), providerItem], config(), {
        concurrency: 1,
      })
    ).rejects.toThrow();
    expect(smtp.connections()).toBe(0);
  });

  it('reuses the pool across batches and closes it when the config changes', async () => {
    const closed: string[] = [];
    const created: string[] = [];
    const adapter = pooled({
      createTransport: (options) => {
        created.push(options.host ?? '');
        return {
          sendMail: () => Promise.resolve({}),
          close: () => closed.push(options.host ?? ''),
        };
      },
    });
    const run = (cfg: EmailConfig) =>
      adapter.sendBatch([item(0)], cfg, { concurrency: 1 });
    await run(config());
    await run(config());
    expect(created).toHaveLength(1);
    await run(config({ from: 'Other <other@example.test>' }));
    expect(created).toHaveLength(2);
    expect(closed).toHaveLength(1);
    adapter.close();
    expect(closed).toHaveLength(2);
  });

  it('closes an idle pool after idleCloseMs', async () => {
    const adapter = pooled({ idleCloseMs: 50 });
    await adapter.sendBatch([item(0)], config(), { concurrency: 1 });
    expect(
      await until(() => smtp.sessions.every((session) => session.closed))
    ).toBe(true);
  });
});
