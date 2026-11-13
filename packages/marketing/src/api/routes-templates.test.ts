import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createServer } from './server';

const PROXY_SECRET = 'proxy-secret-for-tests';
const BASE = 'http://marketing.internal';

const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  MARKETING_PROXY_SECRET: PROXY_SECRET,
  MARKETING_PUBLIC_URL: 'https://marketing.test',
});
// No redis or sources: the template routes must not depend on them.
const app = createServer({ cfg, sql });

const WHATSAPP = {
  channel: 'whatsapp',
  displayName: 'Order',
  category: 'service',
  providerRef: { templateName: 'order', namespace: 'ns', language: 'en' },
  approvedText: 'Hi {{1}}, order {{2}} shipped',
  variables: [
    { slot: 'body_2', value: '{{profile.orderId}}' },
    { slot: 'body_1', value: '{{profile.firstName}}' },
  ],
};
const SMS = {
  channel: 'sms',
  displayName: 'Welcome',
  category: 'service',
  providerRef: { flowId: 'abc123' },
  approvedText: 'Hi {#var#}',
  variables: [{ slot: 'var1', value: '{{profile.firstName}}' }],
};

interface Template {
  templateId: string;
  channel: string;
  enabled: boolean;
  currentVersion: number;
  version: number;
  approvedText: string;
}

function call(
  method: string,
  path: string,
  options: { body?: unknown; project?: string } = {}
) {
  const hasJson = options.body !== undefined;
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(hasJson ? { 'content-type': 'application/json' } : {}),
        'x-marketing-proxy-secret': PROXY_SECRET,
        'x-marketing-project-id': options.project ?? 'proj-a',
        'x-marketing-user-id': 'user-1',
        'x-marketing-csrf': '1',
      },
      body: hasJson ? JSON.stringify(options.body) : undefined,
    })
  );
}

async function create(body: unknown, project?: string): Promise<Template> {
  const res = await call('POST', '/marketing/templates', { body, project });
  if (res.status !== 201) {
    throw new Error(`create answered ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Template;
}

const errorOf = async (res: Response) => [
  res.status,
  ((await res.json()) as { error: string }).error,
];

beforeAll(async () => {
  await migrate();
});
beforeEach(resetMarketingTables);
afterAll(() => sql.$disconnect());

describe('template routes', () => {
  it('create, update, enable, disable, versions and preview round-trip', async () => {
    const created = await create(WHATSAPP);
    expect(created).toMatchObject({
      channel: 'whatsapp',
      enabled: true,
      currentVersion: 1,
    });
    const path = `/marketing/templates/${created.templateId}`;

    const updated = await call('PUT', path, {
      body: {
        ...WHATSAPP,
        approvedText: 'Hey {{1}}, {{2}} shipped',
        expectedVersion: 1,
      },
    });
    expect(await updated.json()).toMatchObject({ currentVersion: 2 });
    expect(
      await errorOf(
        await call('PUT', path, { body: { ...WHATSAPP, expectedVersion: 1 } })
      )
    ).toEqual([409, 'version_conflict']);

    const disabled = await call('POST', `${path}/disable`);
    expect(await disabled.json()).toMatchObject({ enabled: false });
    const enabled = await call('POST', `${path}/enable`);
    expect(await enabled.json()).toMatchObject({ enabled: true });

    const fetched = (await (await call('GET', path)).json()) as Template;
    expect(fetched).toMatchObject({ currentVersion: 2, version: 2 });
    const first = await call('GET', `${path}/versions/1`);
    expect(await first.json()).toMatchObject({
      version: 1,
      approvedText: WHATSAPP.approvedText,
    });
    for (const bad of ['0', 'x', '1.5', '-1', '99']) {
      expect((await call('GET', `${path}/versions/${bad}`)).status).toBe(404);
    }

    await create(SMS);
    const listed = await call('GET', '/marketing/templates?channel=whatsapp');
    const { templates } = (await listed.json()) as { templates: Template[] };
    expect(templates.map((t) => t.templateId)).toEqual([created.templateId]);
    const all = await call('GET', '/marketing/templates');
    expect(
      ((await all.json()) as { templates: Template[] }).templates
    ).toHaveLength(2);
    expect(
      await errorOf(await call('GET', '/marketing/templates?channel=fax'))
    ).toEqual([400, 'invalid_query']);

    const sample = { profile: { firstName: 'Ada', orderId: 42 } };
    const preview = await call('POST', `${path}/preview`, { body: { sample } });
    expect(await preview.json()).toEqual({
      ok: true,
      variables: [
        { slot: 'body_1', value: 'Ada' },
        { slot: 'body_2', value: '42' },
      ],
      text: 'Hey Ada, 42 shipped',
    });
    const old = await call('POST', `${path}/preview`, {
      body: { version: 1, sample },
    });
    expect(((await old.json()) as { text: string }).text).toBe(
      'Hi Ada, order 42 shipped'
    );
  });

  it('an sms preview returns the approved text unchanged', async () => {
    const sms = await create(SMS);
    const res = await call(
      'POST',
      `/marketing/templates/${sms.templateId}/preview`,
      { body: { sample: { profile: { firstName: 'Ada' } } } }
    );
    expect(await res.json()).toEqual({
      ok: true,
      variables: [{ slot: 'var1', value: 'Ada' }],
      text: SMS.approvedText,
    });
  });

  it('preview with a missing trait answers ok false', async () => {
    const created = await create(WHATSAPP);
    const res = await call(
      'POST',
      `/marketing/templates/${created.templateId}/preview`,
      { body: { sample: { profile: { firstName: 'Ada' } } } }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'missing_variable' });
  });

  it('a body with an unknown field is 400', async () => {
    expect(
      await errorOf(
        await call('POST', '/marketing/templates', {
          body: { ...SMS, extra: 1 },
        })
      )
    ).toEqual([400, 'invalid_body']);
    const created = await create(SMS);
    const path = `/marketing/templates/${created.templateId}`;
    expect(
      await errorOf(
        await call('PUT', path, {
          body: { ...SMS, expectedVersion: 1, extra: 1 },
        })
      )
    ).toEqual([400, 'invalid_body']);
    expect(
      await errorOf(
        await call('POST', `${path}/preview`, {
          body: { sample: { profile: {} }, extra: 1 },
        })
      )
    ).toEqual([400, 'invalid_body']);
  });

  it("another project's template is 404", async () => {
    const other = await create(SMS, 'proj-b');
    const path = `/marketing/templates/${other.templateId}`;
    const requests: [string, string, unknown][] = [
      ['GET', path, undefined],
      ['GET', `${path}/versions/1`, undefined],
      ['PUT', path, { ...SMS, expectedVersion: 1 }],
      ['POST', `${path}/enable`, undefined],
      ['POST', `${path}/disable`, undefined],
      ['POST', `${path}/preview`, { sample: { profile: { firstName: 'A' } } }],
    ];
    for (const [method, url, body] of requests) {
      const res = await call(method, url, { body });
      expect([method, url, res.status]).toEqual([method, url, 404]);
    }
    expect((await call('GET', '/marketing/templates/not-a-uuid')).status).toBe(
      404
    );
    const listed = await call('GET', '/marketing/templates');
    expect(
      ((await listed.json()) as { templates: Template[] }).templates
    ).toEqual([]);
  });
});
