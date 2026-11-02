import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import {
  createEmailAdapter,
  type EmailConfig,
  type MailTransport,
} from './email';
import type { Recipient, RenderedMessage, SendOptions } from './types';

const UNSUBSCRIBE_URL = 'https://marketing.test/unsubscribe?t=abc';
const HANG_MS = 5000;
const SLOW_REPLY_MS = 40;
const SLOW_TIMEOUT_MS = 100;

const message: RenderedMessage = {
  subject: 'Your cart misses you',
  body: '<p>Come back</p>',
  meta: { projectId: 'p1', enrollmentId: 'e1', ruleId: 'r1', stepIndex: 0 },
};
const recipient: Recipient = {
  profileId: 'u1',
  email: 'ada@example.test',
  deviceTokens: [],
  attributes: {},
};
const opts: SendOptions = {
  idempotencyKey: 'e1:0',
  unsubscribeUrl: UNSUBSCRIBE_URL,
};

// A minimal SMTP server: enough of the protocol for nodemailer to deliver one message.
// `data` is set once the server has the whole message, i.e. it was delivered.
interface Session {
  recipients: string[];
  data: string;
  closed: boolean;
}
let sessions: Session[] = [];
let mailFromReply = '250 ok';
let replyDelayMs = 0;

function handle(socket: Socket) {
  const session: Session = { recipients: [], data: '', closed: false };
  sessions.push(session);
  socket.on('close', () => {
    session.closed = true;
  });
  socket.on('error', () => undefined);
  const reply = (line: string) => {
    setTimeout(() => {
      if (socket.writable) {
        socket.write(`${line}\r\n`);
      }
    }, replyDelayMs);
  };
  let buffer = '';
  let inData = false;
  reply('220 fake smtp');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (inData) {
      const end = buffer.indexOf('\r\n.\r\n');
      if (end === -1) {
        return;
      }
      session.data = buffer.slice(0, end);
      buffer = buffer.slice(end + 5);
      inData = false;
      reply('250 queued');
    }
    let lineEnd = buffer.indexOf('\r\n');
    while (lineEnd !== -1 && !inData) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') {
        reply('250 fake');
      } else if (verb === 'MAIL') {
        reply(mailFromReply);
      } else if (verb === 'RCPT') {
        session.recipients.push(line);
        reply('250 ok');
      } else if (verb === 'DATA') {
        inData = true;
        reply('354 go');
      } else if (verb === 'QUIT') {
        socket.end('221 bye\r\n');
      } else {
        reply('250 ok');
      }
      lineEnd = buffer.indexOf('\r\n');
    }
  });
}

const smtp = createServer(handle);
await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
const address = smtp.address();
const SMTP_PORT = typeof address === 'object' && address ? address.port : 0;

const realConfig: EmailConfig = {
  host: '127.0.0.1',
  port: SMTP_PORT,
  secure: false,
  from: 'Shop <shop@example.test>',
};

interface SentMail {
  to?: unknown;
  subject?: unknown;
  headers?: Record<string, string>;
}

function fakeTransport(
  behaviour: (mail: SentMail) => Promise<unknown>
): () => MailTransport {
  return () => ({
    sendMail: (mail) => behaviour(mail as SentMail),
  });
}

describe('email adapter', () => {
  beforeEach(() => {
    sessions = [];
    mailFromReply = '250 ok';
    replyDelayMs = 0;
  });
  afterAll(() => {
    smtp.close();
  });

  it('sets List-Unsubscribe and List-Unsubscribe-Post headers', async () => {
    const adapter = createEmailAdapter();
    expect(await adapter.send(message, recipient, realConfig, opts)).toEqual({
      ok: true,
    });
    const [session] = sessions;
    expect(session?.recipients).toEqual(['RCPT TO:<ada@example.test>']);
    expect(session?.data).toContain(`List-Unsubscribe: <${UNSUBSCRIBE_URL}>`);
    expect(session?.data).toContain(
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
    );
    expect(session?.data).toContain('Subject: Your cart misses you');
  });

  it('strips CR/LF from the subject so it cannot inject headers', async () => {
    const adapter = createEmailAdapter();
    const hostile = {
      ...message,
      subject: 'Hello\r\nBcc: x@evil.test\u{2028}X-Extra: 1',
    };
    expect(await adapter.send(hostile, recipient, realConfig, opts)).toEqual({
      ok: true,
    });
    const [session] = sessions;
    expect(session?.recipients).toEqual(['RCPT TO:<ada@example.test>']);
    expect(session?.data).not.toMatch(/^Bcc:/im);
    expect(session?.data).not.toMatch(/^X-Extra:/im);

    // nodemailer folds these itself today; the adapter must not rely on that.
    const sent: SentMail[] = [];
    const recording = createEmailAdapter({
      createTransport: fakeTransport(async (mail) => {
        sent.push(mail);
        return {};
      }),
    });
    await recording.send(hostile, recipient, realConfig, opts);
    expect(sent).toHaveLength(1);
    const headerValues = [
      sent[0]?.subject,
      ...Object.values(sent[0]?.headers ?? {}),
    ].map(String);
    for (const value of headerValues) {
      expect(value).not.toMatch(/[\r\n\u{2028}\u{2029}]/u);
    }
  });

  it('rejects a recipient address or sender with line breaks', async () => {
    const sent: SentMail[] = [];
    const adapter = createEmailAdapter({
      createTransport: fakeTransport(async (mail) => {
        sent.push(mail);
        return {};
      }),
    });
    expect(
      await adapter.send(
        message,
        { ...recipient, email: 'ada@example.test\r\nBcc: x@evil.test' },
        realConfig,
        opts
      )
    ).toEqual({ ok: false, retryable: false, reason: 'invalid email' });
    expect(
      adapter.configSchema.safeParse({
        ...realConfig,
        from: 'shop@example.test\nBcc: x@evil.test',
      }).success
    ).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('does not send when recipient has no email', async () => {
    const sent: SentMail[] = [];
    const adapter = createEmailAdapter({
      createTransport: fakeTransport(async (mail) => {
        sent.push(mail);
        return {};
      }),
    });
    const { email: _omitted, ...withoutEmail } = recipient;
    expect(await adapter.send(message, withoutEmail, realConfig, opts)).toEqual(
      { ok: false, retryable: false, reason: 'no email' }
    );
    expect(sent).toHaveLength(0);
  });

  it('421 response is retryable and 550 is not', async () => {
    for (const [responseCode, retryable] of [
      [421, true],
      [550, false],
    ] as const) {
      const adapter = createEmailAdapter({
        createTransport: fakeTransport(() =>
          Promise.reject(
            Object.assign(new Error('rejected'), {
              responseCode,
              code: 'EENVELOPE',
            })
          )
        ),
      });
      expect(await adapter.send(message, recipient, realConfig, opts)).toEqual({
        ok: false,
        retryable,
        reason: `smtp ${responseCode}`,
      });
    }
  });

  it('a 550 from a real SMTP server is not retryable', async () => {
    mailFromReply = '550 no such sender';
    const adapter = createEmailAdapter();
    expect(await adapter.send(message, recipient, realConfig, opts)).toEqual({
      ok: false,
      retryable: false,
      reason: 'smtp 550',
    });
  });

  it('a connection error is retryable', async () => {
    const adapter = createEmailAdapter();
    const result = await adapter.send(
      message,
      recipient,
      { ...realConfig, port: 1 },
      opts
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(true);
  });

  it('a hanging transport times out as a retryable failure', async () => {
    const adapter = createEmailAdapter({
      timeoutMs: 50,
      createTransport: fakeTransport(() => Bun.sleep(HANG_MS)),
    });
    expect(await adapter.send(message, recipient, realConfig, opts)).toEqual({
      ok: false,
      retryable: true,
      reason: 'timeout',
    });
  });

  it('after a timeout the message is never delivered and the connection is closed', async () => {
    replyDelayMs = SLOW_REPLY_MS;
    const adapter = createEmailAdapter({ timeoutMs: SLOW_TIMEOUT_MS });
    expect(await adapter.send(message, recipient, realConfig, opts)).toEqual({
      ok: false,
      retryable: true,
      reason: 'timeout',
    });
    await Bun.sleep(SLOW_REPLY_MS * 10 * 3);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.data).toBe('');
    expect(sessions[0]?.closed).toBe(true);
  });

  it('a slow but timely server still delivers', async () => {
    replyDelayMs = 5;
    const adapter = createEmailAdapter({ timeoutMs: 5000 });
    expect(await adapter.send(message, recipient, realConfig, opts)).toEqual({
      ok: true,
    });
    expect(sessions[0]?.data).toContain('Come back');
  });

  it('rejects a List-Unsubscribe url that could break out of its angle brackets', async () => {
    const sent: SentMail[] = [];
    const adapter = createEmailAdapter({
      createTransport: fakeTransport(async (mail) => {
        sent.push(mail);
        return {};
      }),
    });
    for (const unsubscribeUrl of [
      'https://x.test/u>, <mailto:evil@x.test',
      'https://x.test/u\r\nBcc: x@evil.test',
      'https://x.test/a b',
      'https://x.test/a,b',
      'not a url',
    ]) {
      expect(
        await adapter.send(message, recipient, realConfig, {
          ...opts,
          unsubscribeUrl,
        })
      ).toEqual({
        ok: false,
        retryable: false,
        reason: 'invalid unsubscribe url',
      });
    }
    expect(sent).toHaveLength(0);
  });

  it('classifies errors without an SMTP response code', async () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{ code: 'ECONNREFUSED' }, true],
      [{ code: 'ECONNRESET' }, true],
      [{ code: 'ETIMEDOUT' }, true],
      [{ code: 'ESOCKET' }, true],
      [{ code: 'EDNS' }, true],
      [
        { code: 'ECONNECTION', message: 'Connection closed unexpectedly' },
        true,
      ],
      [{ code: 'ETLS' }, false],
      [{ code: 'ESOCKET', message: 'self-signed certificate' }, false],
      [{ code: 'CERT_HAS_EXPIRED' }, false],
      [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, false],
      [{ code: 'EENVELOPE' }, false],
      [{ code: 'EAUTH' }, false],
      [{ code: 'EMESSAGE' }, false],
    ];
    for (const [fields, retryable] of cases) {
      const adapter = createEmailAdapter({
        createTransport: fakeTransport(() =>
          Promise.reject(Object.assign(new Error('failed'), fields))
        ),
      });
      expect(await adapter.send(message, recipient, realConfig, opts)).toEqual({
        ok: false,
        retryable,
        reason: `smtp ${String(fields.code)}`,
      });
    }
  });

  it('config schema bounds the port and requires a sender', () => {
    const parse = (config: unknown) =>
      createEmailAdapter().configSchema.safeParse(config).success;
    expect(parse({ ...realConfig, user: 'u', pass: 'p' })).toBe(true);
    expect(parse({ ...realConfig, port: 0 })).toBe(false);
    expect(parse({ ...realConfig, port: 65_536 })).toBe(false);
    expect(parse({ ...realConfig, from: '' })).toBe(false);
  });
});
