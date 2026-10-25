import { createEmailAdapter } from './email';
import { createPushAdapter } from './push';
import type { ChannelAdapter } from './types';
import { createWebhookAdapter } from './webhook';

const adapters = new Map<string, ChannelAdapter<unknown>>();

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
}
