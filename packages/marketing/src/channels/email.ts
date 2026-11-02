import { connect, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { z } from 'zod';
import { SEND_TIMEOUT_MS, withSendTimeout } from './timeouts';
import type { ChannelAdapter, SendResult } from './types';

const MAX_PORT = 65_535;
const SMTP_PERMANENT_FAILURE = 500;
const SMTP_TRANSIENT_FAILURE = 400;
// Any of these ends a header line; the subject is admin-authored, so this adapter is the last guard.
const LINE_BREAKS = /[\r\n\u{2028}\u{2029}]/gu;
const HAS_LINE_BREAK = /[\r\n\u{2028}\u{2029}]/u;
// Characters that would end or split the <...> of a List-Unsubscribe header (\s covers line breaks).
const UNSAFE_IN_ANGLE_URL = /[\s<>,]/u;
// Misconfiguration or a rejected message: retrying cannot help. Everything else
// (ECONNREFUSED, ECONNRESET, ETIMEDOUT, ESOCKET, EDNS, ECONNECTION, ...) is retried.
const PERMANENT_CODES = new Set(['ETLS', 'EENVELOPE', 'EAUTH', 'EMESSAGE']);
// nodemailer reports certificate failures as ESOCKET, so the message is the only hint.
const TLS_FAILURE_CODE = /CERT|TLS|SSL/;
const TLS_FAILURE_MESSAGE = /certificate|tls|ssl/i;

const zNoLineBreaks = z
  .string()
  .min(1)
  .refine((value) => !HAS_LINE_BREAK.test(value), {
    message: 'must not contain line breaks',
  });

const configSchema = z.object({
  host: zNoLineBreaks,
  port: z.number().int().min(1).max(MAX_PORT),
  secure: z.boolean(),
  user: z.string().optional(),
  pass: z.string().optional(),
  from: zNoLineBreaks,
});

export type EmailConfig = z.infer<typeof configSchema>;

export interface MailTransport {
  sendMail(mail: nodemailer.SendMailOptions): Promise<unknown>;
}

interface EmailAdapterOptions {
  createTransport?: (options: SMTPTransport.Options) => MailTransport;
  timeoutMs?: number;
}

const zEmail = z.string().email();

function stripLineBreaks(value: string): string {
  return value.replace(LINE_BREAKS, ' ');
}

function isSafeUnsubscribeUrl(value: string): boolean {
  return !UNSAFE_IN_ANGLE_URL.test(value) && URL.parse(value) !== null;
}

// Only the SMTP code goes into the reason: server messages can echo addresses or credentials.
function failureFor(error: unknown): SendResult {
  const { responseCode, code, message } = (error ?? {}) as {
    responseCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (typeof responseCode === 'number') {
    return {
      ok: false,
      retryable:
        responseCode >= SMTP_TRANSIENT_FAILURE &&
        responseCode < SMTP_PERMANENT_FAILURE,
      reason: `smtp ${responseCode}`,
    };
  }
  const errorCode = typeof code === 'string' ? code : 'error';
  const isTlsFailure =
    TLS_FAILURE_CODE.test(errorCode) ||
    (typeof message === 'string' && TLS_FAILURE_MESSAGE.test(message));
  return {
    ok: false,
    retryable: !(PERMANENT_CODES.has(errorCode) || isTlsFailure),
    reason: `smtp ${errorCode}`,
  };
}

// The adapter opens the TCP connection itself so the deadline can destroy it: once a send
// has been reported as a (retryable) timeout, nothing more may reach the server.
function socketOwnedBy(
  signal: AbortSignal,
  target: { host: string; port: number }
): SMTPTransport.Options['getSocket'] {
  return (_options, callback) => {
    let settled = false;
    const settle = (error: Error | null, socket?: Socket) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(error, socket ? { connection: socket } : false);
    };
    const socket = connect(target);
    const destroy = () => socket.destroy();
    signal.addEventListener('abort', destroy, { once: true });
    socket.once('close', () => {
      signal.removeEventListener('abort', destroy);
      settle(new Error('connection closed before it was established'));
    });
    socket.once('error', (error) => settle(error));
    socket.once('connect', () => settle(null, socket));
    if (signal.aborted) {
      destroy();
    }
  };
}

export function createEmailAdapter(
  options: EmailAdapterOptions = {}
): ChannelAdapter<EmailConfig> {
  const createTransport =
    options.createTransport ??
    ((transportOptions) => nodemailer.createTransport(transportOptions));
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;

  return {
    id: 'email',
    configSchema,
    send(msg, to, config, opts) {
      if (!to.email) {
        return Promise.resolve({
          ok: false,
          retryable: false,
          reason: 'no email',
        });
      }
      if (!zEmail.safeParse(to.email).success) {
        return Promise.resolve({
          ok: false,
          retryable: false,
          reason: 'invalid email',
        });
      }
      if (!isSafeUnsubscribeUrl(opts.unsubscribeUrl)) {
        return Promise.resolve({
          ok: false,
          retryable: false,
          reason: 'invalid unsubscribe url',
        });
      }
      const mail: nodemailer.SendMailOptions = {
        from: stripLineBreaks(config.from),
        to: to.email,
        subject: stripLineBreaks(msg.subject ?? ''),
        html: msg.body,
        headers: {
          'List-Unsubscribe': `<${opts.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      };
      return withSendTimeout(timeoutMs, async (signal) => {
        const transport = createTransport({
          host: config.host,
          port: config.port,
          secure: config.secure,
          auth: config.user
            ? { user: config.user, pass: config.pass }
            : undefined,
          getSocket: socketOwnedBy(signal, {
            host: config.host,
            port: config.port,
          }),
          connectionTimeout: timeoutMs,
          greetingTimeout: timeoutMs,
          socketTimeout: timeoutMs,
          // The rendered body must never make the worker read local files or fetch URLs.
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        try {
          await transport.sendMail(mail);
          return { ok: true };
        } catch (error) {
          return failureFor(error);
        }
      });
    },
  };
}
