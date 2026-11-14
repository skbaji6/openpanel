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
  it('defaults the audience source settings and parses overrides', () => {
    const defaults = loadConfig(required);
    expect(defaults.sourceConcurrency).toBe(4);
    expect(defaults.lookupWindowMs).toBe(2000);
    expect(defaults.maxLatenessSeconds).toBe(86_400);
    const custom = loadConfig({
      ...required,
      MARKETING_SOURCE_CONCURRENCY: '2',
      MARKETING_LOOKUP_WINDOW_MS: '500',
      MARKETING_MAX_LATENESS: '60',
    });
    expect([
      custom.sourceConcurrency,
      custom.lookupWindowMs,
      custom.maxLatenessSeconds,
    ]).toEqual([2, 500, 60]);
    expect(() =>
      loadConfig({ ...required, MARKETING_SOURCE_CONCURRENCY: '0' })
    ).toThrow(/MARKETING_SOURCE_CONCURRENCY/);
  });

  it('MARKETING_CONFIRM_THRESHOLD defaults to 5000 and rejects 0', () => {
    expect(loadConfig(required).confirmThreshold).toBe(5000);
    expect(
      loadConfig({ ...required, MARKETING_CONFIRM_THRESHOLD: '200' })
        .confirmThreshold
    ).toBe(200);
    expect(() =>
      loadConfig({ ...required, MARKETING_CONFIRM_THRESHOLD: '0' })
    ).toThrow(/MARKETING_CONFIRM_THRESHOLD/);
  });

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
    expect(() => loadConfig(rest)).toThrow(
      /set DATABASE_URL or MARKETING_DATABASE_URL/
    );
  });

  it('works with only MARKETING_DATABASE_URL set', () => {
    const { DATABASE_URL: _omitted, ...rest } = required;
    const config = loadConfig({
      ...rest,
      MARKETING_DATABASE_URL: 'postgresql://u:p@other:5432/marketing_db',
    });
    expect(new URL(config.databaseUrl).pathname).toBe('/marketing_db');
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

  it('MARKETING_DB_POOL=16 yields connection_limit=16 and replaces an existing connection_limit param', () => {
    const config = loadConfig({
      ...required,
      DATABASE_URL: `${required.DATABASE_URL}?connection_limit=50&schema=public`,
      MARKETING_DB_POOL: '16',
    });
    const url = new URL(config.databaseUrl);
    expect(url.searchParams.getAll('connection_limit')).toEqual(['16']);
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

  it('MARKETING_DB_POOL must leave room for every concurrent send and campaign loop plus 3', () => {
    expect(() =>
      loadConfig({
        ...required,
        MARKETING_DB_POOL: '6',
        MARKETING_SEND_CONCURRENCY: '3',
      })
    ).toThrow(
      /MARKETING_DB_POOL: must be at least MARKETING_SEND_CONCURRENCY \+ MARKETING_CAMPAIGN_CONCURRENCY \+ 3 \(8\)/
    );
    expect(
      loadConfig({
        ...required,
        MARKETING_DB_POOL: '8',
        MARKETING_SEND_CONCURRENCY: '3',
      }).dbPool
    ).toBe(8);
  });

  it('a pool of 14 with defaults is rejected and 15 boots', () => {
    expect(() => loadConfig({ ...required, MARKETING_DB_POOL: '14' })).toThrow(
      /MARKETING_DB_POOL: must be at least .* \(15\)/
    );
    expect(loadConfig({ ...required, MARKETING_DB_POOL: '15' }).dbPool).toBe(
      15
    );
  });

  it('MARKETING_CAMPAIGN_CONCURRENCY defaults to 2, rejects 0 and 33', () => {
    expect(loadConfig(required).campaignConcurrency).toBe(2);
    expect(
      loadConfig({
        ...required,
        MARKETING_CAMPAIGN_CONCURRENCY: '32',
        MARKETING_DB_POOL: '45',
      }).campaignConcurrency
    ).toBe(32);
    for (const value of ['0', '33']) {
      expect(() =>
        loadConfig({
          ...required,
          MARKETING_CAMPAIGN_CONCURRENCY: value,
          MARKETING_DB_POOL: '100',
        })
      ).toThrow(/MARKETING_CAMPAIGN_CONCURRENCY/);
    }
  });

  it('MARKETING_LEASE_SECONDS must exceed the lookup window plus the send timeout plus mark retries', () => {
    expect(() =>
      loadConfig({ ...required, MARKETING_LEASE_SECONDS: '33' })
    ).toThrow(/MARKETING_LEASE_SECONDS: must be greater than 33/);
    expect(
      loadConfig({ ...required, MARKETING_LEASE_SECONDS: '34' }).leaseSeconds
    ).toBe(34);
    expect(() =>
      loadConfig({
        ...required,
        MARKETING_LEASE_SECONDS: '34',
        MARKETING_LOOKUP_WINDOW_MS: '10000',
      })
    ).toThrow(/MARKETING_LEASE_SECONDS: must be greater than 41/);
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
