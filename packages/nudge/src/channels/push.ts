import { createHash } from 'node:crypto';
import type { App } from 'firebase-admin/app';
import { z } from 'zod';
import { SEND_TIMEOUT_MS, withSendTimeout } from './timeouts';
import type { ChannelAdapter, SendResult } from './types';

const FCM_BATCH_LIMIT = 500;
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
]);

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
  notification: { title?: string; body: string };
}

export type MulticastSender = (
  serviceAccountJson: string,
  multicast: PushMulticast
) => Promise<{ responses: { success: boolean; error?: { code: string } }[] }>;

interface PushAdapterOptions {
  sendMulticast?: MulticastSender;
  timeoutMs?: number;
}

const apps = new Map<string, Promise<App>>();

// One named app per service account; firebase-admin is loaded on first send so importing opens nothing.
function appFor(serviceAccountJson: string): Promise<App> {
  const hash = createHash('sha256').update(serviceAccountJson).digest('hex');
  let app = apps.get(hash);
  if (!app) {
    app = import('firebase-admin/app').then(
      ({ cert, getApps, initializeApp }) => {
        const name = `nudge-${hash}`;
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
  }
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

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

async function sendAll(
  sendMulticast: MulticastSender,
  config: PushConfig,
  tokens: string[],
  notification: PushMulticast['notification']
): Promise<SendResult> {
  let delivered = 0;
  const invalidTokens: string[] = [];
  const failureCodes: string[] = [];
  for (const batch of chunks(tokens, FCM_BATCH_LIMIT)) {
    const { responses } = await sendMulticast(config.serviceAccountJson, {
      tokens: batch,
      notification,
    });
    for (const [index, response] of responses.entries()) {
      if (response.success) {
        delivered++;
        continue;
      }
      const code = response.error?.code ?? 'unknown';
      failureCodes.push(code);
      if (INVALID_TOKEN_CODES.has(code)) {
        invalidTokens.push(batch[index] ?? '');
      }
    }
  }
  const invalid = invalidTokens.length ? { invalidTokens } : {};
  if (delivered > 0) {
    return { ok: true, ...invalid };
  }
  return {
    ok: false,
    retryable: failureCodes.every((code) => TRANSIENT_CODES.has(code)),
    reason: `fcm ${failureCodes[0] ?? 'unknown'}`,
    ...invalid,
  };
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
      const notification =
        msg.title === undefined
          ? { body: msg.body }
          : { title: msg.title, body: msg.body };
      return withSendTimeout(timeoutMs, async () => {
        try {
          return await sendAll(
            sendMulticast,
            config,
            to.deviceTokens,
            notification
          );
        } catch (error) {
          // Only the code is kept: SDK messages can quote the credential.
          const code = errorCode(error);
          const retryable = TRANSIENT_CODES.has(code) || code === 'unknown';
          return {
            ok: false,
            retryable,
            reason: `fcm ${code}`,
          };
        }
      });
    },
  };
}
