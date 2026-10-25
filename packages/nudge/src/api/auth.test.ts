import { describe, expect, it, spyOn } from 'bun:test';
import crypto from 'node:crypto';
import { secretsMatch } from './auth';
import {
  createUnsubscribeUrlRenderer,
  signUnsubscribeToken,
  unsubscribeKey,
  verifyUnsubscribeToken,
} from './unsubscribe';

const ENCRYPTION_KEY = 'ab'.repeat(32);
const KEY = unsubscribeKey(ENCRYPTION_KEY);
const TARGET = {
  projectId: 'proj-a',
  profileId: 'user|with|pipes',
  channel: 'email',
} as const;

describe('secretsMatch', () => {
  it('SECURITY proxy-secret comparison is constant time', () => {
    const spy = spyOn(crypto, 'timingSafeEqual');
    expect(secretsMatch('short', 'a-much-longer-expected-secret')).toBe(false);
    expect(secretsMatch('same-secret', 'same-secret')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('unsubscribe token', () => {
  it('a token with "|" in the profile id round-trips', () => {
    const token = signUnsubscribeToken(KEY, TARGET);
    expect(verifyUnsubscribeToken(KEY, token)).toEqual(TARGET);
  });

  it('a tampered token is rejected', () => {
    const token = signUnsubscribeToken(KEY, TARGET);
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
    decoded[1] = 'someone-else';
    const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    expect(verifyUnsubscribeToken(KEY, forged)).toBeNull();
    expect(verifyUnsubscribeToken(KEY, `${token}x`)).toBeNull();
    expect(verifyUnsubscribeToken(KEY, 'not-a-token')).toBeNull();
    expect(verifyUnsubscribeToken(KEY, 'a'.repeat(10_000))).toBeNull();
  });

  it('SECURITY a token signed with ENCRYPTION_KEY directly (not the HKDF-derived key) is rejected', () => {
    const fields = [TARGET.projectId, TARGET.profileId, TARGET.channel];
    const mac = crypto
      .createHmac('sha256', ENCRYPTION_KEY)
      .update(JSON.stringify(fields))
      .digest('base64url');
    const token = Buffer.from(JSON.stringify([...fields, mac])).toString(
      'base64url'
    );
    expect(verifyUnsubscribeToken(KEY, token)).toBeNull();
    expect(KEY.equals(Buffer.from(ENCRYPTION_KEY))).toBe(false);
  });

  it('the URL the ticker renders carries a token that verifies', () => {
    const render = createUnsubscribeUrlRenderer({
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: 'https://nudge.test/',
    });
    const url = new URL(render('proj-a', 'user|with|pipes', 'email'));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://nudge.test/nudge/unsubscribe'
    );
    expect(verifyUnsubscribeToken(KEY, url.searchParams.get('t'))).toEqual(
      TARGET
    );
  });
});
