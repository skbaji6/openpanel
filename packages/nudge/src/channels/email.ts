import nodemailer from 'nodemailer';
import { z } from 'zod';
import { SEND_TIMEOUT_MS, withSendTimeout } from './timeouts';
import type { ChannelAdapter, SendResult } from './types';

const MAX_PORT = 65_535;
const SMTP_PERMANENT_FAILURE = 500;
const SMTP_TRANSIENT_FAILURE = 400;
// Any of these ends a header line; the subject is admin-authored, so this adapter is the last guard.
const LINE_BREAKS = /[\r\n\u{2028}\u{2029}]/gu;
const HAS_LINE_BREAK = /[\r\n\u{2028}\u{2029}]/u;

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
  createTransport?: (
    options: Parameters<typeof nodemailer.createTransport>[0]
  ) => MailTransport;
  timeoutMs?: number;
}

const zEmail = z.string().email();

function stripLineBreaks(value: string): string {
  return value.replace(LINE_BREAKS, ' ');
}

// Only the SMTP code goes into the reason: server messages can echo addresses or credentials.
function failureFor(error: unknown): SendResult {
  const { responseCode, code } = (error ?? {}) as {
    responseCode?: unknown;
    code?: unknown;
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
  return {
    ok: false,
    retryable: true,
    reason: `smtp ${typeof code === 'string' ? code : 'error'}`,
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
      const transport = createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user
          ? { user: config.user, pass: config.pass }
          : undefined,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
        // The rendered body must never make the worker read local files or fetch URLs.
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      const mail: nodemailer.SendMailOptions = {
        from: stripLineBreaks(config.from),
        to: to.email,
        subject: stripLineBreaks(msg.subject ?? ''),
        html: msg.body,
        headers: {
          'List-Unsubscribe': `<${stripLineBreaks(opts.unsubscribeUrl)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      };
      return withSendTimeout(timeoutMs, async () => {
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
