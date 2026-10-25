import { createHmac } from 'node:crypto';
import { BlockedUrlError, safeFetchStream } from '@openpanel/shared/server';
import { z } from 'zod';
import { SEND_TIMEOUT_MS, withSendTimeout } from './timeouts';
import type { ChannelAdapter, SendResult } from './types';

const MIN_SECRET_LENGTH = 16;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

// secrets[0] signs; a second secret is kept during rotation so receivers may accept a signature from either.
export interface WebhookConfig {
  url: string;
  secrets: string[];
}

interface WebhookAdapterOptions {
  allowHosts: string[];
  timeoutMs?: number;
}

function sign(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `sha256=${digest}`;
}

function resultFor(status: number): SendResult {
  if (status >= 200 && status < 300) {
    return { ok: true };
  }
  const retryable =
    status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR;
  return { ok: false, retryable, reason: `http ${status}` };
}

// Response bodies are discarded unread: they may echo secrets and only the status matters.
async function postAllowlisted(
  url: URL,
  init: { headers: Record<string, string>; body: string },
  signal: AbortSignal
): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    ...init,
    redirect: 'manual',
    signal,
  });
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}

async function postPublic(
  url: URL,
  init: { headers: Record<string, string>; body: string },
  signal: AbortSignal,
  timeoutMs: number
): Promise<number> {
  const response = await safeFetchStream(url, {
    method: 'POST',
    ...init,
    followRedirects: false,
    timeoutMs,
    signal,
  });
  await response.close();
  return response.status;
}

export function createWebhookAdapter(
  options: WebhookAdapterOptions
): ChannelAdapter<WebhookConfig> {
  const allowHosts = new Set(options.allowHosts.map((h) => h.toLowerCase()));
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  const isAllowlisted = (url: URL) =>
    allowHosts.has(url.hostname.toLowerCase());
  // Parses without throwing: zod still runs refinements after .url() has failed.
  const permittedUrl = (value: string): URL | null => {
    const url = URL.parse(value);
    const permitted =
      url?.protocol === 'https:' ||
      (url?.protocol === 'http:' && isAllowlisted(url));
    return permitted ? url : null;
  };

  const configSchema = z.object({
    url: z
      .string()
      .url()
      .refine((value) => permittedUrl(value) !== null, {
        message: 'url must be https (http only for allowlisted hosts)',
      }),
    secrets: z.array(z.string().min(MIN_SECRET_LENGTH)).min(1).max(2),
  });

  return {
    id: 'webhook',
    configSchema,
    send(msg, to, config, opts) {
      const url = permittedUrl(config.url);
      if (!url) {
        return Promise.resolve({
          ok: false,
          retryable: false,
          reason: 'blocked url',
        });
      }
      const body = JSON.stringify({
        projectId: msg.meta.projectId,
        profileId: to.profileId,
        channel: 'webhook',
        subject: msg.subject,
        title: msg.title,
        body: msg.body,
        ruleId: msg.meta.ruleId,
        enrollmentId: msg.meta.enrollmentId,
        stepIndex: msg.meta.stepIndex,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers = {
        'content-type': 'application/json',
        'x-nudge-timestamp': timestamp,
        'x-nudge-signature': sign(config.secrets[0] ?? '', timestamp, body),
        'idempotency-key': opts.idempotencyKey,
      };
      return withSendTimeout(timeoutMs, async (signal) => {
        try {
          const status = isAllowlisted(url)
            ? await postAllowlisted(url, { headers, body }, signal)
            : await postPublic(url, { headers, body }, signal, timeoutMs);
          return resultFor(status);
        } catch (error) {
          if (error instanceof BlockedUrlError) {
            return { ok: false, retryable: false, reason: 'blocked url' };
          }
          return { ok: false, retryable: true, reason: 'network error' };
        }
      });
    },
  };
}
