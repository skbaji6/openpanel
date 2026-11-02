const DEFAULT_MAX_KEYS = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

// Fixed window per key. The map is capped so a flood of distinct keys cannot exhaust memory;
// the oldest window is evicted first, which at worst resets a counter early.
export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}) {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const windows = new Map<string, Window>();

  function current(key: string): Window | undefined {
    const window = windows.get(key);
    if (window && window.resetAt > now()) {
      return window;
    }
    windows.delete(key);
    return undefined;
  }

  return {
    limited(key: string): boolean {
      return (current(key)?.count ?? 0) >= opts.limit;
    },
    // Counts one hit; false once the key is over its limit for this window.
    take(key: string): boolean {
      let window = current(key);
      if (!window) {
        const oldest = windows.keys().next();
        if (windows.size >= maxKeys && !oldest.done) {
          windows.delete(oldest.value);
        }
        window = { count: 0, resetAt: now() + opts.windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return window.count <= opts.limit;
    },
    size: () => windows.size,
  };
}
