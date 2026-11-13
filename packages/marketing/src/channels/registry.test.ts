import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  configSchemaFor,
  getAdapter,
  getBatchAdapter,
  registerBatchAdapter,
  registerDefaultAdapters,
  unregisterBatchAdapter,
} from './registry';

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

  it('registers the sms batch adapter by default', () => {
    registerDefaultAdapters({ webhookAllowHosts: [] });
    expect(getBatchAdapter('sms').id).toBe('sms');
    expect(
      configSchemaFor('sms').safeParse({ authKey: 'key-0123456789' }).success
    ).toBe(true);
  });

  it("getBatchAdapter('sms') throws until registered", () => {
    unregisterBatchAdapter('sms');
    expect(() => getBatchAdapter('sms')).toThrow();
    registerBatchAdapter({
      id: 'sms',
      configSchema: z.object({}),
      maxBatch: 1,
      sendBatch: () => Promise.resolve([]),
    });
    expect(getBatchAdapter('sms').id).toBe('sms');
    unregisterBatchAdapter('sms');
  });

  it("configSchemaFor('push') is the push config schema", () => {
    registerDefaultAdapters({ webhookAllowHosts: [] });
    expect(configSchemaFor('push')).toBe(getAdapter('push').configSchema);
  });
});
