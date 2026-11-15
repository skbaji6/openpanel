import { describe, expect, it } from 'bun:test';
import { linkKey, webhookPath, webhookSecret } from './keys';

const KEY = 'test-encryption-key';

describe('tracking keys', () => {
  it('link keys differ per project and are stable', () => {
    const a = linkKey(KEY, 'proj-a');
    expect(a.length).toBe(32);
    expect(a.equals(linkKey(KEY, 'proj-a'))).toBe(true);
    expect(a.equals(linkKey(KEY, 'proj-b'))).toBe(false);
    expect(a.equals(linkKey('other-key', 'proj-a'))).toBe(false);
  });

  it('the webhook secret is 43 base64url characters and differs per project', () => {
    const a = webhookSecret(KEY, 'proj-a');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).toBe(webhookSecret(KEY, 'proj-a'));
    expect(a).not.toBe(webhookSecret(KEY, 'proj-b'));
    expect(a).not.toBe(linkKey(KEY, 'proj-a').toString('base64url'));
  });

  it('builds the webhook path', () => {
    expect(webhookPath('proj-a', 'abc')).toBe(
      '/marketing/webhooks/msg91/proj-a/abc'
    );
  });
});
