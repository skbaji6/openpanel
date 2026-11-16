import { createHash } from 'node:crypto';
import type { App } from 'firebase-admin/app';
import { z } from 'zod';
import { SEND_TIMEOUT_MS, withSendTimeout } from './timeouts';
import type { ChannelAdapter, SendResult } from './types';

const FCM_BATCH_LIMIT = 500;
const UNKNOWN_CODE = 'unknown';
const TIMEOUT_RESULT_FAILURE = { retryable: true, reason: 'timeout' };
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
const TRANSIENT_CODES = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/quota-exceeded',
  'app/network-timeout',
  'app/network-error',
  // The app was evicted from the cache while this send was using it.
  'app/app-deleted',
]);

// Codes where the message certainly reached nobody and the account, not the token, is the problem.
const RATE_OR_CREDENTIAL_CODES = new Set([
  'messaging/quota-exceeded',
  'messaging/message-rate-exceeded',
  'app/invalid-credential',
]);
// Rejected before any delivery, for a reason other than the account: an unlisted code is not here, so it ranks as ambiguous.
const KNOWN_PERMANENT_CODES = new Set([
  'messaging/invalid-argument',
  'messaging/invalid-payload',
  'messaging/payload-size-limit-exceeded',
  'messaging/mismatched-credential',
  'messaging/third-party-auth-error',
  'messaging/invalid-apns-credentials',
]);
const RANK_POSSIBLY_DELIVERED = 2;
const RANK_ACCOUNT_LEVEL = 1;

const zServiceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

function isServiceAccountJson(value: string): boolean {
  try {
    return zServiceAccount.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

const configSchema = z.object({
  serviceAccountJson: z.string().refine(isServiceAccountJson, {
    message: 'must be a service account JSON',
  }),
});

export type PushConfig = z.infer<typeof configSchema>;

export interface PushMulticast {
  tokens: string[];
  notification: { title?: string; body: string; imageUrl?: string };
  data?: Record<string, string>;
}

export type MulticastSender = (
  serviceAccountJson: string,
  multicast: PushMulticast
) => Promise<{ responses: { success: boolean; error?: { code: string } }[] }>;

interface PushAdapterOptions {
  sendMulticast?: MulticastSender;
  timeoutMs?: number;
}

// Each app holds credentials and an HTTP agent; a bounded LRU keeps a worker serving many projects small.
export const MAX_FIREBASE_APPS = 8;
const apps = new Map<string, Promise<App>>();

function evictOldestApp(): void {
  const oldest = apps.keys().next();
  if (oldest.done) {
    return;
  }
  const evicted = apps.get(oldest.value);
  apps.delete(oldest.value);
  evicted
    ?.then(async (app) => {
      const { deleteApp } = await import('firebase-admin/app');
      await deleteApp(app);
    })
    .catch(() => undefined);
}

// One named app per service account; firebase-admin is loaded on first send so importing opens nothing.
export function appFor(serviceAccountJson: string): Promise<App> {
  const hash = createHash('sha256').update(serviceAccountJson).digest('hex');
  const cached = apps.get(hash);
  if (cached) {
    apps.delete(hash);
    apps.set(hash, cached);
    return cached;
  }
  if (apps.size >= MAX_FIREBASE_APPS) {
    evictOldestApp();
  }
  const app = import('firebase-admin/app').then(
    ({ cert, getApps, initializeApp }) => {
      const name = `marketing-${hash}`;
      const account = zServiceAccount.parse(JSON.parse(serviceAccountJson));
      return (
        getApps().find((existing) => existing.name === name) ??
        initializeApp(
          {
            credential: cert({
              projectId: account.project_id,
              clientEmail: account.client_email,
              privateKey: account.private_key,
            }),
          },
          name
        )
      );
    }
  );
  app.catch(() => apps.delete(hash));
  apps.set(hash, app);
  return app;
}

const sendWithFirebase: MulticastSender = async (
  serviceAccountJson,
  multicast
) => {
  const [app, { getMessaging }] = await Promise.all([
    appFor(serviceAccountJson),
    import('firebase-admin/messaging'),
  ]);
  return getMessaging(app).sendEachForMulticast(multicast);
};

// A failure without a code is unexplained, so it is retried rather than dropped.
function isTransient(code: string): boolean {
  return code === UNKNOWN_CODE || TRANSIENT_CODES.has(code);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : UNKNOWN_CODE;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

// Once any token got the message the send counts as delivered: a retry would push it to them again.
class MulticastProgress {
  delivered = 0;
  readonly invalidTokens: string[] = [];
  readonly failureCodes: string[] = [];

  record(
    batch: string[],
    responses: Awaited<ReturnType<MulticastSender>>['responses']
  ): void {
    for (const [index, response] of responses.entries()) {
      if (response.success) {
        this.delivered++;
        continue;
      }
      const code = response.error?.code ?? UNKNOWN_CODE;
      this.failureCodes.push(code);
      if (INVALID_TOKEN_CODES.has(code)) {
        this.invalidTokens.push(batch[index] ?? '');
      }
    }
  }

  result(failure: { retryable: boolean; reason: string }): SendResult {
    const invalid = this.invalidTokens.length
      ? { invalidTokens: this.invalidTokens }
      : {};
    if (this.delivered > 0) {
      return { ok: true, ...invalid };
    }
    return { ok: false, ...failure, ...invalid };
  }

  // The reason names the most ambiguous failure: a token that may have been delivered must not be hidden
  // behind a rate-limit code from another token, or the whole send is re-queued and that token is pushed twice.
  reportedCode(): string {
    const rank = (code: string) => {
      if (RATE_OR_CREDENTIAL_CODES.has(code)) {
        return RANK_ACCOUNT_LEVEL;
      }
      const certainlyNotSent =
        INVALID_TOKEN_CODES.has(code) || KNOWN_PERMANENT_CODES.has(code);
      return certainlyNotSent ? 0 : RANK_POSSIBLY_DELIVERED;
    };
    let [reported = UNKNOWN_CODE] = this.failureCodes;
    for (const code of this.failureCodes) {
      if (rank(code) > rank(reported)) {
        reported = code;
      }
    }
    return reported;
  }

  final(): SendResult {
    const firstCode = this.reportedCode();
    return this.result({
      retryable: this.failureCodes.every(isTransient),
      reason: `fcm ${firstCode}`,
    });
  }
}

// Stops between batches once the deadline passed; a batch already in flight cannot be cancelled.
async function sendAll(
  sendMulticast: MulticastSender,
  config: PushConfig,
  tokens: string[],
  content: Pick<PushMulticast, 'notification' | 'data'>,
  progress: MulticastProgress,
  signal: AbortSignal
): Promise<SendResult> {
  for (const batch of chunks(tokens, FCM_BATCH_LIMIT)) {
    if (signal.aborted) {
      return progress.result(TIMEOUT_RESULT_FAILURE);
    }
    try {
      const { responses } = await sendMulticast(config.serviceAccountJson, {
        tokens: batch,
        ...content,
      });
      progress.record(batch, responses);
    } catch (error) {
      // Only the code is kept: SDK messages can quote the credential.
      const code = errorCode(error);
      progress.failureCodes.push(code);
      return progress.result({
        retryable: isTransient(code),
        reason: `fcm ${progress.reportedCode()}`,
      });
    }
  }
  return progress.final();
}

export function createPushAdapter(
  options: PushAdapterOptions = {}
): ChannelAdapter<PushConfig> {
  const sendMulticast = options.sendMulticast ?? sendWithFirebase;
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;

  return {
    id: 'push',
    configSchema,
    send(msg, to, config) {
      if (to.deviceTokens.length === 0) {
        return Promise.resolve({
          ok: false,
          retryable: false,
          reason: 'no device tokens',
        });
      }
      const content: Pick<PushMulticast, 'notification' | 'data'> = {
        notification: {
          ...(msg.title === undefined ? {} : { title: msg.title }),
          body: msg.body,
          ...(msg.imageUrl === undefined ? {} : { imageUrl: msg.imageUrl }),
        },
        ...(msg.data === undefined ? {} : { data: msg.data }),
      };
      const progress = new MulticastProgress();
      return withSendTimeout(
        timeoutMs,
        (signal) =>
          sendAll(
            sendMulticast,
            config,
            to.deviceTokens,
            content,
            progress,
            signal
          ),
        () => progress.result(TIMEOUT_RESULT_FAILURE)
      );
    },
  };
}
