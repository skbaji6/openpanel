import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { z } from 'zod';
import {
  type BatchChannelAdapter,
  type BatchItem,
  classifySendResult,
  type DeliveryOutcome,
} from './batch';
import { SEND_TIMEOUT_MS, withSendTimeout } from './timeouts';
import type { ChannelAdapter, RenderedMessage, SendResult } from './types';

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
  // nodemailer sets responseCode on auth failures too; the code is what tells credentials apart.
  if (code === 'EAUTH') {
    return { ok: false, retryable: false, reason: 'smtp EAUTH' };
  }
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

function invalidRecipientReason(
  email: string | undefined,
  unsubscribeUrl: string
): string | undefined {
  if (!email) {
    return 'no email';
  }
  if (!zEmail.safeParse(email).success) {
    return 'invalid email';
  }
  return isSafeUnsubscribeUrl(unsubscribeUrl)
    ? undefined
    : 'invalid unsubscribe url';
}

function buildMail(
  msg: RenderedMessage,
  email: string,
  config: EmailConfig,
  unsubscribeUrl: string
): nodemailer.SendMailOptions {
  return {
    from: stripLineBreaks(config.from),
    to: email,
    subject: stripLineBreaks(msg.subject ?? ''),
    html: msg.body,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
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
      const invalid = invalidRecipientReason(to.email, opts.unsubscribeUrl);
      if (invalid || !to.email) {
        return Promise.resolve({
          ok: false,
          retryable: false,
          reason: invalid ?? 'no email',
        });
      }
      const mail = buildMail(msg, to.email, config, opts.unsubscribeUrl);
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

const DEFAULT_IDLE_CLOSE_MS = 60_000;
const POOL_MAX_MESSAGES = 100;
const CAMPAIGN_MAX_BATCH = 500;
const DEADLINE_REASON = 'deadline';
const POOL_CLOSED_REASON = 'pool closed';

export interface PooledTransport extends MailTransport {
  close?(): void;
}

interface PooledEmailOptions {
  createTransport?: (options: SMTPPool.Options) => PooledTransport;
  timeoutMs?: number;
  idleCloseMs?: number;
  now?: () => number;
}

export type PooledEmailAdapter = BatchChannelAdapter<EmailConfig> & {
  close(): void;
};

interface Pool {
  digest: string;
  transport: PooledTransport;
  // Aborting destroys every socket the pool opened.
  sockets: AbortController;
  // Settle functions of the sends that were handed to the transport and have not settled.
  inflight: Set<() => void>;
  users: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

// The plaintext password never becomes part of a map key.
function configDigest(config: EmailConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.host,
        config.port,
        config.secure,
        config.user,
        config.pass,
        config.from,
      ])
    )
    .digest('hex');
}

function retryOutcome(profileId: string, reason: string): DeliveryOutcome {
  return { profileId, outcome: 'retry', reason };
}

// Campaign email: one pooled transport per project and config, reused across batches so
// authenticated connections are not re-opened. A recipient is only re-queued when the
// server certainly did not accept the message.
export function createPooledEmailAdapter(
  options: PooledEmailOptions = {}
): PooledEmailAdapter {
  const createTransport =
    options.createTransport ??
    ((transportOptions) => nodemailer.createTransport(transportOptions));
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  const now = options.now ?? Date.now;
  const pools = new Map<string, Pool>();

  const closePool = (key: string, pool: Pool) => {
    if (pool.closed) {
      return;
    }
    pool.closed = true;
    clearTimeout(pool.idleTimer);
    if (pools.get(key) === pool) {
      pools.delete(key);
    }
    pool.sockets.abort();
    pool.transport.close?.();
  };

  const acquire = (
    projectId: string,
    config: EmailConfig,
    concurrency: number
  ): Pool => {
    const digest = configDigest(config);
    const existing = pools.get(projectId);
    if (existing && existing.digest === digest) {
      return existing;
    }
    if (existing) {
      closePool(projectId, existing);
    }
    const sockets = new AbortController();
    const transport = createTransport({
      pool: true,
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      getSocket: socketOwnedBy(sockets.signal, {
        host: config.host,
        port: config.port,
      }),
      maxConnections: concurrency,
      maxMessages: POOL_MAX_MESSAGES,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const pool: Pool = {
      digest,
      transport,
      sockets,
      inflight: new Set(),
      users: 0,
      closed: false,
    };
    pools.set(projectId, pool);
    return pool;
  };

  const sendGroup = async (
    projectId: string,
    items: BatchItem[],
    config: EmailConfig,
    opts: { concurrency: number; signal?: AbortSignal; deadlineAt?: number }
  ): Promise<DeliveryOutcome[]> => {
    let pool: Pool;
    try {
      pool = acquire(projectId, config, opts.concurrency);
    } catch {
      return items.map((item) =>
        retryOutcome(item.profileId, POOL_CLOSED_REASON)
      );
    }
    pool.users += 1;
    clearTimeout(pool.idleTimer);
    const mustStop = () =>
      opts.signal?.aborted === true ||
      (opts.deadlineAt !== undefined && now() >= opts.deadlineAt);

    const sendOne = (item: BatchItem, email: string) =>
      new Promise<DeliveryOutcome>((resolve) => {
        const { profileId } = item;
        let settled = false;
        const settle = (outcome: Omit<DeliveryOutcome, 'profileId'>) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          pool.inflight.delete(expire);
          resolve({ profileId, ...outcome });
        };
        const expire = () =>
          settle({ outcome: 'uncertain', reason: 'timeout' });
        const fail = (error: unknown) =>
          settle(classifySendResult(failureFor(error)));
        const timer = setTimeout(() => {
          for (const settleInflight of [...pool.inflight]) {
            settleInflight();
          }
          closePool(projectId, pool);
        }, timeoutMs);
        pool.inflight.add(expire);
        // From this call on the message may reach the server.
        try {
          pool.transport
            .sendMail(
              buildMail(
                item.message as RenderedMessage,
                email,
                config,
                item.unsubscribeUrl
              )
            )
            .then(() => settle(classifySendResult({ ok: true })), fail);
        } catch (error) {
          fail(error);
        }
      });

    const outcomes: DeliveryOutcome[] = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const item = items[next++];
        if (!item) {
          continue;
        }
        if (pool.closed) {
          outcomes.push(retryOutcome(item.profileId, POOL_CLOSED_REASON));
        } else if (mustStop()) {
          outcomes.push(retryOutcome(item.profileId, DEADLINE_REASON));
        } else {
          outcomes.push(await sendOne(item, item.to.email as string));
        }
      }
    };
    try {
      await Promise.all(
        Array.from(
          { length: Math.max(1, Math.min(opts.concurrency, items.length)) },
          worker
        )
      );
    } finally {
      pool.users -= 1;
      if (pool.users === 0 && !pool.closed) {
        pool.idleTimer = setTimeout(
          () => closePool(projectId, pool),
          idleCloseMs
        );
        pool.idleTimer.unref();
      }
    }
    return outcomes;
  };

  return {
    id: 'email',
    configSchema,
    maxBatch: CAMPAIGN_MAX_BATCH,
    async sendBatch(items, config, opts) {
      if (items.some((item) => 'kind' in item.message)) {
        throw new Error(
          'provider messages cannot go through the email adapter'
        );
      }
      const outcomes: DeliveryOutcome[] = [];
      const groups = new Map<string, BatchItem[]>();
      for (const item of items) {
        const reason = invalidRecipientReason(
          item.to.email,
          item.unsubscribeUrl
        );
        if (reason) {
          outcomes.push({
            profileId: item.profileId,
            outcome: 'failed',
            reason,
          });
          continue;
        }
        const { projectId } = (item.message as RenderedMessage).meta;
        groups.set(projectId, [...(groups.get(projectId) ?? []), item]);
      }
      for (const [projectId, group] of groups) {
        outcomes.push(...(await sendGroup(projectId, group, config, opts)));
      }
      return outcomes;
    },
    close() {
      for (const [key, pool] of pools) {
        closePool(key, pool);
      }
    },
  };
}
