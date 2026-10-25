import { describe, expect, it } from 'bun:test';
import { loadConfig } from './config';

const required = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'k'.repeat(32),
  NUDGE_PROXY_SECRET: 'proxy-secret',
  NUDGE_PUBLIC_URL: 'https://nudge.example.com',
  KAFKA_BROKERS: 'localhost:9092',
  KAFKA_EVENTS_TOPIC: 'events',
};

describe('loadConfig', () => {
  it('defaults apply when only required env is set', () => {
    const config = loadConfig(required);
    expect(config.graceSeconds).toBe(300);
    expect(config.maxLag).toBe(1000);
    expect(config.tickMs).toBe(5000);
    expect(config.leaseSeconds).toBe(120);
    expect(config.retentionDays).toBe(30);
    expect(config.port).toBe(4100);
    expect(config.trustProxy).toBe(false);
    expect(config.claimBatch).toBe(200);
    expect(config.sendConcurrency).toBe(10);
    expect(config.dbPool).toBe(10);
    expect(config.databaseUrl).toContain('connection_limit=10');
    expect(config.kafka.brokers).toEqual(['localhost:9092']);
    expect(config.kafka.sasl).toBeUndefined();
  });

  it('NUDGE_DB_POOL=3 yields connection_limit=3 and replaces an existing connection_limit param', () => {
    const config = loadConfig({
      ...required,
      DATABASE_URL: `${required.DATABASE_URL}?connection_limit=50&schema=public`,
      NUDGE_DB_POOL: '3',
    });
    const url = new URL(config.databaseUrl);
    expect(url.searchParams.getAll('connection_limit')).toEqual(['3']);
    expect(url.searchParams.get('schema')).toBe('public');
  });

  it('NUDGE_TRUST_PROXY=true trusts x-forwarded-for; a typo throws', () => {
    expect(
      loadConfig({ ...required, NUDGE_TRUST_PROXY: 'true' }).trustProxy
    ).toBe(true);
    expect(() => loadConfig({ ...required, NUDGE_TRUST_PROXY: 'yes' })).toThrow(
      /NUDGE_TRUST_PROXY/
    );
  });

  it('missing KAFKA_EVENTS_TOPIC throws', () => {
    const { KAFKA_EVENTS_TOPIC: _, ...env } = required;
    expect(() => loadConfig(env)).toThrow(/KAFKA_EVENTS_TOPIC/);
  });

  it('blank KEY= is treated as absent', () => {
    expect(() => loadConfig({ ...required, KAFKA_EVENTS_TOPIC: '  ' })).toThrow(
      /KAFKA_EVENTS_TOPIC/
    );
    expect(loadConfig({ ...required, NUDGE_PORT: '' }).port).toBe(4100);
  });

  it('KAFKA_SASL_USERNAME without password throws', () => {
    expect(() =>
      loadConfig({ ...required, KAFKA_SASL_USERNAME: 'user' })
    ).toThrow(/KAFKA_SASL_PASSWORD/);
  });

  it('builds sasl when both credentials are set', () => {
    const config = loadConfig({
      ...required,
      KAFKA_SASL_USERNAME: 'user',
      KAFKA_SASL_PASSWORD: 'pass',
    });
    expect(config.kafka.sasl).toEqual({
      mechanism: 'scram-sha-512',
      username: 'user',
      password: 'pass',
    });
    expect(config.kafka.ssl).toBeTruthy();
  });

  it('NUDGE_WEBHOOK_ALLOW_HOSTS "a.internal, b.internal" parses to two hosts', () => {
    const config = loadConfig({
      ...required,
      NUDGE_WEBHOOK_ALLOW_HOSTS: 'a.internal, b.internal',
    });
    expect(config.webhookAllowHosts).toEqual(['a.internal', 'b.internal']);
  });

  it('NUDGE_WEBHOOK_ALLOW_HOSTS rejects entries with a scheme, port, path or IPv6 literal', () => {
    for (const entry of [
      'https://a.internal',
      'a.internal:8080',
      'a.internal/hook',
      '::1',
    ]) {
      expect(() =>
        loadConfig({
          ...required,
          NUDGE_WEBHOOK_ALLOW_HOSTS: `ok.internal,${entry}`,
        })
      ).toThrow(/NUDGE_WEBHOOK_ALLOW_HOSTS/);
    }
  });
});
