import type { SendResult } from './types';

// The ticker's lease must exceed this plus its mark budget, or a slow send is reclaimed and sent twice.
export const SEND_TIMEOUT_MS = 30_000;

export const TIMEOUT_RESULT: SendResult = {
  ok: false,
  retryable: true,
  reason: 'timeout',
};

// A total deadline: at `timeoutMs` the signal aborts and `onTimeout` decides the result.
// Work must honour the signal (stop, destroy its sockets), because a 'timeout' result is retried
// and anything it still delivers afterwards would reach the user twice.
export async function withSendTimeout(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<SendResult>,
  onTimeout: () => SendResult = () => TIMEOUT_RESULT
): Promise<SendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(onTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
