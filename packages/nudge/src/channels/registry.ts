import type { ChannelAdapter } from './types';

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
