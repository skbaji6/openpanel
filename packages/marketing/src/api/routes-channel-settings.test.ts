import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import {
  DEFAULT_CHANNEL_SETTINGS,
  getChannelSettings,
} from '../channels/settings';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createServer } from './server';

const PROXY_SECRET = 'proxy-secret-for-tests';
const BASE = 'http://marketing.internal';
const CREDENTIAL = 'sk-live-super-secret-credential-value';

const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  MARKETING_PROXY_SECRET: PROXY_SECRET,
  MARKETING_PUBLIC_URL: 'https://marketing.test',
});
// No redis or sources: the settings routes must not depend on them.
const app = createServer({ cfg, sql });

function call(
  method: string,
  path: string,
  options: { body?: unknown; project?: string; secret?: boolean } = {}
) {
  const hasJson = options.body !== undefined;
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(hasJson ? { 'content-type': 'application/json' } : {}),
        ...(options.secret === false
          ? {}
          : {
              'x-marketing-proxy-secret': PROXY_SECRET,
              'x-marketing-project-id': options.project ?? 'proj-a',
              'x-marketing-user-id': 'user-1',
              'x-marketing-csrf': '1',
            }),
      },
      body: hasJson ? JSON.stringify(options.body) : undefined,
    })
  );
}

const put = (
  channel: string,
  settings: unknown,
  expectedVersion: number,
  project?: string
) =>
  call('PUT', `/marketing/channels/${channel}/settings`, {
    body: { settings, expectedVersion },
    project,
  });

function storeRaw(channel: string, settings: unknown) {
  return sql.$executeRawUnsafe(
    `INSERT INTO marketing.channel_settings (project_id, channel, settings) VALUES ('proj-a', $1, $2::jsonb)`,
    channel,
    JSON.stringify(settings)
  );
}

const SMS = { ...DEFAULT_CHANNEL_SETTINGS.sms, ratePerSecond: 5 };

beforeAll(async () => {
  await migrate();
});
beforeEach(resetMarketingTables);
afterAll(() => sql.$disconnect());

describe('channel settings routes', () => {
  it('GET before any PUT returns defaults, version 0, configured false', async () => {
    const res = await call('GET', '/marketing/channels/sms/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      channel: 'sms',
      settings: DEFAULT_CHANNEL_SETTINGS.sms,
      version: 0,
      configured: false,
      issues: ['rate_required'],
    });
  });

  it('PUT then GET round-trips with version 1', async () => {
    const saved = await put('sms', SMS, 0);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ version: 1, configured: true });
    const res = await call('GET', '/marketing/channels/sms/settings');
    expect(await res.json()).toEqual({
      channel: 'sms',
      settings: SMS,
      version: 1,
      configured: true,
      issues: [],
    });
    const again = await put('sms', { ...SMS, concurrency: 7 }, 1);
    expect(((await again.json()) as { version: number }).version).toBe(2);
  });

  it('a stale expectedVersion is 409 version_conflict', async () => {
    await put('sms', SMS, 0);
    for (const stale of [0, 5]) {
      const res = await put('sms', SMS, stale);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        'version_conflict'
      );
    }
  });

  it('saves settings that still have blocking issues', async () => {
    const res = await put('sms', DEFAULT_CHANNEL_SETTINGS.sms, 0);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issues: string[] }).issues).toEqual([
      'rate_required',
    ]);
  });

  it('rejects unsupported consent and quota with 400 invalid_settings', async () => {
    const consent = await put(
      'push',
      { ...DEFAULT_CHANNEL_SETTINGS.push, requireConsent: true },
      0
    );
    expect(consent.status).toBe(400);
    const body = (await consent.json()) as { error: string };
    expect(body.error).toBe('invalid_settings');
    expect(JSON.stringify(body)).toContain('consent_not_supported');
    const quota = await put('sms', { ...SMS, dailyQuota: 10 }, 0);
    expect(quota.status).toBe(400);
    expect(JSON.stringify(await quota.json())).toContain('quota_not_supported');
    const none = await call('GET', '/marketing/channels/push/settings');
    expect(((await none.json()) as { version: number }).version).toBe(0);
  });

  it('PUT with an unknown field is 400', async () => {
    const res = await put('sms', { ...SMS, extra: 1 }, 0);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'invalid_body'
    );
    const top = await call('PUT', '/marketing/channels/sms/settings', {
      body: { settings: SMS, expectedVersion: 0, extra: 1 },
    });
    expect(top.status).toBe(400);
    const bad = await put('sms', SMS, -1);
    expect(bad.status).toBe(400);
  });

  it('GET /marketing/channels/fax/settings is 404', async () => {
    expect((await call('GET', '/marketing/channels/fax/settings')).status).toBe(
      404
    );
    expect((await put('fax', SMS, 0)).status).toBe(404);
  });

  it("project A cannot read project B's settings", async () => {
    await put('sms', SMS, 0, 'proj-b');
    const res = await call('GET', '/marketing/channels/sms/settings', {
      project: 'proj-a',
    });
    const body = (await res.json()) as { version: number; configured: boolean };
    expect(body.version).toBe(0);
    expect(body.configured).toBe(false);
    // The same version token in another project must not fence or overwrite B.
    const crossWrite = await put(
      'sms',
      { ...SMS, concurrency: 9 },
      1,
      'proj-a'
    );
    expect(crossWrite.status).toBe(409);
    const b = await call('GET', '/marketing/channels/sms/settings', {
      project: 'proj-b',
    });
    expect(
      ((await b.json()) as { settings: { concurrency: number } }).settings
        .concurrency
    ).toBe(SMS.concurrency);
  });

  it('requires dashboard auth', async () => {
    const get = await call('GET', '/marketing/channels/sms/settings', {
      secret: false,
    });
    expect(get.status).toBe(401);
    const write = await call('PUT', '/marketing/channels/sms/settings', {
      secret: false,
      body: { settings: SMS, expectedVersion: 0 },
    });
    expect(write.status).toBe(401);
  });

  it('never returns or logs a stored channel credential', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ('proj-a', 'sms', $1)`,
      CREDENTIAL
    );
    const spies = (['log', 'error', 'warn', 'info'] as const).map((level) =>
      spyOn(console, level)
    );
    try {
      const get = await call('GET', '/marketing/channels/sms/settings');
      const saved = await put('sms', SMS, 0);
      const bad = await put('sms', { ...SMS, extra: CREDENTIAL }, 1);
      const texts = [await get.text(), await saved.text(), await bad.text()];
      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map(String);
      for (const text of [...texts, ...logged]) {
        expect(text).not.toContain(CREDENTIAL);
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it('a stored row missing a newer key reads back with its default', async () => {
    const { ratePerSecond: _rate, ...older } = SMS;
    await storeRaw('sms', older);
    const read = await getChannelSettings(sql, 'proj-a', 'sms');
    expect(read.settings).toEqual({ ...SMS, ratePerSecond: null });
    expect(read.version).toBe(1);
  });

  it('a stored row with an unknown key fails loudly', async () => {
    await storeRaw('sms', { ...SMS, retired: 1 });
    await expect(getChannelSettings(sql, 'proj-a', 'sms')).rejects.toThrow();
  });

  it('quiet hours with start equal to end are 400 invalid_body', async () => {
    const res = await put(
      'sms',
      {
        ...SMS,
        quietHours: {
          ...SMS.quietHours,
          enabled: true,
          end: SMS.quietHours.start,
        },
      },
      0
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'invalid_body'
    );
  });
});
