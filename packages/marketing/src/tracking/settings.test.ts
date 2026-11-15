import { beforeEach, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import {
  createTrackingSettingsCache,
  DEFAULT_TRACKING_SETTINGS,
  getTrackingSettings,
  putTrackingSettings,
  zBaseUrl,
  zTrackingSettings,
} from './settings';

beforeEach(async () => {
  await migrate();
  await resetMarketingTables();
});

describe('tracking settings', () => {
  it('defaults when no row', async () => {
    expect(await getTrackingSettings(sql, 'proj-a')).toEqual(
      DEFAULT_TRACKING_SETTINGS
    );
  });

  it('zBaseUrl rejects http on a public host, a path, a query, credentials, and keeps the origin of https://campaign.sianext.com/', () => {
    for (const bad of [
      'http://campaign.sianext.com',
      'https://campaign.sianext.com/path',
      'https://campaign.sianext.com/?a=1',
      'https://campaign.sianext.com/#x',
      'https://user:pass@campaign.sianext.com',
      'https://user@campaign.sianext.com',
      'ftp://campaign.sianext.com',
      'javascript:alert(1)',
      'campaign.sianext.com',
      'https://campaign.sianext.com\\@evil.test',
      `https://${'a'.repeat(200)}.com`,
    ]) {
      expect(zBaseUrl.safeParse(bad).success).toBe(false);
    }
    expect(zBaseUrl.parse('https://campaign.sianext.com/')).toBe(
      'https://campaign.sianext.com'
    );
    expect(zBaseUrl.parse(' https://Campaign.sianext.com:8443 ')).toBe(
      'https://campaign.sianext.com:8443'
    );
    expect(zBaseUrl.parse('http://localhost:3000')).toBe(
      'http://localhost:3000'
    );
    expect(zBaseUrl.parse('http://127.0.0.1:3000/')).toBe(
      'http://127.0.0.1:3000'
    );
  });

  it('validates the other fields strictly', () => {
    const ok = { ...DEFAULT_TRACKING_SETTINGS };
    expect(zTrackingSettings.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, conversionWindowDays: 0 },
      { ...ok, conversionWindowDays: 31 },
      { ...ok, conversionWindowDays: 1.5 },
      { ...ok, conversionEvent: '  ' },
      { ...ok, extra: 1 },
    ]) {
      expect(zTrackingSettings.safeParse(bad).success).toBe(false);
    }
  });

  it('a row saved before conversionWindowDays existed reads back with the default', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.project_settings (project_id, tracking)
       VALUES ('proj-a', '{"publicUrl":"https://x.example.com","campaignUrl":null,"conversionEvent":"paid"}'::jsonb)`
    );
    expect(await getTrackingSettings(sql, 'proj-a')).toEqual({
      publicUrl: 'https://x.example.com',
      campaignUrl: null,
      conversionEvent: 'paid',
      conversionWindowDays: 7,
    });
  });

  it('put upserts without touching the other project settings columns', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.project_settings (project_id, caps) VALUES ('proj-a', '{"x":1}'::jsonb)`
    );
    const settings = { ...DEFAULT_TRACKING_SETTINGS, conversionEvent: 'paid' };
    await putTrackingSettings(sql, 'proj-a', settings);
    await putTrackingSettings(sql, 'proj-a', settings);
    expect(await getTrackingSettings(sql, 'proj-a')).toEqual(settings);
    const [row] = await sql.$queryRawUnsafe<{ caps: unknown }[]>(
      `SELECT caps FROM marketing.project_settings WHERE project_id = 'proj-a'`
    );
    expect(row?.caps).toEqual({ x: 1 });
  });

  it('the cache serves within the ttl, then reloads, and peek is warm after get', async () => {
    let clock = 0;
    const cache = createTrackingSettingsCache({
      sql,
      ttlMs: 1000,
      now: () => clock,
    });
    expect(cache.peek('proj-a')).toBeUndefined();
    expect((await cache.get('proj-a')).conversionEvent).toBeNull();
    await putTrackingSettings(sql, 'proj-a', {
      ...DEFAULT_TRACKING_SETTINGS,
      conversionEvent: 'paid',
    });
    clock = 500;
    expect((await cache.get('proj-a')).conversionEvent).toBeNull();
    clock = 1500;
    expect((await cache.get('proj-a')).conversionEvent).toBe('paid');
    expect(cache.peek('proj-a')?.conversionEvent).toBe('paid');
  });
});
