import { SourceUnavailableError } from './errors';

interface BreakerOptions {
  failureThreshold: number;
  openMs: number;
  now?: () => number;
}

export function createBreaker(options: BreakerOptions) {
  const now = options.now ?? Date.now;
  let failures = 0;
  let openedAt: number | null = null;
  let probing = false;

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      let isProbe = false;
      if (openedAt !== null) {
        const cooledDown = now() - openedAt >= options.openMs;
        if (!cooledDown || probing) {
          throw new SourceUnavailableError('breaker_open');
        }
        probing = true;
        isProbe = true;
      }

      try {
        const result = await fn();
        failures = 0;
        openedAt = null;
        return result;
      } catch (error) {
        // Auth/protocol and unknown errors leave the failure count unchanged.
        if (error instanceof SourceUnavailableError) {
          failures += 1;
          if (isProbe || failures >= options.failureThreshold) {
            openedAt = now();
          }
        }
        throw error;
      } finally {
        if (isProbe) {
          probing = false;
        }
      }
    },
  };
}
