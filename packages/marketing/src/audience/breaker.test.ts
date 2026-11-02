import { describe, expect, it } from 'bun:test';
import { createBreaker } from './breaker';
import {
  SourceAuthError,
  SourceProtocolError,
  SourceUnavailableError,
} from './errors';

const THRESHOLD = 5;
const OPEN_MS = 30_000;

function setup() {
  let now = 0;
  const breaker = createBreaker({
    failureThreshold: THRESHOLD,
    openMs: OPEN_MS,
    now: () => now,
  });
  return {
    breaker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const fail = () => Promise.reject(new SourceUnavailableError('down'));

async function trip(breaker: ReturnType<typeof setup>['breaker']) {
  for (let i = 0; i < THRESHOLD; i += 1) {
    await breaker.run(fail).catch(() => undefined);
  }
}

describe('breaker', () => {
  it('opens after five failures', async () => {
    const { breaker } = setup();
    await trip(breaker);
    let called = false;
    const error = await breaker
      .run(() => {
        called = true;
        return Promise.resolve(1);
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error.message).toBe('breaker_open');
    expect(called).toBe(false);
  });

  it('half-opens after 30 seconds and closes on success', async () => {
    const { breaker, advance } = setup();
    await trip(breaker);
    advance(OPEN_MS);
    expect(await breaker.run(() => Promise.resolve('ok'))).toBe('ok');
    expect(await breaker.run(() => Promise.resolve('again'))).toBe('again');
  });

  it('allows only one probe and reopens when it fails', async () => {
    const { breaker, advance } = setup();
    await trip(breaker);
    advance(OPEN_MS);
    let release: () => void = () => undefined;
    const probe = breaker.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('ok');
        })
    );
    const concurrent = await breaker
      .run(() => Promise.resolve(1))
      .catch((e) => e);
    expect(concurrent.message).toBe('breaker_open');
    release();
    await probe;

    await trip(breaker); // closed again: five more failures reopen
    advance(OPEN_MS);
    await breaker.run(fail).catch(() => undefined);
    const after = await breaker.run(() => Promise.resolve(1)).catch((e) => e);
    expect(after.message).toBe('breaker_open');
    advance(OPEN_MS);
    expect(await breaker.run(() => Promise.resolve(2))).toBe(2);
  });

  it('an auth error does not count', async () => {
    const { breaker } = setup();
    for (let i = 0; i < THRESHOLD * 2; i += 1) {
      await breaker
        .run(() => Promise.reject(new SourceAuthError('401')))
        .catch(() => undefined);
      await breaker
        .run(() => Promise.reject(new SourceProtocolError('bad')))
        .catch(() => undefined);
    }
    expect(await breaker.run(() => Promise.resolve('ok'))).toBe('ok');
  });

  it('a success resets the consecutive failure count', async () => {
    const { breaker } = setup();
    for (let i = 0; i < THRESHOLD - 1; i += 1) {
      await breaker.run(fail).catch(() => undefined);
    }
    await breaker.run(() => Promise.resolve(1));
    await breaker.run(fail).catch(() => undefined);
    expect(await breaker.run(() => Promise.resolve('ok'))).toBe('ok');
  });

  it('a probe that throws a non-counted error does not wedge the breaker', async () => {
    const { breaker, advance } = setup();
    await trip(breaker);
    advance(OPEN_MS);
    const error = await breaker
      .run(() => Promise.reject(new SourceAuthError('401')))
      .catch((e) => e);
    expect(error).toBeInstanceOf(SourceAuthError);
    expect(await breaker.run(() => Promise.resolve('ok'))).toBe('ok');
    expect(await breaker.run(() => Promise.resolve('closed'))).toBe('closed');
  });
});
