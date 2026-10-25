import type { SendResult } from './types';

// The ticker's lease must exceed this plus its mark budget, or a slow send is reclaimed and sent twice.
export const SEND_TIMEOUT_MS = 30_000;

export const TIMEOUT_RESULT: SendResult = {
  ok: false,
  retryable: true,
  reason: 'timeout',
};

// Resolves to TIMEOUT_RESULT after `timeoutMs`; the signal lets work that supports it (fetch) abort too.
export async function withSendTimeout(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<SendResult>
): Promise<SendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMEOUT_RESULT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
