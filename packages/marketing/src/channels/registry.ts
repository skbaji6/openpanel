import type { z } from 'zod';
import { type BatchChannelAdapter, perRecipientBatch } from './batch';
import { createEmailAdapter, createPooledEmailAdapter } from './email';
import { createMsg91SmsAdapter } from './msg91-sms';
import { createMsg91WhatsAppAdapter } from './msg91-whatsapp';
import { createPushAdapter } from './push';
import type { CampaignChannel } from './settings';
import type { ChannelAdapter } from './types';
import { createWebhookAdapter } from './webhook';

const adapters = new Map<string, ChannelAdapter<unknown>>();
const batchAdapters = new Map<string, BatchChannelAdapter<unknown>>();
const PER_RECIPIENT_CHANNELS = new Set<string>(['push', 'email', 'webhook']);

// Registering an id again replaces the earlier adapter.
export function registerAdapter<C>(adapter: ChannelAdapter<C>): void {
  adapters.set(adapter.id, adapter as unknown as ChannelAdapter<unknown>);
}

export function getAdapter(id: string): ChannelAdapter<unknown> {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(`no adapter registered for channel ${id}`);
  }
  return adapter;
}

// Called by the worker at startup; nothing registers at import time.
export function registerDefaultAdapters(options: {
  webhookAllowHosts: string[];
}): void {
  registerAdapter(
    createWebhookAdapter({ allowHosts: options.webhookAllowHosts })
  );
  registerAdapter(createEmailAdapter());
  registerAdapter(createPushAdapter());
  registerBatchAdapter(createPooledEmailAdapter());
  registerBatchAdapter(createMsg91SmsAdapter());
  registerBatchAdapter(createMsg91WhatsAppAdapter());
}

export function registerBatchAdapter<C>(adapter: BatchChannelAdapter<C>): void {
  const replaced = batchAdapters.get(adapter.id);
  if (replaced && replaced !== (adapter as unknown)) {
    replaced.close?.();
  }
  batchAdapters.set(
    adapter.id,
    adapter as unknown as BatchChannelAdapter<unknown>
  );
}

export function closeBatchAdapters(): void {
  for (const adapter of batchAdapters.values()) {
    adapter.close?.();
  }
}

export function unregisterBatchAdapter(channel: CampaignChannel): void {
  batchAdapters.get(channel)?.close?.();
  batchAdapters.delete(channel);
}

// push, email and webhook default to their per-recipient adapter; other channels must register one.
export function getBatchAdapter(
  channel: CampaignChannel
): BatchChannelAdapter<unknown> {
  const registered = batchAdapters.get(channel);
  if (registered) {
    return registered;
  }
  if (PER_RECIPIENT_CHANNELS.has(channel)) {
    return perRecipientBatch(getAdapter(channel));
  }
  throw new Error(`no batch adapter registered for channel ${channel}`);
}

export function configSchemaFor(channel: string): z.ZodType<unknown> {
  return getBatchAdapter(channel as CampaignChannel).configSchema;
}
