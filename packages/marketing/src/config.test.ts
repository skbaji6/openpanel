import { describe, expect, it } from 'bun:test';
import { loadConfig } from './config';

const required = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'k'.repeat(32),
  MARKETING_PROXY_SECRET: 'proxy-secret',
  MARKETING_PUBLIC_URL: 'https://marketing.example.com',
  KAFKA_BROKERS: 'localhost:9092',
  KAFKA_EVENTS_TOPIC: 'events',
};

describe('loadConfig', () => {
  it('uses MARKETING_DATABASE_URL when set', () => {
    const config = loadConfig({
      ...required,
      MARKETING_DATABASE_URL: 'postgresql://u:p@other:5432/marketing_db',
    });
    const url = new URL(config.databaseUrl);
    expect(url.host).toBe('other:5432');
    expect(url.pathname).toBe('/marketing_db');
    expect(url.searchParams.get('connection_limit')).toBe('15');
  });

  it('falls back to DATABASE_URL when MARKETING_DATABASE_URL is blank', () => {
    const config = loadConfig({ ...required, MARKETING_DATABASE_URL: ' ' });
    expect(new URL(config.databaseUrl).pathname).toBe('/db');
  });

  it('fails when neither database URL is set', () => {
    const { DATABASE_URL: _omitted, ...rest } = required;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects a MARKETING_DATABASE_URL that is not a URL without echoing it', () => {
    expect(() =>
      loadConfig({ ...required, MARKETING_DATABASE_URL: 'not a url' })
    ).toThrow(/MARKETING_DATABASE_URL: must be a URL/);
  });

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
    expect(config.dbPool).toBe(15);
    expect(config.databaseUrl).toContain('connection_limit=15');
    expect(config.kafka.brokers).toEqual(['localhost:9092']);
    expect(config.kafka.sasl).toBeUndefined();
  });

  it('MARKETING_DB_POOL=13 yields connection_limit=13 and replaces an existing connection_limit param', () => {
    const config = loadConfig({
      ...required,
      DATABASE_URL: `${required.DATABASE_URL}?connection_limit=50&schema=public`,
      MARKETING_DB_POOL: '13',
    });
    const url = new URL(config.databaseUrl);
    expect(url.searchParams.getAll('connection_limit')).toEqual(['13']);
    expect(url.searchParams.get('schema')).toBe('public');
  });

  it('MARKETING_TRUST_PROXY=true trusts x-forwarded-for; a typo throws', () => {
    expect(
      loadConfig({ ...required, MARKETING_TRUST_PROXY: 'true' }).trustProxy
    ).toBe(true);
    expect(() =>
      loadConfig({ ...required, MARKETING_TRUST_PROXY: 'yes' })
    ).toThrow(/MARKETING_TRUST_PROXY/);
  });

  it('MARKETING_PUBLIC_URL must be an http(s) URL and loses its trailing slash', () => {
    expect(
      loadConfig({
        ...required,
        MARKETING_PUBLIC_URL: 'https://n.example.com/',
      }).publicUrl
    ).toBe('https://n.example.com');
    for (const bad of [
      'n.example.com',
      'ftp://n.example.com',
      'javascript:x',
    ]) {
      expect(() =>
        loadConfig({ ...required, MARKETING_PUBLIC_URL: bad })
      ).toThrow(/MARKETING_PUBLIC_URL: must be an http\(s\) URL/);
    }
  });

  it('an unparseable DATABASE_URL fails with a clear message that does not echo it', () => {
    const attempt = () =>
      loadConfig({ ...required, DATABASE_URL: 'host=db password=hunter2' });
    expect(attempt).toThrow(/DATABASE_URL: must be a URL/);
    expect(attempt).not.toThrow(/hunter2/);
  });

  it('MARKETING_DB_POOL must leave room for every concurrent send plus 3', () => {
    expect(() => loadConfig({ ...required, MARKETING_DB_POOL: '12' })).toThrow(
      /MARKETING_DB_POOL: must be at least MARKETING_SEND_CONCURRENCY \+ 3 \(13\)/
    );
    expect(
      loadConfig({
        ...required,
        MARKETING_DB_POOL: '6',
        MARKETING_SEND_CONCURRENCY: '3',
      }).dbPool
    ).toBe(6);
  });

  it('MARKETING_LEASE_SECONDS must exceed the send timeout plus mark retries', () => {
    expect(() =>
      loadConfig({ ...required, MARKETING_LEASE_SECONDS: '31' })
    ).toThrow(/MARKETING_LEASE_SECONDS: must be greater than 31/);
    expect(
      loadConfig({ ...required, MARKETING_LEASE_SECONDS: '32' }).leaseSeconds
    ).toBe(32);
  });

  it('missing KAFKA_EVENTS_TOPIC throws', () => {
    const { KAFKA_EVENTS_TOPIC: _, ...env } = required;
    expect(() => loadConfig(env)).toThrow(/KAFKA_EVENTS_TOPIC/);
  });

  it('blank KEY= is treated as absent', () => {
    expect(() => loadConfig({ ...required, KAFKA_EVENTS_TOPIC: '  ' })).toThrow(
      /KAFKA_EVENTS_TOPIC/
    );
    expect(loadConfig({ ...required, MARKETING_PORT: '' }).port).toBe(4100);
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

  it('MARKETING_WEBHOOK_ALLOW_HOSTS "a.internal, b.internal" parses to two hosts', () => {
    const config = loadConfig({
      ...required,
      MARKETING_WEBHOOK_ALLOW_HOSTS: 'a.internal, b.internal',
    });
    expect(config.webhookAllowHosts).toEqual(['a.internal', 'b.internal']);
  });

  it('MARKETING_WEBHOOK_ALLOW_HOSTS rejects entries with a scheme, port, path or IPv6 literal', () => {
    for (const entry of [
      'https://a.internal',
      'a.internal:8080',
      'a.internal/hook',
      '::1',
    ]) {
      expect(() =>
        loadConfig({
          ...required,
          MARKETING_WEBHOOK_ALLOW_HOSTS: `ok.internal,${entry}`,
        })
      ).toThrow(/MARKETING_WEBHOOK_ALLOW_HOSTS/);
    }
  });
});
