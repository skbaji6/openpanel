import { describe, expect, it } from 'bun:test';
import { createRateLimiter } from './rate-limit';

const WINDOW_MS = 60_000;

describe('createRateLimiter', () => {
  it('allows 30 then rejects the 31st within the window and allows again after the window', () => {
    let clock = 0;
    const limiter = createRateLimiter({
      limit: 30,
      windowMs: WINDOW_MS,
      now: () => clock,
    });
    for (let attempt = 0; attempt < 30; attempt++) {
      expect(limiter.take('1.2.3.4')).toBe(true);
    }
    expect(limiter.limited('1.2.3.4')).toBe(true);
    expect(limiter.take('1.2.3.4')).toBe(false);
    clock += WINDOW_MS;
    expect(limiter.limited('1.2.3.4')).toBe(false);
    expect(limiter.take('1.2.3.4')).toBe(true);
  });

  it('keys are independent', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS });
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
  });

  it('SECURITY stays bounded in size under many distinct keys, evicting the oldest', () => {
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: WINDOW_MS,
      maxKeys: 100,
    });
    limiter.take('first');
    for (let key = 0; key < 10_000; key++) {
      limiter.take(`ip-${key}`);
    }
    expect(limiter.size()).toBe(100);
    expect(limiter.limited('first')).toBe(false);
    expect(limiter.limited('ip-9999')).toBe(true);
  });
});
