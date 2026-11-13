import type { z } from 'zod';
import type { TemplateVersion } from '../templates/registry';
import type { CampaignChannel } from './settings';
import type {
  ChannelAdapter,
  Recipient,
  RenderedMessage,
  SendResult,
} from './types';

const PER_RECIPIENT_MAX_BATCH = 500;
const EXCEPTION_REASON = 'exception';
const DEADLINE_REASON = 'deadline';
const UNSUPPORTED_REASON = 'unsupported message';

export interface ProviderMessage {
  kind: 'provider';
  version: TemplateVersion;
  variables: { slot: string; value: string }[];
}

export interface BatchItem {
  profileId: string;
  to: Recipient;
  message: RenderedMessage | ProviderMessage;
  idempotencyKey: string;
  unsubscribeUrl: string;
}

export interface DeliveryOutcome {
  profileId: string;
  // retry: certainly not accepted, back to pending. rate_limited: also back the channel off.
  // channel_error: credentials rejected, also back the campaign off.
  outcome:
    | 'sent'
    | 'failed'
    | 'uncertain'
    | 'retry'
    | 'rate_limited'
    | 'channel_error';
  reason?: string;
  providerRef?: string;
  invalidTokens?: string[];
  retryAfterMs?: number;
}

export interface BatchChannelAdapter<C> {
  id: CampaignChannel;
  configSchema: z.ZodType<C>;
  maxBatch: number;
  // Exactly one outcome per item, in any order.
  sendBatch(
    items: BatchItem[],
    config: C,
    opts: { concurrency: number; signal?: AbortSignal; deadlineAt?: number }
  ): Promise<DeliveryOutcome[]>;
}

// Reasons are the adapters' own strings. The adapters mark some of them non-retryable,
// so they are matched before the retryable flag.
const RATE_LIMITED_REASONS = new Set([
  'fcm messaging/quota-exceeded',
  'fcm messaging/message-rate-exceeded',
  'http 429',
  'smtp 421',
  'smtp 450',
  'smtp 451',
  'smtp 452',
]);
const CHANNEL_ERROR_REASONS = new Set([
  'fcm app/invalid-credential',
  'smtp EAUTH',
  'http 401',
  'http 403',
]);
// Nothing was sent. The webhook's 'network error' is left out: it also covers resets after the request was written.
const RETRY_REASONS = new Set(['smtp ECONNREFUSED', 'smtp EDNS']);

export function classifySendResult(
  result: SendResult
): Omit<DeliveryOutcome, 'profileId'> {
  const { invalidTokens } = result;
  const extra = invalidTokens ? { invalidTokens } : {};
  if (result.ok) {
    return { outcome: 'sent', ...extra };
  }
  const { reason } = result;
  if (RATE_LIMITED_REASONS.has(reason)) {
    return { outcome: 'rate_limited', reason, ...extra };
  }
  if (CHANNEL_ERROR_REASONS.has(reason)) {
    return { outcome: 'channel_error', reason, ...extra };
  }
  if (RETRY_REASONS.has(reason)) {
    return { outcome: 'retry', reason, ...extra };
  }
  const outcome = result.retryable ? 'uncertain' : 'failed';
  return { outcome, reason, ...extra };
}

function isProviderMessage(
  message: RenderedMessage | ProviderMessage
): message is ProviderMessage {
  return 'kind' in message;
}

export function perRecipientBatch<C>(
  adapter: ChannelAdapter<C>,
  now: () => number = Date.now
): BatchChannelAdapter<C> {
  return {
    id: adapter.id,
    configSchema: adapter.configSchema,
    maxBatch: PER_RECIPIENT_MAX_BATCH,
    async sendBatch(items, config, opts) {
      const outcomes: DeliveryOutcome[] = [];
      let next = 0;
      const mustStop = () =>
        opts.signal?.aborted === true ||
        (opts.deadlineAt !== undefined && now() >= opts.deadlineAt);

      const sendOne = async (item: BatchItem): Promise<DeliveryOutcome> => {
        const { profileId } = item;
        if (mustStop()) {
          return { profileId, outcome: 'retry', reason: DEADLINE_REASON };
        }
        if (isProviderMessage(item.message)) {
          return { profileId, outcome: 'failed', reason: UNSUPPORTED_REASON };
        }
        try {
          const result = await adapter.send(item.message, item.to, config, {
            idempotencyKey: item.idempotencyKey,
            unsubscribeUrl: item.unsubscribeUrl,
          });
          return { profileId, ...classifySendResult(result) };
        } catch {
          return { profileId, outcome: 'uncertain', reason: EXCEPTION_REASON };
        }
      };

      const worker = async () => {
        while (next < items.length) {
          const item = items[next++];
          if (item) {
            outcomes.push(await sendOne(item));
          }
        }
      };
      const workers = Math.max(1, Math.min(opts.concurrency, items.length));
      await Promise.all(Array.from({ length: workers }, worker));
      return outcomes;
    },
  };
}
