import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { encryptCredential } from '@openpanel/shared/server';
import { createServer } from '../api/server';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import type { SourceResolver } from '../audience/resolver';
import {
  CFG,
  createClock,
  dispatchDeps,
  drain,
  ENCRYPTION_KEY,
  insertRunningCampaign,
  redis,
} from '../campaign/dispatch.test-helpers';
import { smsReportFor } from '../channels/fakes/msg91-reports';
import {
  extractPhones,
  type FakeMsg91,
  startFakeMsg91,
} from '../channels/fakes/msg91-server';
import { createMsg91SmsAdapter } from '../channels/msg91-sms';
import {
  registerBatchAdapter,
  unregisterBatchAdapter,
} from '../channels/registry';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from '../templates/registry';
import { webhookPath, webhookSecret } from './keys';

const PROJECT_A = 'project-hook-a';
const PROJECT_B = 'project-hook-b';
const BASE = 'http://marketing.internal';
const RECIPIENTS = 250;
const B_RECIPIENTS = 3;
const FAILED_AUTH_LIMIT = 30;
const OVERSIZE_BYTES = 600 * 1024;
const SETUP_TIMEOUT_MS = 120_000;
const COUNTRY_CODE = '91';
const BODY_MARKER = 'body-marker-9f3a1c';
const LOOKUP_ERROR_PHONE = '9123456789';

const phoneOf = (index: number) => `9${String(index).padStart(9, '0')}`;
const idOf = (index: number) => `hook-student-${index}`;
const secretOf = (project: string) => webhookSecret(ENCRYPTION_KEY, project);
const wrongSecret = 'A'.repeat(43);

const cfg = { ...CFG, proxySecret: 'proxy', trustProxy: true };

function members(count: number): FakeMember[] {
  return Array.from({ length: count }, (_, i) => ({
    id: idOf(i),
    values: {},
    displayName: `Student ${i}`,
    contact: { phone: phoneOf(i) },
    traits: { firstName: `Student${i}` },
  }));
}

let msg91: FakeMsg91;
let lookupFails = false;
let failedLookups = 0;
const resolver = {
  forProject: async (project: string) => {
    if (lookupFails) {
      failedLookups++;
      throw new Error(`source down ${LOOKUP_ERROR_PHONE} ${project}`);
    }
    return source;
  },
  invalidate: () => undefined,
} as unknown as SourceResolver;
let source = createFakeSource({ members: [] });

const post = (
  path: string,
  body: BodyInit | null,
  ip = '10.0.0.1',
  contentType = 'application/json'
) =>
  makeApp().fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      body,
      headers: { 'content-type': contentType, 'x-forwarded-for': ip },
    })
  );

let app = createServer({ cfg, sql, redis, sources: resolver });
const makeApp = () => app;

const hookPath = (project: string, secret = secretOf(project)) =>
  webhookPath(project, secret);

async function batches(project: string) {
  const rows = await sql.$queryRawUnsafe<
    { provider_ref: string; profile_id: string }[]
  >(
    `SELECT provider_ref, profile_id FROM marketing.message_tracking
     WHERE project_id = $1 AND provider_ref IS NOT NULL ORDER BY profile_id`,
    project
  );
  const byRequest = new Map<string, string[]>();
  for (const row of rows) {
    const phone = phoneOf(Number(row.profile_id.split('-').at(-1)));
    byRequest.set(row.provider_ref, [
      ...(byRequest.get(row.provider_ref) ?? []),
      `${COUNTRY_CODE}${phone}`,
    ]);
  }
  return byRequest;
}

const reportsFor = (batch: Map<string, string[]>) =>
  [...batch].map(([requestId, phones]) =>
    smsReportFor(
      requestId,
      phones.map((phone) => ({ phone, status: '1' as const }))
    )
  );

async function countByStatus(project: string, status: string) {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM marketing.message_tracking WHERE project_id = $1 AND status = $2',
    project,
    status
  );
  return row?.n ?? 0;
}

const resetStatuses = () =>
  sql.$executeRawUnsafe(
    `UPDATE marketing.message_tracking SET status = 'sent', delivered_at = NULL, read_at = NULL, failed_at = NULL, reason = NULL`
  );

async function seedCampaign(
  project: string,
  recipients: number,
  clock: ReturnType<typeof createClock>
) {
  const template = await createTemplateRegistry({
    sql,
    now: clock.now,
  }).create(
    { projectId: project, userId: 'u1' },
    {
      channel: 'sms',
      displayName: 'Offer',
      category: 'service',
      providerRef: { flowId: 'flowhook' },
      approvedText: 'Hello ##name##',
      variables: [{ slot: 'name', value: '{{profile.firstName}}' }],
    }
  );
  await insertRunningCampaign({
    project,
    now: clock.now(),
    channel: 'sms',
    recipients: Array.from({ length: recipients }, (_, i) => idOf(i)),
    template: { templateId: template.templateId },
    templateVersion: 1,
    settings: { ratePerSecond: 1000 },
  });
  await sql.$executeRawUnsafe(
    'UPDATE marketing.channel_configs SET config_encrypted = $3 WHERE project_id = $1 AND channel = $2',
    project,
    'sms',
    encryptCredential(
      ENCRYPTION_KEY,
      JSON.stringify({
        authKey: 'hook-auth-key-0123456789',
        baseUrl: msg91.baseUrl,
      })
    )
  );
}

describe('msg91 delivery webhook', () => {
  beforeAll(async () => {
    await migrate();
    await resetMarketingTables();
    msg91 = await startFakeMsg91();
    const clock = createClock();
    source = createFakeSource({ members: members(RECIPIENTS) });
    registerBatchAdapter(
      createMsg91SmsAdapter({
        now: clock.ms,
        allowHosts: [new URL(msg91.baseUrl).hostname],
      })
    );
    await seedCampaign(PROJECT_A, RECIPIENTS, clock);
    await seedCampaign(PROJECT_B, B_RECIPIENTS, clock);
    await drain(dispatchDeps(source, clock), clock);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    unregisterBatchAdapter('sms');
    await msg91.close();
  });

  beforeEach(async () => {
    lookupFails = false;
    app = createServer({ cfg, sql, redis, sources: resolver });
    await resetStatuses();
  });

  it('the setup really sent 250 recipients in batches through the fake provider', async () => {
    const sentPhones = msg91.requests.flatMap((r) => extractPhones(r.body));
    expect(sentPhones.length).toBe(RECIPIENTS + B_RECIPIENTS);
    expect((await batches(PROJECT_A)).size).toBeGreaterThan(1);
    expect(await countByStatus(PROJECT_A, 'sent')).toBe(RECIPIENTS);
  });

  it('the rows become delivered', async () => {
    let applied = 0;
    for (const body of reportsFor(await batches(PROJECT_A))) {
      const response = await post(hookPath(PROJECT_A), JSON.stringify(body));
      expect(response.status).toBe(200);
      applied += ((await response.json()) as { applied: number }).applied;
    }
    expect(applied).toBe(RECIPIENTS);
    expect(await countByStatus(PROJECT_A, 'delivered')).toBe(RECIPIENTS);
    expect(await countByStatus(PROJECT_B, 'delivered')).toBe(0);
  });

  it('a form encoded body with a data field is accepted', async () => {
    const [body] = reportsFor(await batches(PROJECT_A));
    const response = await post(
      hookPath(PROJECT_A),
      new URLSearchParams({ data: JSON.stringify(body) }).toString(),
      '10.0.0.2',
      'application/x-www-form-urlencoded'
    );
    expect(response.status).toBe(200);
    expect(await countByStatus(PROJECT_A, 'delivered')).toBeGreaterThan(0);
  });

  it('a wrong secret is 401 and writes nothing', async () => {
    for (const body of reportsFor(await batches(PROJECT_A))) {
      const response = await post(
        hookPath(PROJECT_A, wrongSecret),
        JSON.stringify(body)
      );
      expect(response.status).toBe(401);
    }
    expect(await countByStatus(PROJECT_A, 'delivered')).toBe(0);
  });

  it("project A's secret on project B's path is 401", async () => {
    const response = await post(
      hookPath(PROJECT_B, secretOf(PROJECT_A)),
      JSON.stringify(reportsFor(await batches(PROJECT_A))[0])
    );
    expect(response.status).toBe(401);
    expect(await countByStatus(PROJECT_A, 'delivered')).toBe(0);
    expect(await countByStatus(PROJECT_B, 'delivered')).toBe(0);
  });

  it("a valid secret for B cannot change A's rows", async () => {
    for (const body of reportsFor(await batches(PROJECT_A))) {
      const response = await post(hookPath(PROJECT_B), JSON.stringify(body));
      expect(response.status).toBe(200);
      expect(((await response.json()) as { applied: number }).applied).toBe(0);
    }
    expect(await countByStatus(PROJECT_A, 'delivered')).toBe(0);
    expect(await countByStatus(PROJECT_B, 'delivered')).toBe(0);
  });

  it('the 31st failed auth from one ip is 429', async () => {
    const ip = '10.9.9.9';
    for (let attempt = 0; attempt < FAILED_AUTH_LIMIT; attempt++) {
      expect(
        (await post(hookPath(PROJECT_A, wrongSecret), '[]', ip)).status
      ).toBe(401);
    }
    expect(
      (await post(hookPath(PROJECT_A, wrongSecret), '[]', ip)).status
    ).toBe(429);
    expect((await post(hookPath(PROJECT_A), '[]', ip)).status).toBe(429);
    expect((await post(hookPath(PROJECT_A), '[]', '10.9.9.10')).status).toBe(
      200
    );
  });

  it('a 600 KiB body is 413, declared or streamed', async () => {
    const big = 'x'.repeat(OVERSIZE_BYTES);
    const declared = await makeApp().fetch(
      new Request(`${BASE}${hookPath(PROJECT_A)}`, {
        method: 'POST',
        body: big,
        headers: {
          'content-length': String(OVERSIZE_BYTES),
          'x-forwarded-for': '10.0.0.3',
        },
      })
    );
    expect(declared.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = await makeApp().fetch(
      new Request(`${BASE}${hookPath(PROJECT_A)}`, {
        method: 'POST',
        body: stream,
        duplex: 'half',
        headers: { 'x-forwarded-for': '10.0.0.4' },
      } as RequestInit)
    );
    expect(streamed.status).toBe(413);
  });

  it('an unparseable body is 200 with zeros', async () => {
    const response = await post(hookPath(PROJECT_A), 'not json at all');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      applied: 0,
      unmatched: 0,
      ignored: 0,
    });
  });

  it('a lookup failure is 503 and a retry then applies', async () => {
    const body = JSON.stringify(reportsFor(await batches(PROJECT_A))[0]);
    lookupFails = true;
    const failed = await post(hookPath(PROJECT_A), body);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'source_unavailable' });
    expect(await countByStatus(PROJECT_A, 'delivered')).toBe(0);
    lookupFails = false;
    const retried = await post(hookPath(PROJECT_A), body);
    expect(retried.status).toBe(200);
    expect(await countByStatus(PROJECT_A, 'delivered')).toBeGreaterThan(0);
    expect(failedLookups).toBeGreaterThan(0);
  });

  it('the secret and the body appear in no log line', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    const spies = [
      spyOn(console, 'error').mockImplementation(capture),
      spyOn(console, 'warn').mockImplementation(capture),
      spyOn(console, 'log').mockImplementation(capture),
      spyOn(console, 'info').mockImplementation(capture),
    ];
    try {
      const secret = secretOf(PROJECT_A);
      await post(hookPath(PROJECT_A, wrongSecret), BODY_MARKER);
      await post(hookPath(PROJECT_A), BODY_MARKER);
      lookupFails = true;
      await post(
        hookPath(PROJECT_A),
        JSON.stringify(reportsFor(await batches(PROJECT_A))[0])
      );
      lookupFails = false;
      expect(lines.length).toBeGreaterThan(0);
      const joined = lines.join('\n');
      expect(joined).not.toContain(secret);
      expect(joined).not.toContain(PROJECT_A);
      expect(joined).not.toContain(BODY_MARKER);
      expect(joined).not.toContain(LOOKUP_ERROR_PHONE);
      expect(joined).not.toContain(phoneOf(1));
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
