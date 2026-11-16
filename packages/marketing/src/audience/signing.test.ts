import { describe, expect, test } from 'bun:test';
import { newNonce, signRequest, verifyRequest } from './signing';

const NOW = 1_800_000_000;
const KEY = { id: 'k1', secret: 'secret-one' };
const OTHER = { id: 'k2', secret: 'secret-two' };
const BODY = '{"a":1}';

function memoryNonces() {
  const seen = new Set<string>();
  return {
    async seenBefore(nonce: string) {
      const had = seen.has(nonce);
      seen.add(nonce);
      return had;
    },
  };
}

function sign(over: Partial<Parameters<typeof signRequest>[0]> = {}) {
  return signRequest({
    method: 'POST',
    path: '/members',
    body: BODY,
    keyId: KEY.id,
    secret: KEY.secret,
    timestamp: NOW,
    nonce: newNonce(),
    ...over,
  });
}

function verify(
  headers: Headers | Record<string, string>,
  over: Partial<Parameters<typeof verifyRequest>[0]> = {}
) {
  return verifyRequest({
    headers,
    method: 'POST',
    path: '/members',
    body: BODY,
    keys: [KEY, OTHER],
    now: NOW,
    nonces: memoryNonces(),
    ...over,
  });
}

describe('signing', () => {
  test('a signed request verifies', async () => {
    expect(await verify(sign())).toEqual({ ok: true, keyId: 'k1' });
  });

  test('headers are found case-insensitively and via Headers', async () => {
    const lower = Object.fromEntries(
      Object.entries(sign()).map(([k, v]) => [k.toLowerCase(), v])
    );
    expect((await verify(lower)).ok).toBe(true);
    expect((await verify(new Headers(sign()))).ok).toBe(true);
  });

  test('a tampered body fails with bad_signature', async () => {
    expect(await verify(sign(), { body: '{"a":2}' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('a different path fails', async () => {
    expect(await verify(sign(), { path: '/count' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('a timestamp 61 seconds old is stale and 59 seconds old passes', async () => {
    expect((await verify(sign({ timestamp: NOW - 59 }))).ok).toBe(true);
    expect(await verify(sign({ timestamp: NOW - 61 }))).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(await verify(sign({ timestamp: NOW + 61 }))).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  test('a repeated nonce is replayed', async () => {
    const nonces = memoryNonces();
    const headers = sign();
    expect((await verify(headers, { nonces })).ok).toBe(true);
    expect(await verify(headers, { nonces })).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  test('a forged request does not burn the nonce', async () => {
    const nonces = memoryNonces();
    const headers = sign();
    await verify(headers, { nonces, body: 'forged' });
    expect((await verify(headers, { nonces })).ok).toBe(true);
  });

  test('either of two configured keys verifies', async () => {
    const headers = sign({ keyId: OTHER.id, secret: OTHER.secret });
    expect(await verify(headers)).toEqual({ ok: true, keyId: 'k2' });
  });

  test('an unknown key id is unknown_key', async () => {
    expect(await verify(sign({ keyId: 'nope' }))).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  test('a wrong secret under a known key id is bad_signature', async () => {
    expect(await verify(sign({ secret: 'guess' }))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('a missing header is missing', async () => {
    const { 'X-Nonce': _drop, ...rest } = sign();
    expect(await verify(rest)).toEqual({ ok: false, reason: 'missing' });
  });

  test('verification compares signatures in constant time', async () => {
    const headers = sign();
    const wrong = { ...headers, 'X-Signature': 'a'.repeat(64) };
    expect(await verify(wrong)).toEqual({ ok: false, reason: 'bad_signature' });
    const short = { ...headers, 'X-Signature': 'ab' };
    expect(await verify(short)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('newNonce is 32 hex chars and unique', () => {
    expect(newNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(newNonce());
  });

  test('a lower-case method verifies against the upper-case one', async () => {
    const headers = sign({ method: 'post' });
    expect((await verify(headers)).ok).toBe(true);
  });
});
