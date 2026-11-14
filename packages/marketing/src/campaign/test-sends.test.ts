import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import {
  SourceAuthError,
  SourceBusyError,
  SourceProtocolError,
  SourceUnavailableError,
} from '../audience/errors';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import type { AudienceSource } from '../audience/source';
import { createAudienceStore } from '../audience/store';
import type {
  BatchChannelAdapter,
  BatchItem,
  DeliveryOutcome,
} from '../channels/batch';
import {
  registerBatchAdapter,
  unregisterBatchAdapter,
} from '../channels/registry';
import {
  CAMPAIGN_CHANNELS,
  type CampaignChannel,
  type ChannelSettings,
  DEFAULT_CHANNEL_SETTINGS,
  putChannelSettings,
} from '../channels/settings';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from '../templates/registry';
import { type DispatchDeps, SEND_DEADLINE_MS } from './dispatch';
import { createChannelBackoff, createRateBucket } from './pacing';
import { SENDING_LEASE_MS } from './recipients';
import { createCampaignService } from './service';
import { runTestSendTick } from './test-sends';

const ENCRYPTION_KEY = 'a'.repeat(64);
const CFG = {
  encryptionKey: ENCRYPTION_KEY,
  leaseSeconds: 120,
  sourceConcurrency: 4,
} as MarketingConfig;
// 21:00 in Kolkata, inside the default 21:00-08:00 quiet hours.
const START = new Date('2026-11-03T15:30:00.000Z');
const USER = 'u1';
const PHONE = '+91 98765 43210';
const NORMALISED_PHONE = '919876543210';
const zFakeConfig = z.object({ key: z.string() });

const redis = getRedisCache();
let now = START;
let project = '';
let concurrencies: number[] = [];

const member = (id: string): FakeMember => ({
  id,
  values: {},
  contact: { phone: PHONE },
  traits: { name: 'Asha' },
  devices: [{ token: `token-${id}`, platform: 'android' }],
});

function depsFor(source: AudienceSource | null): DispatchDeps {
  const resolve = async () => source;
  return {
    sql,
    redis,
    cfg: CFG,
    sources: { forProject: resolve, invalidate: () => undefined },
    registry: createTemplateRegistry({ sql, now: () => now }),
    campaigns: createCampaignService({
      sql,
      cfg: CFG,
      audiences: createAudienceStore({ sql, source: resolve, now: () => now }),
      source: resolve,
      now: () => now,
    }),
    bucket: createRateBucket(redis, { now: () => now.getTime() }),
    backoff: createChannelBackoff(redis),
    renderUnsubscribeUrl: (_project, profileId, channel) =>
      `https://unsubscribe.test/${profileId}/${channel}`,
    now: () => now,
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function fakeBatch(
  id: CampaignChannel,
  outcomeFor: (item: BatchItem) => DeliveryOutcome = (item) => ({
    profileId: item.profileId,
    outcome: 'sent',
    providerRef: `ref-${item.profileId}`,
  })
): BatchItem[] {
  const sent: BatchItem[] = [];
  const adapter: BatchChannelAdapter<z.infer<typeof zFakeConfig>> = {
    id,
    configSchema: zFakeConfig,
    maxBatch: 100,
    async sendBatch(items, _config, opts) {
      concurrencies.push(opts.concurrency);
      sent.push(...items);
      return items.map(outcomeFor);
    },
  };
  registerBatchAdapter(adapter);
  return sent;
}

interface Setup {
  channel: CampaignChannel;
  template?: unknown;
  templateVersion?: number | null;
  settings?: Partial<ChannelSettings>;
  configured?: boolean;
}

async function setupCampaign(options: Setup): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, template_version,
       confirm_threshold, created_by)
     VALUES ($1::uuid, $2, 'c', 'draft', $3, $4::jsonb, $5, 5000, $6)`,
    id,
    project,
    options.channel,
    JSON.stringify(
      options.template ?? { subject: 'Hi {{profile.name}}', body: 'Hello' }
    ),
    options.templateVersion ?? null,
    USER
  );
  if (options.configured !== false) {
    await sql.$executeRawUnsafe(
      'INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)',
      project,
      options.channel,
      encryptCredential(ENCRYPTION_KEY, JSON.stringify({ key: 'k' }))
    );
  }
  await putChannelSettings(
    sql,
    project,
    options.channel,
    { ...DEFAULT_CHANNEL_SETTINGS[options.channel], ...options.settings },
    0
  );
  return id;
}

async function requestTestSend(
  campaignId: string,
  profileId: string,
  status = 'pending',
  leaseUntil: Date | null = null
): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_test_sends (id, campaign_id, project_id, profile_id, requested_by, status,
       lease_until, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
    id,
    campaignId,
    project,
    profileId,
    USER,
    status,
    leaseUntil,
    now
  );
  return id;
}

interface TestSendRow {
  status: string;
  reason: string | null;
  provider_ref: string | null;
  sent_at: Date | null;
  lease_until: Date | null;
}

async function testSend(id: string): Promise<TestSendRow> {
  const [row] = await sql.$queryRawUnsafe<TestSendRow[]>(
    'SELECT status, reason, provider_ref, sent_at, lease_until FROM marketing.campaign_test_sends WHERE id = $1::uuid',
    id
  );
  if (!row) {
    throw new Error('test send missing');
  }
  return row;
}

async function smsTemplate(): Promise<string> {
  const row = await createTemplateRegistry({ sql, now: () => now }).create(
    { projectId: project, userId: USER },
    {
      channel: 'sms',
      displayName: 'Offer',
      category: 'service',
      providerRef: { flowId: 'flow1' },
      approvedText: 'Hello there',
      variables: [],
    }
  );
  return row.templateId;
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
  now = START;
  project = `test-sends-${randomUUID()}`;
  concurrencies = [];
});

afterEach(() => {
  for (const channel of CAMPAIGN_CHANNELS) {
    unregisterBatchAdapter(channel);
  }
});

describe('runTestSendTick', () => {
  it('a pending test send to a fake push profile is delivered once and marked sent', async () => {
    const sent = fakeBatch('push');
    const campaignId = await setupCampaign({ channel: 'push' });
    const id = await requestTestSend(campaignId, 'p1');
    const deps = depsFor(createFakeSource({ members: [member('p1')] }));

    expect(await runTestSendTick(deps)).toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
    });
    expect(await runTestSendTick(deps)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
    });

    expect(sent).toHaveLength(1);
    expect(concurrencies).toEqual([1]);
    const [item] = sent;
    expect(item?.to.deviceTokens).toEqual(['token-p1']);
    expect(item?.message).toMatchObject({ title: 'Hi Asha', body: 'Hello' });
    expect(item?.unsubscribeUrl).toBe('https://unsubscribe.test/p1/push');
    // A campaign-scoped key would let a provider drop the real send to this person later.
    expect(item?.idempotencyKey).toBe(`test:${id}`);
    const row = await testSend(id);
    expect(row).toMatchObject({
      status: 'sent',
      reason: null,
      provider_ref: 'ref-p1',
      lease_until: null,
    });
    expect(row.sent_at?.toISOString()).toBe(START.toISOString());
  });

  it('a test send during quiet hours is still sent', async () => {
    const sent = fakeBatch('push');
    const campaignId = await setupCampaign({
      channel: 'push',
      settings: {
        quietHours: {
          enabled: true,
          start: '21:00',
          end: '08:00',
          timezone: 'Asia/Kolkata',
        },
      },
    });
    const id = await requestTestSend(campaignId, 'p1');

    await runTestSendTick(
      depsFor(createFakeSource({ members: [member('p1')] }))
    );

    expect(sent).toHaveLength(1);
    expect((await testSend(id)).status).toBe('sent');
  });

  it('a test send writes no ledger row', async () => {
    fakeBatch('push');
    const campaignId = await setupCampaign({ channel: 'push' });
    const id = await requestTestSend(campaignId, 'p1');

    await runTestSendTick(
      depsFor(createFakeSource({ members: [member('p1')] }))
    );

    expect((await testSend(id)).status).toBe('sent');
    const [ledger] = await sql.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM marketing.send_ledger'
    );
    expect(ledger?.n).toBe(0);
  });

  it('a disabled template skips with template_disabled', async () => {
    const sent = fakeBatch('sms');
    const templateId = await smsTemplate();
    await createTemplateRegistry({ sql, now: () => now }).setEnabled(
      { projectId: project, userId: USER },
      templateId,
      false
    );
    const campaignId = await setupCampaign({
      channel: 'sms',
      template: { templateId },
    });
    const id = await requestTestSend(campaignId, 'p1');

    expect(
      await runTestSendTick(
        depsFor(createFakeSource({ members: [member('p1')] }))
      )
    ).toEqual({ sent: 0, failed: 0, skipped: 1 });

    expect(sent).toHaveLength(0);
    expect(await testSend(id)).toMatchObject({
      status: 'skipped',
      reason: 'template_disabled',
    });
  });

  it('an sms test send uses the current template version and carries no device tokens', async () => {
    const sent = fakeBatch('sms');
    const templateId = await smsTemplate();
    const campaignId = await setupCampaign({
      channel: 'sms',
      template: { templateId },
    });
    const id = await requestTestSend(campaignId, 'p1');

    await runTestSendTick(
      depsFor(createFakeSource({ members: [member('p1')] }))
    );

    expect((await testSend(id)).status).toBe('sent');
    expect(sent[0]?.to.phone).toBe(NORMALISED_PHONE);
    expect(sent[0]?.to.deviceTokens).toEqual([]);
    expect(sent[0]?.message).toMatchObject({
      kind: 'provider',
      version: { templateId, version: 1 },
    });
  });

  it('a template id that is not a uuid skips with template_not_found', async () => {
    const sent = fakeBatch('sms');
    const campaignId = await setupCampaign({
      channel: 'sms',
      template: { templateId: 'not-a-uuid' },
    });
    const id = await requestTestSend(campaignId, 'p1');

    await runTestSendTick(
      depsFor(createFakeSource({ members: [member('p1')] }))
    );

    expect(sent).toHaveLength(0);
    expect(await testSend(id)).toMatchObject({
      status: 'skipped',
      reason: 'template_not_found',
    });
  });

  it('a channel without credentials fails the test send with channel_not_configured', async () => {
    const sent = fakeBatch('push');
    const campaignId = await setupCampaign({
      channel: 'push',
      configured: false,
    });
    const id = await requestTestSend(campaignId, 'p1');

    expect(
      await runTestSendTick(
        depsFor(createFakeSource({ members: [member('p1')] }))
      )
    ).toEqual({ sent: 0, failed: 1, skipped: 0 });

    expect(sent).toHaveLength(0);
    expect(await testSend(id)).toMatchObject({
      status: 'failed',
      reason: 'channel_not_configured',
    });
  });

  it('a profile the source does not know skips with the lookup reason', async () => {
    const sent = fakeBatch('push');
    const campaignId = await setupCampaign({ channel: 'push' });
    const id = await requestTestSend(campaignId, 'ghost');

    await runTestSendTick(
      depsFor(createFakeSource({ members: [member('p1')] }))
    );

    expect(sent).toHaveLength(0);
    expect(await testSend(id)).toMatchObject({
      status: 'skipped',
      reason: 'not_found',
    });
  });

  it('an expired sending test send becomes failed uncertain', async () => {
    const sent = fakeBatch('push');
    const campaignId = await setupCampaign({ channel: 'push' });
    const id = await requestTestSend(campaignId, 'p1', 'sending', now);
    now = new Date(now.getTime() + 1000);

    expect(
      await runTestSendTick(
        depsFor(createFakeSource({ members: [member('p1')] }))
      )
    ).toEqual({ sent: 0, failed: 1, skipped: 0 });

    expect(sent).toHaveLength(0);
    expect(await testSend(id)).toMatchObject({
      status: 'failed',
      reason: 'uncertain',
      lease_until: null,
    });
  });

  it('a test send whose adapter throws stays sending, then becomes failed uncertain and is never resent', async () => {
    let attempts = 0;
    registerBatchAdapter<z.infer<typeof zFakeConfig>>({
      id: 'push',
      configSchema: zFakeConfig,
      maxBatch: 100,
      sendBatch(items) {
        attempts += 1;
        throw new Error(`socket closed for ${items[0]?.to.phone}`);
      },
    });
    const campaignId = await setupCampaign({ channel: 'push' });
    const id = await requestTestSend(campaignId, 'p1');
    const deps = depsFor(createFakeSource({ members: [member('p1')] }));
    const errors: string[] = [];
    const logged = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      }
    );
    try {
      await runTestSendTick(deps);
      expect((await testSend(id)).status).toBe('sending');
      now = new Date(now.getTime() + SENDING_LEASE_MS + 1000);
      await runTestSendTick(deps);
      await runTestSendTick(deps);
    } finally {
      logged.mockRestore();
    }

    expect(attempts).toBe(1);
    expect(await testSend(id)).toMatchObject({
      status: 'failed',
      reason: 'uncertain',
    });
    expect(errors.join('\n')).toContain('socket closed');
    expect(errors.join('\n')).not.toContain(NORMALISED_PHONE);
  });
  it('a slow send does not fail the test send behind it', async () => {
    const sent = fakeBatch('push', (item) => {
      if (item.profileId === 'p1') {
        // Longer than a whole send deadline, so a shared claim time would leave p2 no budget.
        now = new Date(now.getTime() + SEND_DEADLINE_MS + 5000);
      }
      return { profileId: item.profileId, outcome: 'sent' };
    });
    const campaignId = await setupCampaign({ channel: 'push' });
    const first = await requestTestSend(campaignId, 'p1');
    now = new Date(now.getTime() + 1);
    const second = await requestTestSend(campaignId, 'p2');

    expect(
      await runTestSendTick(
        depsFor(createFakeSource({ members: [member('p1'), member('p2')] }))
      )
    ).toEqual({ sent: 2, failed: 0, skipped: 0 });

    expect(sent.map((item) => item.profileId)).toEqual(['p1', 'p2']);
    expect((await testSend(first)).status).toBe('sent');
    expect((await testSend(second)).status).toBe('sent');
  });

  it('a lookup that fails before any provider call fails the test send at once', async () => {
    const cases: [Error, string][] = [
      [new SourceUnavailableError('down'), 'source_unavailable'],
      [new SourceBusyError('busy'), 'source_unavailable'],
      [new SourceProtocolError('bad'), 'source_unavailable'],
      [new SourceAuthError('denied'), 'source_auth_failed'],
    ];
    const sent = fakeBatch('push');
    const campaignId = await setupCampaign({ channel: 'push' });
    const inner = createFakeSource({ members: [member('p1')] });
    for (const [error, reason] of cases) {
      const id = await requestTestSend(campaignId, 'p1');
      await runTestSendTick(
        depsFor({
          ...inner,
          lookup: () => Promise.reject(error),
        })
      );
      expect(await testSend(id)).toMatchObject({ status: 'failed', reason });
    }
    expect(sent).toHaveLength(0);
  });

  it('a template read that fails for another reason leaves the test send sending', async () => {
    const sent = fakeBatch('sms');
    const templateId = await smsTemplate();
    const campaignId = await setupCampaign({
      channel: 'sms',
      template: { templateId },
    });
    const id = await requestTestSend(campaignId, 'p1');
    const deps = depsFor(createFakeSource({ members: [member('p1')] }));
    deps.registry = {
      ...deps.registry,
      get: () => Promise.reject(new Error('connection reset')),
    };
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runTestSendTick(deps);
    } finally {
      logged.mockRestore();
    }

    expect(sent).toHaveLength(0);
    expect((await testSend(id)).status).toBe('sending');
  });

  it('a test send of a cancelled or failed campaign is skipped with the state', async () => {
    const sent = fakeBatch('push');
    const deps = depsFor(createFakeSource({ members: [member('p1')] }));
    for (const state of ['cancelled', 'failed']) {
      project = `test-sends-${randomUUID()}`;
      const campaignId = await setupCampaign({ channel: 'push' });
      const id = await requestTestSend(campaignId, 'p1');
      await sql.$executeRawUnsafe(
        'UPDATE marketing.campaigns SET state = $2, finished_at = $3 WHERE id = $1::uuid',
        campaignId,
        state,
        now
      );
      await runTestSendTick(deps);
      expect(await testSend(id)).toMatchObject({
        status: 'skipped',
        reason: state,
      });
    }
    expect(sent).toHaveLength(0);
  });

  it("an opted-out profile's test send is skipped opted_out", async () => {
    const sent = fakeBatch('push');
    const campaignId = await setupCampaign({ channel: 'push' });
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.opt_outs (project_id, profile_id, channel) VALUES ($1, 'p1', 'push')`,
      project
    );
    const id = await requestTestSend(campaignId, 'p1');

    await runTestSendTick(
      depsFor(createFakeSource({ members: [member('p1')] }))
    );

    expect(sent).toHaveLength(0);
    expect(await testSend(id)).toMatchObject({
      status: 'skipped',
      reason: 'opted_out',
    });
  });
});
