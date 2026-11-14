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

const NEVER_CONNECTED_MESSAGE = 'connection closed before it was established';

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
    // A transient 4xx auth reply stays retryable, as it was when the response code decided.
    const isTransient =
      typeof responseCode === 'number' &&
      responseCode >= SMTP_TRANSIENT_FAILURE &&
      responseCode < SMTP_PERMANENT_FAILURE;
    return { ok: false, retryable: isTransient, reason: 'smtp EAUTH' };
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
      settle(new Error(NEVER_CONNECTED_MESSAGE));
    });
    socket.once('error', (error) => settle(error));
    socket.once('connect', () => settle(null, socket));
    if (signal.aborted) {
      destroy();
    }
  };
}

function checkRecipient(
  email: string | undefined,
  unsubscribeUrl: string
): { email: string } | { reason: string } {
  if (!email) {
    return { reason: 'no email' };
  }
  if (!zEmail.safeParse(email).success) {
    return { reason: 'invalid email' };
  }
  return isSafeUnsubscribeUrl(unsubscribeUrl)
    ? { email }
    : { reason: 'invalid unsubscribe url' };
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
      const checked = checkRecipient(to.email, opts.unsubscribeUrl);
      if ('reason' in checked) {
        return Promise.resolve({
          ok: false,
          retryable: false,
          reason: checked.reason,
        });
      }
      const mail = buildMail(msg, checked.email, config, opts.unsubscribeUrl);
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
// nodemailer keeps a connection that failed to connect in its pool for good, so later sends would hang.
// nodemailer's reply for a message still in its queue at close: it was never given to a connection.
const NEVER_STARTED_MESSAGE = 'Connection pool was closed';
const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

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
  key: string;
  digest: string;
  transport: PooledTransport;
  // Aborting destroys every socket the pool opened.
  sockets: AbortController;
  // Settle functions of the sends that were handed to the transport and have not settled.
  inflight: Set<() => void>;
  users: number;
  // Connections the pool has; sends in flight never exceed it, so a handed-over send is never queued.
  size: number;
  free: number;
  waiters: (() => void)[];
  // Replaced by a pool of another size or config: drains, then closes.
  retired: boolean;
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

interface Target {
  item: BatchItem;
  email: string;
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
  const allPools = new Set<Pool>();

  const closePool = (pool: Pool) => {
    if (pool.closed) {
      return;
    }
    pool.closed = true;
    clearTimeout(pool.idleTimer);
    if (pools.get(pool.key) === pool) {
      pools.delete(pool.key);
    }
    allPools.delete(pool);
    for (const wake of pool.waiters.splice(0)) {
      wake();
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
    if (
      existing &&
      existing.digest === digest &&
      existing.size === concurrency
    ) {
      return existing;
    }
    if (existing) {
      pools.delete(projectId);
      existing.retired = true;
      if (existing.users === 0) {
        closePool(existing);
      }
    }
    const sockets = new AbortController();
    // maxRequeues is missing from the published types.
    const poolOptions: SMTPPool.Options & { maxRequeues: number } = {
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
      // nodemailer must never re-send a message on its own: that would be a second delivery.
      maxRequeues: 0,
      maxMessages: POOL_MAX_MESSAGES,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    const transport = createTransport(poolOptions);
    const pool: Pool = {
      key: projectId,
      digest,
      transport,
      sockets,
      inflight: new Set(),
      users: 0,
      size: concurrency,
      free: concurrency,
      waiters: [],
      retired: false,
      closed: false,
    };
    pools.set(projectId, pool);
    allPools.add(pool);
    return pool;
  };

  const sendGroup = async (
    projectId: string,
    items: Target[],
    config: EmailConfig,
    opts: { concurrency: number; signal?: AbortSignal; deadlineAt?: number }
  ): Promise<DeliveryOutcome[]> => {
    let pool: Pool;
    try {
      pool = acquire(projectId, config, opts.concurrency);
    } catch {
      return items.map(({ item }) =>
        retryOutcome(item.profileId, POOL_CLOSED_REASON)
      );
    }
    pool.users += 1;
    clearTimeout(pool.idleTimer);
    const mustStop = () =>
      opts.signal?.aborted === true ||
      (opts.deadlineAt !== undefined && now() >= opts.deadlineAt);

    const takeSlot = (): Promise<void> => {
      if (pool.free > 0) {
        pool.free -= 1;
        return Promise.resolve();
      }
      return new Promise((wake) => pool.waiters.push(wake));
    };
    const releaseSlot = () => {
      const wake = pool.waiters.shift();
      if (wake) {
        wake();
      } else {
        pool.free += 1;
      }
    };

    const sendOne = ({ item, email }: Target) =>
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
        const fail = (error: unknown) => {
          const { code, message } = (error ?? {}) as {
            code?: unknown;
            message?: unknown;
          };
          if (
            message === NEVER_STARTED_MESSAGE ||
            message === NEVER_CONNECTED_MESSAGE
          ) {
            settle({ outcome: 'retry', reason: POOL_CLOSED_REASON });
            return;
          }
          settle(classifySendResult(failureFor(error)));
          if (typeof code === 'string' && CONNECT_FAILURE_CODES.has(code)) {
            closePool(pool);
          }
        };
        const timer = setTimeout(() => {
          for (const settleInflight of [...pool.inflight]) {
            settleInflight();
          }
          closePool(pool);
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
        const entry = items[next++];
        if (!entry) {
          continue;
        }
        const { profileId } = entry.item;
        // Waiting for a slot is not being handed over: the send has not started.
        await takeSlot();
        if (pool.closed) {
          outcomes.push(retryOutcome(profileId, POOL_CLOSED_REASON));
        } else if (mustStop()) {
          outcomes.push(retryOutcome(profileId, DEADLINE_REASON));
        } else {
          outcomes.push(await sendOne(entry));
        }
        releaseSlot();
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
      if (pool.users === 0 && pool.retired) {
        closePool(pool);
      } else if (pool.users === 0 && !pool.closed) {
        pool.idleTimer = setTimeout(() => closePool(pool), idleCloseMs);
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
      const groups = new Map<string, Target[]>();
      for (const item of items) {
        const checked = checkRecipient(item.to.email, item.unsubscribeUrl);
        if ('reason' in checked) {
          outcomes.push({
            profileId: item.profileId,
            outcome: 'failed',
            reason: checked.reason,
          });
          continue;
        }
        const { projectId } = (item.message as RenderedMessage).meta;
        groups.set(projectId, [
          ...(groups.get(projectId) ?? []),
          { item, email: checked.email },
        ]);
      }
      for (const [projectId, group] of groups) {
        outcomes.push(...(await sendGroup(projectId, group, config, opts)));
      }
      return outcomes;
    },
    close() {
      for (const pool of [...allPools]) {
        closePool(pool);
      }
    },
  };
}
