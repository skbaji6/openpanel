import { describe, expect, it } from 'bun:test';
import { getAdapter, registerDefaultAdapters } from './registry';

describe('registerDefaultAdapters', () => {
  it('registers webhook, email and push, passing the webhook allowlist through', () => {
    expect(() => getAdapter('webhook')).toThrow();
    registerDefaultAdapters({ webhookAllowHosts: ['hooks.internal'] });
    expect(getAdapter('email').id).toBe('email');
    expect(getAdapter('push').id).toBe('push');
    const webhook = getAdapter('webhook');
    const secrets = ['0123456789abcdef'];
    expect(
      webhook.configSchema.safeParse({
        url: 'http://hooks.internal/x',
        secrets,
      }).success
    ).toBe(true);
    expect(
      webhook.configSchema.safeParse({
        url: 'http://other.internal/x',
        secrets,
      }).success
    ).toBe(false);
  });
});
