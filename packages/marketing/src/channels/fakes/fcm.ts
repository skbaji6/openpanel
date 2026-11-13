import type { MulticastSender } from '../push';

const INVALID_TOKEN_CODE = 'messaging/registration-token-not-registered';
const MS_PER_SECOND = 1000;

interface FakeFcmOptions {
  latencyMs?: number;
  tokensPerSecond?: number;
  invalidTokens?: Set<string>;
  failCode?: (token: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
}

export type FakeFcm = MulticastSender & {
  calls: number;
  delivered: Map<string, number>;
};

// `delivered` counts per token so a duplicate send is visible.
export function createFakeFcm(options: FakeFcmOptions = {}): FakeFcm {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const state = { calls: 0, delivered: new Map<string, number>() };

  const sender: MulticastSender = async (_json, multicast) => {
    state.calls++;
    const delayMs =
      (options.latencyMs ?? 0) +
      (options.tokensPerSecond
        ? (multicast.tokens.length / options.tokensPerSecond) * MS_PER_SECOND
        : 0);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    return {
      responses: multicast.tokens.map((token) => {
        const failCode = options.failCode?.(token) ?? null;
        if (failCode) {
          return { success: false, error: { code: failCode } };
        }
        if (options.invalidTokens?.has(token)) {
          return { success: false, error: { code: INVALID_TOKEN_CODE } };
        }
        state.delivered.set(token, (state.delivered.get(token) ?? 0) + 1);
        return { success: true };
      }),
    };
  };

  return Object.defineProperties(sender, {
    calls: { get: () => state.calls },
    delivered: { value: state.delivered },
  }) as FakeFcm;
}
