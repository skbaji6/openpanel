import { describe, expect, it } from 'bun:test';
import { linkKey } from './keys';
import {
  LINK_TOKEN_TTL_DAYS,
  MAX_TOKEN_LENGTH,
  openLinkToken,
  sealLinkToken,
} from './token';

const ENCRYPTION_KEY = 'test-encryption-key';
const keyFor = (projectId: string) => linkKey(ENCRYPTION_KEY, projectId);
const NOW = new Date('2026-11-15T00:00:00.000Z');
const MS_PER_DAY = 86_400_000;
const INVALID = { ok: false, reason: 'invalid' } as const;
const target = {
  sourceRef: 'campaign:11111111-2222-3333-4444-555555555555:profile-secret-77',
  linkId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  expiresAt: new Date(NOW.getTime() + LINK_TOKEN_TTL_DAYS * MS_PER_DAY),
};

describe('link tokens', () => {
  it('seal then open returns the target', () => {
    const token = sealLinkToken(keyFor('proj-a'), 'proj-a', target);
    expect(openLinkToken(keyFor, token, NOW)).toEqual({
      ok: true,
      projectId: 'proj-a',
      target,
    });
  });

  it('a flipped byte anywhere is invalid', () => {
    const token = sealLinkToken(keyFor('proj-a'), 'proj-a', target);
    for (let i = 0; i < token.length; i++) {
      const flipped = `${token.slice(0, i)}${token[i] === 'A' ? 'B' : 'A'}${token.slice(i + 1)}`;
      expect(openLinkToken(keyFor, flipped, NOW)).toEqual(INVALID);
    }
  });

  it("a token sealed for project A with B's prefix is invalid", () => {
    const token = sealLinkToken(keyFor('proj-a'), 'proj-a', target);
    const moved = `proj-b${token.slice('proj-a'.length)}`;
    expect(openLinkToken(keyFor, moved, NOW)).toEqual(INVALID);
    // even when both projects share one key, the project id is authenticated
    const shared = Buffer.alloc(32, 1);
    const same = sealLinkToken(shared, 'proj-a', target);
    expect(
      openLinkToken(() => shared, `proj-b${same.slice('proj-a'.length)}`, NOW)
    ).toEqual(INVALID);
  });

  it('an expired token is expired only when its tag verifies', () => {
    const token = sealLinkToken(keyFor('proj-a'), 'proj-a', {
      ...target,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    expect(openLinkToken(keyFor, token, NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
    const last = token.length - 1;
    const tampered = `${token.slice(0, last)}${token[last] === 'A' ? 'B' : 'A'}`;
    expect(openLinkToken(keyFor, tampered, NOW)).toEqual(INVALID);
  });

  it('the token text contains neither the source ref, the profile id nor the link id', () => {
    const token = sealLinkToken(keyFor('proj-a'), 'proj-a', target);
    for (const secret of [
      target.sourceRef,
      'profile-secret-77',
      target.linkId,
    ]) {
      expect(token).not.toContain(secret);
    }
    expect(token.startsWith('proj-a.')).toBe(true);
  });

  it('a 513-character token is invalid without decrypting', () => {
    let called = false;
    const prefix = 'proj-a.';
    const token = prefix + 'A'.repeat(MAX_TOKEN_LENGTH + 1 - prefix.length);
    expect(token).toHaveLength(MAX_TOKEN_LENGTH + 1);
    const result = openLinkToken(
      (projectId) => {
        called = true;
        return keyFor(projectId);
      },
      token,
      NOW
    );
    expect(result).toEqual(INVALID);
    expect(called).toBe(false);
  });

  it('malformed tokens are invalid', () => {
    for (const bad of [
      '',
      'nodot',
      '.abc',
      'proj a.AAAA',
      'proj-a.***',
      'proj-a.AAAA',
    ]) {
      expect(openLinkToken(keyFor, bad, NOW)).toEqual(INVALID);
    }
  });
});
