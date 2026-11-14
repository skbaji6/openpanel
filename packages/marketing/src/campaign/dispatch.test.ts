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
import { SourceAuthError, SourceProtocolError } from '../audience/errors';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import type { SourceResolver } from '../audience/resolver';
import type { AudienceSource } from '../audience/source';
import { createAudienceStore } from '../audience/store';
import {
  type BatchChannelAdapter,
  type BatchItem,
  type DeliveryOutcome,
  type ProviderMessage,
  perRecipientBatch,
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
import type {
  ChannelAdapter,
  ChannelId,
  Recipient,
  RenderedMessage,
  SendResult,
} from '../channels/types';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { hashToken } from '../engine/dead-tokens';
import {
  createTemplateRegistry,
  type TemplateInput,
} from '../templates/registry';
import {
  type DispatchDeps,
  runDispatchCycle,
  SEND_DEADLINE_MS,
} from './dispatch';
import { hookedSql, isMarkSendingResult } from './dispatch.test-helpers';
import { createChannelBackoff, createRateBucket } from './pacing';
import {
  CAP_LOCK_CHUNK,
  reapExpiredLeases,
  SENDING_LEASE_MS,
} from './recipients';
import { createCampaignService } from './service';

const ENCRYPTION_KEY = 'a'.repeat(64);
const CFG = {
  encryptionKey: ENCRYPTION_KEY,
  leaseSeconds: 120,
  sourceConcurrency: 4,
} as MarketingConfig;
const CHANNEL_SECRET = 'fake-channel-secret-value';
const START = new Date('2026-11-03T06:00:00.000Z');
const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const SOURCE_RETRY_MS = 30_000;
const AUTH_RETRY_MS = 300_000;
const CHANNEL_RETRY_MS = 60_000;
const MAX_CYCLES = 50;
const USER = 'u1';
const zFakeConfig = z.object({ key: z.string() });
const PUSH_TEMPLATE = {
  subject: 'Hi {{profile.name}}',
  body: 'Hello {{profile.name}}',
};

const redis = getRedisCache();
let now = START;
let project = '';
let sleeps: number[] = [];

const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const advance = (ms: number) => {
  now = at(ms);
};
const sleep = async (ms: number) => {
  sleeps.push(ms);
  advance(ms);
};
// The real backoff runs on the Redis clock; this one runs on the test clock.
function testClockBackoff(): DispatchDeps['backoff'] {
  const ends = new Map<string, number>();
  return {
    async set(projectId, channel, ms) {
      const key = `${projectId}:${channel}`;
      ends.set(key, Math.max(ends.get(key) ?? 0, now.getTime() + ms));
    },
    async until(projectId, channel) {
      const end = ends.get(`${projectId}:${channel}`) ?? 0;
      return end > now.getTime() ? end : null;
    },
  };
}
const pad = (n: number) => String(n).padStart(5, '0');

function resolverOf(source: AudienceSource | null): SourceResolver {
  return { forProject: async () => source, invalidate: () => undefined };
}

function campaignService(source: AudienceSource | null) {
  const resolve = async () => source;
  return createCampaignService({
    sql,
    cfg: CFG,
    audiences: createAudienceStore({ sql, source: resolve, now: () => now }),
    source: resolve,
    now: () => now,
  });
}

function depsFor(
  source: AudienceSource | null,
  overrides: Partial<DispatchDeps> = {}
): DispatchDeps {
  return {
    sql,
    redis,
    cfg: CFG,
    sources: resolverOf(source),
    registry: createTemplateRegistry({ sql, now: () => now }),
    campaigns: campaignService(source),
    bucket: createRateBucket(redis, { now: () => now.getTime() }),
    backoff: createChannelBackoff(redis),
    renderUnsubscribeUrl: (_project, profileId, channel) =>
      `https://unsubscribe.test/${profileId}/${channel}`,
    now: () => now,
    sleep,
    ...overrides,
  };
}

async function runUntilIdle(deps: DispatchDeps) {
  const totals = { cycles: 0, sent: 0, skipped: 0, failed: 0 };
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    const result = await runDispatchCycle(deps);
    if (result.campaignId === null) {
      return totals;
    }
    totals.cycles += 1;
    totals.sent += result.sent;
    totals.skipped += result.skipped;
    totals.failed += result.failed;
  }
  throw new Error('dispatch never went idle');
}

interface Sent {
  to: Recipient;
  message: RenderedMessage;
  configKey: string;
  unsubscribeUrl: string;
}

// A per-recipient channel through the real perRecipientBatch, so its deadline logic runs too.
function fakeChannel(
  id: ChannelId,
  behave: (to: Recipient) => SendResult | Promise<SendResult> = () => ({
    ok: true,
  })
): Sent[] {
  const sent: Sent[] = [];
  const adapter: ChannelAdapter<z.infer<typeof zFakeConfig>> = {
    id,
    configSchema: zFakeConfig,
    async send(message, to, config, opts) {
      sent.push({
        to,
        message,
        configKey: config.key,
        unsubscribeUrl: opts.unsubscribeUrl,
      });
      return await behave(to);
    },
  };
  registerBatchAdapter(perRecipientBatch(adapter, () => now.getTime()));
  return sent;
}

function fakeBatch(
  id: CampaignChannel,
  outcomeFor: (
    item: BatchItem,
    batch: number
  ) => DeliveryOutcome | Promise<DeliveryOutcome> = (item) => ({
    profileId: item.profileId,
    outcome: 'sent',
  })
): BatchItem[][] {
  const batches: BatchItem[][] = [];
  const adapter: BatchChannelAdapter<z.infer<typeof zFakeConfig>> = {
    id,
    configSchema: zFakeConfig,
    maxBatch: 100,
    async sendBatch(items) {
      batches.push(items);
      return await Promise.all(
        items.map((item) => outcomeFor(item, batches.length))
      );
    },
  };
  registerBatchAdapter(adapter);
  return batches;
}

interface Setup {
  channel: CampaignChannel;
  members: FakeMember[];
  recipients?: string[];
  template?: unknown;
  templateVersion?: number | null;
  frequencyCap?: { max: number; periodSeconds: number };
  settings?: Partial<ChannelSettings>;
  configured?: boolean;
}

async function setup(options: Setup): Promise<string> {
  const id = randomUUID();
  const recipients =
    options.recipients ?? options.members.map((member) => member.id);
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, template_version,
       frequency_cap, confirm_threshold, created_by, materialize_state, started_at)
     VALUES ($1::uuid, $2, 'c', 'running', $3, $4::jsonb, $5, $6::jsonb, 5000, $7, 'done', $8)`,
    id,
    project,
    options.channel,
    JSON.stringify(options.template ?? PUSH_TEMPLATE),
    options.templateVersion ?? null,
    options.frequencyCap ? JSON.stringify(options.frequencyCap) : null,
    USER,
    now
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.campaign_counters (campaign_id, queued) VALUES ($1::uuid, $2)',
    id,
    recipients.length
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, due_at)
     SELECT $1::uuid, p, $2, $3::timestamptz FROM unnest($4::text[]) AS p`,
    id,
    project,
    now.toISOString(),
    recipients
  );
  if (options.configured !== false) {
    await sql.$executeRawUnsafe(
      'INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)',
      project,
      options.channel,
      encryptCredential(ENCRYPTION_KEY, JSON.stringify({ key: CHANNEL_SECRET }))
    );
  }
  await putChannelSettings(
    sql,
    project,
    options.channel,
    { ...DEFAULT_CHANNEL_SETTINGS[options.channel], ...options.settings },
    0
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.audience_sources (project_id, kind, base_url) VALUES ($1, 'http', 'https://source.test')`,
    project
  );
  return id;
}

async function providerTemplate(
  channel: 'sms' | 'whatsapp',
  overrides: Partial<TemplateInput> = {}
): Promise<{ templateId: string }> {
  const registry = createTemplateRegistry({ sql, now: () => now });
  const providerRef =
    channel === 'sms'
      ? { flowId: 'flow1' }
      : { templateName: 'promo', namespace: 'ns', language: 'en' };
  const row = await registry.create(
    { projectId: project, userId: USER },
    {
      channel,
      displayName: 'Offer',
      category: 'service',
      providerRef,
      approvedText: 'Hello there',
      variables: [],
      ...overrides,
    }
  );
  return { templateId: row.templateId };
}

interface RecipientRow {
  profile_id: string;
  status: string;
  reason: string | null;
}

async function recipients(campaignId: string) {
  const rows = await sql.$queryRawUnsafe<RecipientRow[]>(
    'SELECT profile_id, status, reason FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid',
    campaignId
  );
  return new Map(rows.map((row) => [row.profile_id, row]));
}

async function statuses(campaignId: string) {
  const rows = await sql.$queryRawUnsafe<{ status: string; n: number }[]>(
    `SELECT status, count(*)::int AS n FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid GROUP BY status`,
    campaignId
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

interface CampaignState {
  state: string;
  state_reason: string | null;
  dispatch_error: string | null;
  dispatch_retry_at: Date | null;
  dispatch_failures: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  uncertain: number;
}

async function campaign(campaignId: string): Promise<CampaignState> {
  const [row] = await sql.$queryRawUnsafe<CampaignState[]>(
    `SELECT c.state, c.state_reason, c.dispatch_error, c.dispatch_retry_at, c.dispatch_failures,
       n.queued, n.sent, n.failed, n.skipped, n.uncertain
     FROM marketing.campaigns c JOIN marketing.campaign_counters n ON n.campaign_id = c.id
     WHERE c.id = $1::uuid`,
    campaignId
  );
  if (!row) {
    throw new Error('campaign missing');
  }
  return row;
}

const pushMembers = (count: number): FakeMember[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `p-${pad(i)}`,
    values: {},
    traits: { name: `Name${i}` },
    devices: [{ token: `token-${pad(i)}`, platform: 'android' }],
  }));

const phoneMember = (id: string, extra: Partial<FakeMember> = {}) => ({
  id,
  values: {},
  contact: { phone: '+91 98765 43210' },
  ...extra,
});

function hookLookup(
  inner: AudienceSource,
  after: () => Promise<unknown>
): AudienceSource {
  return {
    ...inner,
    lookup: async (ids, channel) => {
      const entries = await inner.lookup(ids, channel);
      await after();
      return entries;
    },
  };
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
  now = START;
  project = `dispatch-${randomUUID()}`;
  sleeps = [];
});

afterEach(() => {
  for (const channel of CAMPAIGN_CHANNELS) {
    unregisterBatchAdapter(channel);
  }
});

describe('runDispatchCycle', () => {
  it('returns a null campaign when nothing is due', async () => {
    expect((await runDispatchCycle(depsFor(null))).campaignId).toBeNull();
  });

  it('a provider ref that echoes the phone is stored as null; an ordinary ref is kept', async () => {
    const { templateId } = await providerTemplate('whatsapp');
    const members = [phoneMember('echo'), phoneMember('plain')];
    const refs = new Map([
      ['echo', '919876543210'],
      ['plain', 'req-000123'],
    ]);
    fakeBatch('whatsapp', (item) => ({
      profileId: item.profileId,
      outcome: 'sent',
      providerRef: refs.get(item.profileId),
    }));
    const id = await setup({
      channel: 'whatsapp',
      members,
      template: { templateId },
      templateVersion: 1,
    });

    await runDispatchCycle(depsFor(createFakeSource({ members })));

    const rows = await sql.$queryRawUnsafe<
      { profile_id: string; status: string; provider_ref: string | null }[]
    >(
      'SELECT profile_id, status, provider_ref FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid ORDER BY profile_id',
      id
    );
    expect(rows).toEqual([
      { profile_id: 'echo', status: 'sent', provider_ref: null },
      { profile_id: 'plain', status: 'sent', provider_ref: 'req-000123' },
    ]);
  });

  it('a campaign whose preparation throws waits with dispatch_error, and a campaign of another project still sends', async () => {
    const members = pushMembers(3);
    const sent = fakeChannel('push');
    // A rate of 0.1 per second claims one recipient per cycle, so the healthy campaign needs several picks.
    const healthy = await setup({
      channel: 'push',
      members,
      settings: { ratePerSecond: 0.1 },
    });
    project = `dispatch-broken-${randomUUID()}`;
    const broken = await setup({ channel: 'push', members });
    // A stored settings row the strict schema rejects makes every prepare throw.
    await sql.$executeRawUnsafe(
      `UPDATE marketing.channel_settings SET settings = settings || '{"unknown": 1}'::jsonb WHERE project_id = $1`,
      project
    );
    const deps = depsFor(createFakeSource({ members }));

    const thrown: unknown[] = [];
    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      if ((await campaign(healthy)).state === 'completed') {
        break;
      }
      await runDispatchCycle(deps).catch((error: unknown) => {
        thrown.push(error);
      });
    }

    expect((await campaign(healthy)).state).toBe('completed');
    expect(sent).toHaveLength(3);
    expect(thrown).toHaveLength(1);
    expect(await campaign(broken)).toMatchObject({
      state: 'running',
      dispatch_error: 'dispatch_error',
      dispatch_retry_at: new Date(START.getTime() + CHANNEL_RETRY_MS),
    });
    expect(await statuses(broken)).toEqual({ pending: 3 });
  });

  it('1,200 push recipients finish completed with counters sent 1,200 and each profile sent once', async () => {
    const members = pushMembers(1200);
    const sent = fakeChannel('push');
    const id = await setup({ channel: 'push', members });

    await runUntilIdle(depsFor(createFakeSource({ members })));

    expect(sent).toHaveLength(1200);
    expect(new Set(sent.map((s) => s.to.profileId)).size).toBe(1200);
    const first = sent.find((s) => s.to.profileId === 'p-00007');
    expect(first?.message.title).toBe('Hi Name7');
    expect(first?.message.body).toBe('Hello Name7');
    expect(first?.to.deviceTokens).toEqual(['token-00007']);
    expect(first?.configKey).toBe(CHANNEL_SECRET);
    expect(first?.unsubscribeUrl).toBe('https://unsubscribe.test/p-00007/push');
    const state = await campaign(id);
    expect(state.state).toBe('completed');
    expect(state.sent).toBe(1200);
    expect(state.queued).toBe(1200);
    expect(await statuses(id)).toEqual({ sent: 1200 });
  });

  it('a push campaign delivers its image and link to the adapter', async () => {
    const members = pushMembers(1);
    const sent = fakeChannel('push');
    await setup({
      channel: 'push',
      members,
      template: {
        subject: 'Hi',
        body: 'Text',
        imageUrl: 'https://cdn.example.test/a.png',
        link: 'sia://course/12',
      },
    });

    await runUntilIdle(depsFor(createFakeSource({ members })));

    expect(sent[0]?.message).toMatchObject({
      title: 'Hi',
      imageUrl: 'https://cdn.example.test/a.png',
      data: { link: 'sia://course/12' },
    });
  });

  it('not_found, suppressed, unreachable:no_valid_phone and an opted_out id are skipped with those reasons', async () => {
    const { templateId } = await providerTemplate('sms');
    const members = [
      phoneMember('ok'),
      phoneMember('hidden', { suppressed: true }),
      { id: 'nophone', values: {} },
      phoneMember('odd', { unreachable: { sms: 'Not A Reason!' } }),
      phoneMember('optout'),
    ];
    const batches = fakeBatch('sms');
    const id = await setup({
      channel: 'sms',
      members,
      recipients: [...members.map((m) => m.id), 'ghost'],
      template: { templateId },
      templateVersion: 1,
    });
    await sql.$executeRawUnsafe(
      "INSERT INTO marketing.opt_outs (project_id, profile_id, channel) VALUES ($1, 'optout', 'sms')",
      project
    );

    await runUntilIdle(depsFor(createFakeSource({ members })));

    const rows = await recipients(id);
    expect(rows.get('ok')?.status).toBe('sent');
    expect(rows.get('ghost')?.reason).toBe('not_found');
    expect(rows.get('hidden')?.reason).toBe('suppressed');
    expect(rows.get('nophone')?.reason).toBe('unreachable:no_valid_phone');
    expect(rows.get('odd')?.reason).toBe('unreachable:unknown');
    expect(rows.get('optout')?.reason).toBe('opted_out');
    expect(batches.flat().map((item) => item.profileId)).toEqual(['ok']);
    expect(batches[0]?.[0]?.to.phone).toBe('919876543210');
    expect((await campaign(id)).skipped).toBe(5);
  });

  it('requireConsent on whatsapp skips consent false and consent missing, and sends consent true', async () => {
    const { templateId } = await providerTemplate('whatsapp');
    const members = [
      phoneMember('yes', { consent: { whatsapp: true } }),
      phoneMember('no', { consent: { whatsapp: false } }),
      phoneMember('missing'),
    ];
    const batches = fakeBatch('whatsapp');
    const id = await setup({
      channel: 'whatsapp',
      members,
      template: { templateId },
      templateVersion: 1,
      settings: { requireConsent: true },
    });

    const fake = createFakeSource({ members });
    // A source may return devices for any channel; only push may send them on.
    const withDevices: AudienceSource = {
      ...fake,
      lookup: async (ids, channel) =>
        (await fake.lookup(ids, channel)).map((entry) => ({
          ...entry,
          devices: [{ token: 'stray-token', platform: 'ios' }],
        })),
    };

    await runUntilIdle(depsFor(withDevices));

    const rows = await recipients(id);
    expect(rows.get('yes')?.status).toBe('sent');
    expect(rows.get('no')?.reason).toBe('consent');
    expect(rows.get('missing')?.reason).toBe('consent');
    expect(batches.flat().map((item) => item.profileId)).toEqual(['yes']);
    expect((batches[0]?.[0]?.message as ProviderMessage).kind).toBe('provider');
    expect(batches[0]?.[0]?.to.deviceTokens).toEqual([]);
  });

  it('sms service-category templates ignore sms_promotional', async () => {
    const { templateId } = await providerTemplate('sms');
    const members = [
      phoneMember('declined', { consent: { sms_promotional: false } }),
      phoneMember('unknown'),
    ];
    fakeBatch('sms');
    const id = await setup({
      channel: 'sms',
      members,
      template: { templateId },
      templateVersion: 1,
      settings: { requireConsent: true },
    });

    await runUntilIdle(depsFor(createFakeSource({ members })));

    expect(await statuses(id)).toEqual({ sent: 2 });
  });

  it('sms promotional templates skip recipients without sms_promotional consent', async () => {
    const { templateId } = await providerTemplate('sms', {
      category: 'promotional',
    });
    const members = [
      phoneMember('agreed', { consent: { sms_promotional: true } }),
      phoneMember('declined', { consent: { sms_promotional: false } }),
    ];
    fakeBatch('sms');
    const id = await setup({
      channel: 'sms',
      members,
      template: { templateId },
      templateVersion: 1,
      settings: { requireConsent: true },
    });

    await runUntilIdle(depsFor(createFakeSource({ members })));

    const rows = await recipients(id);
    expect(rows.get('agreed')?.status).toBe('sent');
    expect(rows.get('declined')?.reason).toBe('consent');
  });

  it('a missing trait fails that recipient with missing_variable and sends the others', async () => {
    const { templateId } = await providerTemplate('sms', {
      variables: [{ slot: 'name', value: '{{profile.first}}' }],
    });
    const members = [
      phoneMember('named', { traits: { first: 'Asha' } }),
      phoneMember('blank', { traits: { first: '   ' } }),
      phoneMember('absent', { traits: {} }),
    ];
    const batches = fakeBatch('sms');
    const id = await setup({
      channel: 'sms',
      members,
      template: { templateId },
      templateVersion: 1,
    });

    await runUntilIdle(depsFor(createFakeSource({ members })));

    const rows = await recipients(id);
    expect(rows.get('named')?.status).toBe('sent');
    expect(rows.get('blank')).toMatchObject({
      status: 'failed',
      reason: 'missing_variable',
    });
    expect(rows.get('absent')?.reason).toBe('missing_variable');
    const message = batches[0]?.[0]?.message as ProviderMessage;
    expect(message.variables).toEqual([{ slot: 'name', value: 'Asha' }]);
    const state = await campaign(id);
    expect(state.failed).toBe(2);
    expect(state.state).toBe('completed');
  });

  it('quiet hours active leaves every row pending with no skip and sets dispatch_retry_at to the window end', async () => {
    // 21:00 in Asia/Kolkata.
    now = new Date('2026-11-03T15:30:00.000Z');
    const members = pushMembers(3);
    const sent = fakeChannel('push');
    const id = await setup({
      channel: 'push',
      members,
      settings: {
        quietHours: {
          enabled: true,
          start: '21:00',
          end: '08:00',
          timezone: 'Asia/Kolkata',
        },
      },
    });

    const result = await runDispatchCycle(
      depsFor(createFakeSource({ members }))
    );

    expect(result).toMatchObject({ campaignId: id, claimed: 0, skipped: 0 });
    expect(sent).toHaveLength(0);
    expect(await statuses(id)).toEqual({ pending: 3 });
    expect((await campaign(id)).dispatch_retry_at?.toISOString()).toBe(
      '2026-11-04T02:30:00.000Z'
    );
    expect((await campaign(id)).dispatch_error).toBe('quiet_hours');
    expect((await runDispatchCycle(depsFor(null))).campaignId).toBeNull();
  });

  it('a rate too slow to fit a token in the lease rests the campaign instead of claiming and looking up again', async () => {
    const members = pushMembers(3);
    const sent = fakeChannel('push');
    // One token per 1,000 s: the first comes from the full bucket, the next never fits in the lease.
    const id = await setup({
      channel: 'push',
      members,
      settings: { ratePerSecond: 0.001 },
    });
    let lookups = 0;
    const inner = createFakeSource({ members });
    const deps = depsFor({
      ...inner,
      lookup: (ids, channel) => {
        lookups += 1;
        return inner.lookup(ids, channel);
      },
    });

    await runDispatchCycle(deps);
    expect(sent).toHaveLength(1);
    const waitingFrom = now.getTime();
    await runDispatchCycle(deps);
    expect(lookups).toBe(2);
    expect(sent).toHaveLength(1);
    expect((await campaign(id)).dispatch_retry_at?.getTime()).toBe(
      waitingFrom + 1_000_000
    );

    expect((await runDispatchCycle(deps)).campaignId).toBeNull();
    expect(lookups).toBe(2);
    expect(await statuses(id)).toEqual({ sent: 1, pending: 2 });
  });

  it('a claim whose lease leaves no pacing time rests the campaign without a lookup', async () => {
    const members = pushMembers(2);
    const sent = fakeChannel('push');
    const id = await setup({ channel: 'push', members });
    let lookups = 0;
    const inner = createFakeSource({ members });
    const deps = depsFor(
      {
        ...inner,
        lookup: (ids, channel) => {
          lookups += 1;
          return inner.lookup(ids, channel);
        },
      },
      { cfg: { ...CFG, leaseSeconds: SENDING_LEASE_MS / SECOND_MS } }
    );

    const result = await runDispatchCycle(deps);

    expect(result.claimed).toBe(2);
    expect(lookups).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await statuses(id)).toEqual({ pending: 2 });
    expect((await campaign(id)).dispatch_retry_at?.getTime()).toBe(
      at(SECOND_MS).getTime()
    );
  });

  it('turning quiet hours off wakes a campaign waiting for them', async () => {
    // 21:00 in Asia/Kolkata.
    now = new Date('2026-11-03T15:30:00.000Z');
    const members = pushMembers(3);
    const sent = fakeChannel('push');
    const quietHours = {
      enabled: true,
      start: '21:00',
      end: '08:00',
      timezone: 'Asia/Kolkata',
    };
    const id = await setup({
      channel: 'push',
      members,
      settings: { quietHours },
    });
    const deps = depsFor(createFakeSource({ members }));
    await runDispatchCycle(deps);
    expect((await campaign(id)).dispatch_error).toBe('quiet_hours');

    await putChannelSettings(
      sql,
      project,
      'push',
      {
        ...DEFAULT_CHANNEL_SETTINGS.push,
        quietHours: { ...quietHours, enabled: false },
      },
      1
    );
    await runDispatchCycle(deps);

    expect(sent).toHaveLength(3);
    expect(await campaign(id)).toMatchObject({
      state: 'completed',
      dispatch_error: null,
    });
  });

  it('a successful lookup keeps a channel error; a batch the adapter takes clears it', async () => {
    const members = pushMembers(1);
    const sent = fakeChannel('push');
    // A rate of 0.1 per second claims one recipient per cycle: the unknown id first, then the member.
    const id = await setup({
      channel: 'push',
      members,
      recipients: ['gone', 'p-00000'],
      settings: { ratePerSecond: 0.1 },
    });
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaign_recipients SET due_at = due_at - interval '1 second'
       WHERE campaign_id = $1::uuid AND profile_id = 'gone'`,
      id
    );
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET dispatch_error = 'channel_auth_failed' WHERE id = $1::uuid`,
      id
    );
    const deps = depsFor(createFakeSource({ members }));

    await runDispatchCycle(deps);
    expect((await recipients(id)).get('gone')?.status).toBe('skipped');
    expect(sent).toHaveLength(0);
    expect((await campaign(id)).dispatch_error).toBe('channel_auth_failed');

    await runUntilIdle(deps);
    expect(sent).toHaveLength(1);
    const state = await campaign(id);
    expect(state.state).toBe('completed');
    expect(state.dispatch_error).toBeNull();
  });

  it('an email campaign with quota 100 sends 100 today and resumes the rest at local midnight', async () => {
    const members = Array.from({ length: 150 }, (_, i) => ({
      id: `e-${pad(i)}`,
      values: {},
      contact: { email: `person${i}@mail.test` },
    }));
    const sent = fakeChannel('email');
    const id = await setup({
      channel: 'email',
      members,
      template: { subject: 'News', body: '<p>Hi</p>' },
      settings: { dailyQuota: 100, quotaTimezone: 'Asia/Kolkata' },
    });
    const deps = depsFor(createFakeSource({ members }));

    await runUntilIdle(deps);

    expect(sent).toHaveLength(100);
    expect(sent[0]?.message.subject).toBe('News');
    expect(sent[0]?.to.email).toMatch(/@mail\.test$/);
    let state = await campaign(id);
    expect(state.dispatch_error).toBe('quota_exhausted');
    // Local midnight in Asia/Kolkata.
    expect(state.dispatch_retry_at?.toISOString()).toBe(
      '2026-11-03T18:30:00.000Z'
    );
    expect(await statuses(id)).toEqual({ sent: 100, pending: 50 });

    now = new Date('2026-11-03T18:30:00.000Z');
    await runUntilIdle(deps);

    expect(sent).toHaveLength(150);
    state = await campaign(id);
    expect(state.state).toBe('completed');
    expect(state.sent).toBe(150);
  });

  it('a frequency cap of 1 per day skips a person a journey already messaged today as capped', async () => {
    const members = pushMembers(2);
    const sent = fakeChannel('push');
    const id = await setup({
      channel: 'push',
      members,
      frequencyCap: { max: 1, periodSeconds: 86_400 },
    });
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.send_ledger (source_ref, project_id, profile_id, channel, sent_at)
       VALUES ('step:e1:0', $1, 'p-00000', 'push', $2)`,
      project,
      at(-HOUR_MS)
    );

    await runUntilIdle(depsFor(createFakeSource({ members })));

    const rows = await recipients(id);
    expect(rows.get('p-00000')).toMatchObject({
      status: 'skipped',
      reason: 'capped',
    });
    expect(rows.get('p-00001')?.status).toBe('sent');
    expect(sent.map((s) => s.to.profileId)).toEqual(['p-00001']);
  });

  it('a 429 from the adapter backs off the channel for Retry-After and leaves rows pending, then completes', async () => {
    const retryAfterMs = 45_000;
    const members = pushMembers(3);
    const batches = fakeBatch('push', (item, batch) =>
      batch === 1
        ? { profileId: item.profileId, outcome: 'rate_limited', retryAfterMs }
        : { profileId: item.profileId, outcome: 'sent' }
    );
    const id = await setup({ channel: 'push', members });
    const backoff = testClockBackoff();
    const deps = depsFor(createFakeSource({ members }), { backoff });
    const startedAt = now.getTime();

    await runDispatchCycle(deps);
    expect(await statuses(id)).toEqual({ pending: 3 });
    expect((await recipients(id)).get('p-00000')?.reason).toBe('rate_limited');
    expect(await backoff.until(project, 'push')).toBe(startedAt + retryAfterMs);
    expect(await campaign(id)).toMatchObject({
      dispatch_error: 'rate_limited',
      dispatch_retry_at: new Date(startedAt + retryAfterMs),
    });

    // Another batch's 429 extends the backoff past the rows' own due time.
    advance(retryAfterMs);
    await backoff.set(project, 'push', retryAfterMs);
    const backedOff = await runDispatchCycle(deps);
    expect(backedOff).toMatchObject({ campaignId: id, claimed: 0 });
    expect(batches).toHaveLength(1);
    expect(await campaign(id)).toMatchObject({
      dispatch_error: 'rate_limited',
      dispatch_retry_at: at(retryAfterMs),
    });

    advance(retryAfterMs);
    await runUntilIdle(deps);

    expect(batches).toHaveLength(2);
    const state = await campaign(id);
    expect(state.state).toBe('completed');
    expect(state.sent).toBe(3);
    expect(state.failed).toBe(0);
    expect(state.dispatch_error).toBeNull();
  });

  it('channel_error leaves every row pending with dispatch_error channel_auth_failed and nothing failed', async () => {
    const members = pushMembers(4);
    fakeChannel('push', () => ({
      ok: false,
      retryable: false,
      reason: 'http 401',
    }));
    const id = await setup({ channel: 'push', members });

    await runDispatchCycle(depsFor(createFakeSource({ members })));

    expect(await statuses(id)).toEqual({ pending: 4 });
    const state = await campaign(id);
    expect(state.dispatch_error).toBe('channel_auth_failed');
    expect(state.dispatch_retry_at?.getTime()).toBe(
      at(CHANNEL_RETRY_MS).getTime()
    );
    expect(state.failed).toBe(0);
  });

  it('pause between lookup and markSending returns the batch to pending and sends nothing', async () => {
    const members = pushMembers(3);
    const sent = fakeChannel('push');
    let campaignId = '';
    const source = hookLookup(createFakeSource({ members }), () =>
      sql.$executeRawUnsafe(
        "UPDATE marketing.campaigns SET state = 'paused' WHERE id = $1::uuid",
        campaignId
      )
    );
    campaignId = await setup({ channel: 'push', members });

    const result = await runDispatchCycle(depsFor(source));

    expect(sent).toHaveLength(0);
    expect(result.released).toBe(3);
    expect(await statuses(campaignId)).toEqual({ pending: 3 });
    expect((await campaign(campaignId)).sent).toBe(0);
  });

  it('cancel between lookup and markSending sends nothing', async () => {
    const members = pushMembers(3);
    const sent = fakeChannel('push');
    let campaignId = '';
    const source = hookLookup(createFakeSource({ members }), () =>
      campaignService(null).cancel(
        { projectId: project, userId: USER },
        campaignId
      )
    );
    campaignId = await setup({ channel: 'push', members });

    await runDispatchCycle(depsFor(source));

    expect(sent).toHaveLength(0);
    expect(await statuses(campaignId)).toEqual({ skipped: 3 });
    expect((await recipients(campaignId)).get('p-00000')?.reason).toBe(
      'cancelled'
    );
    expect((await campaign(campaignId)).state).toBe('cancelled');
  });

  it('the source down returns the batch to pending with dispatch_error source_unavailable and no failed mark', async () => {
    const members = pushMembers(3);
    const sent = fakeChannel('push');
    const id = await setup({ channel: 'push', members });

    await runDispatchCycle(
      depsFor(createFakeSource({ members, down: () => true }))
    );

    expect(sent).toHaveLength(0);
    expect(await statuses(id)).toEqual({ pending: 3 });
    const state = await campaign(id);
    expect(state.dispatch_error).toBe('source_unavailable');
    expect(state.dispatch_retry_at?.getTime()).toBe(
      at(SOURCE_RETRY_MS).getTime()
    );
    expect(state.failed).toBe(0);
  });

  it('a source auth failure waits 300 s and marks the source, and a later lookup clears it', async () => {
    const members = pushMembers(2);
    fakeChannel('push');
    const id = await setup({ channel: 'push', members });
    const healthy = createFakeSource({ members });
    let reject = true;
    const source: AudienceSource = {
      ...healthy,
      lookup: (ids, channel) =>
        reject
          ? Promise.reject(new SourceAuthError('bad key'))
          : healthy.lookup(ids, channel),
    };
    const sourceStatus = async () =>
      (
        await sql.$queryRawUnsafe<{ status: string | null }[]>(
          'SELECT status FROM marketing.audience_sources WHERE project_id = $1',
          project
        )
      )[0]?.status;

    await runDispatchCycle(depsFor(source));

    let state = await campaign(id);
    expect(state.dispatch_error).toBe('source_auth_failed');
    expect(state.dispatch_retry_at?.getTime()).toBe(
      at(AUTH_RETRY_MS).getTime()
    );
    expect(await sourceStatus()).toBe('source_auth_failed');
    expect(await statuses(id)).toEqual({ pending: 2 });

    reject = false;
    advance(AUTH_RETRY_MS);
    await runUntilIdle(depsFor(source));

    state = await campaign(id);
    expect(state.state).toBe('completed');
    expect(state.dispatch_error).toBeNull();
    expect(await sourceStatus()).toBe('ok');
  });

  it('five protocol errors fail the campaign with source_error', async () => {
    const members = pushMembers(2);
    const sent = fakeChannel('push');
    const id = await setup({ channel: 'push', members });
    const source: AudienceSource = {
      ...createFakeSource({ members }),
      lookup: () => Promise.reject(new SourceProtocolError('bad shape')),
    };
    const deps = depsFor(source);

    for (let attempt = 1; attempt <= 4; attempt++) {
      await runDispatchCycle(deps);
      const state = await campaign(id);
      expect(state.state).toBe('running');
      expect(state.dispatch_failures).toBe(attempt);
      advance(SOURCE_RETRY_MS);
    }
    await runDispatchCycle(deps);

    const state = await campaign(id);
    expect(state.state).toBe('failed');
    expect(state.state_reason).toBe('source_error');
    expect(await statuses(id)).toEqual({ skipped: 2 });
    expect(sent).toHaveLength(0);
  });

  it('a source switched to stored fails the campaign with source_not_http', async () => {
    const members = pushMembers(1);
    fakeChannel('push');
    const id = await setup({ channel: 'push', members });

    await runDispatchCycle(depsFor(null));

    const state = await campaign(id);
    expect(state.state).toBe('failed');
    expect(state.state_reason).toBe('source_not_http');
  });

  it('a channel without credentials waits 60 s with channel_not_configured and fails nothing', async () => {
    const members = pushMembers(2);
    const sent = fakeChannel('push');
    const id = await setup({ channel: 'push', members, configured: false });

    await runDispatchCycle(depsFor(createFakeSource({ members })));

    expect(sent).toHaveLength(0);
    expect(await statuses(id)).toEqual({ pending: 2 });
    const state = await campaign(id);
    expect(state.dispatch_error).toBe('channel_not_configured');
    expect(state.dispatch_retry_at?.getTime()).toBe(
      at(CHANNEL_RETRY_MS).getTime()
    );
  });

  it('a dispatch error thrown by the adapter leaves the batch sending, and the reaper later marks it uncertain', async () => {
    const members = [
      { id: 'e1', values: {}, contact: { email: 'secret.person@mail.test' } },
      { id: 'e2', values: {}, contact: { email: 'other.person@mail.test' } },
    ];
    registerBatchAdapter({
      id: 'email',
      configSchema: zFakeConfig,
      maxBatch: 500,
      sendBatch(items) {
        return Promise.reject(
          new Error(`socket closed for ${items[0]?.to.email} ${CHANNEL_SECRET}`)
        );
      },
    });
    const id = await setup({
      channel: 'email',
      members,
      template: { subject: 'S', body: 'B' },
    });
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runDispatchCycle(depsFor(createFakeSource({ members })));
      const text = logged.mock.calls.flat().map(String).join(' ');
      expect(text).toContain('socket closed');
      expect(text).not.toContain('secret.person@mail.test');
      expect(text).not.toContain(CHANNEL_SECRET);
    } finally {
      logged.mockRestore();
    }

    expect(await statuses(id)).toEqual({ sending: 2 });
    const reaped = await reapExpiredLeases(
      sql,
      at(SENDING_LEASE_MS + SECOND_MS)
    );
    expect(reaped.uncertain).toBe(2);
    expect((await recipients(id)).get('e1')).toMatchObject({
      status: 'uncertain',
      reason: 'lease_expired',
    });
  });

  it('a batch past its deadline stops starting sends and returns the rest to pending', async () => {
    // The deadline is 30 s after markSending (61 s lease − 30 s send timeout − 1 s margin): sends start at 0, 12 and 24 s.
    const members = pushMembers(5);
    const sendMs = 12_000;
    const sent = fakeChannel('push', () => {
      advance(sendMs);
      return { ok: true };
    });
    const id = await setup({
      channel: 'push',
      members,
      settings: { concurrency: 1 },
    });

    await runDispatchCycle(depsFor(createFakeSource({ members })));

    expect(sent).toHaveLength(3);
    expect(await statuses(id)).toEqual({ sent: 3, pending: 2 });
    const unstarted = await sql.$queryRawUnsafe<{ attempt: number }[]>(
      `SELECT attempt FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid AND status = 'pending'`,
      id
    );
    expect(unstarted.map((row) => row.attempt)).toEqual([0, 0]);
  });

  it('the rate bucket at 10 per second paces 30 sms recipients over about 2 s through the injected sleep', async () => {
    const { templateId } = await providerTemplate('sms');
    const members = Array.from({ length: 30 }, (_, i) =>
      phoneMember(`s-${pad(i)}`)
    );
    const batches = fakeBatch('sms');
    const id = await setup({
      channel: 'sms',
      members,
      template: { templateId },
      templateVersion: 1,
      settings: { ratePerSecond: 10 },
    });

    await runUntilIdle(depsFor(createFakeSource({ members })));

    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeGreaterThanOrEqual(1900);
    expect(waited).toBeLessThanOrEqual(2100);
    expect(batches.flat()).toHaveLength(30);
    expect((await campaign(id)).state).toBe('completed');
  });

  it('a push invalid token is recorded as a dead token hash', async () => {
    const members = pushMembers(1);
    fakeChannel('push', (to) => ({
      ok: true,
      invalidTokens: to.deviceTokens,
    }));
    await setup({ channel: 'push', members });

    await runUntilIdle(depsFor(createFakeSource({ members })));

    const rows = await sql.$queryRawUnsafe<{ token_hash: Uint8Array }[]>(
      'SELECT token_hash FROM marketing.dead_tokens WHERE project_id = $1',
      project
    );
    expect(
      rows.map((row) => Buffer.from(row.token_hash).toString('hex'))
    ).toEqual([hashToken(ENCRYPTION_KEY, 'token-00000').toString('hex')]);
  });

  it('a push recipient whose only token is dead is skipped as unreachable:no_live_token', async () => {
    const members = pushMembers(2);
    const sent = fakeChannel('push');
    const id = await setup({ channel: 'push', members });
    await sql.$executeRawUnsafe(
      'INSERT INTO marketing.dead_tokens (project_id, token_hash) VALUES ($1, $2)',
      project,
      hashToken(ENCRYPTION_KEY, 'token-00000')
    );

    await runUntilIdle(depsFor(createFakeSource({ members })));

    expect((await recipients(id)).get('p-00000')?.reason).toBe(
      'unreachable:no_live_token'
    );
    expect(sent.map((s) => s.to.profileId)).toEqual(['p-00001']);
  });
  it('a stored sms template that does not parse fails the campaign with template_not_found', async () => {
    const members = [phoneMember('s1')];
    const batches = fakeBatch('sms');
    const id = await setup({
      channel: 'sms',
      members,
      template: { body: 'not a registry reference' },
      templateVersion: 1,
    });

    await runDispatchCycle(depsFor(createFakeSource({ members })));

    expect(batches).toHaveLength(0);
    const state = await campaign(id);
    expect([state.state, state.state_reason]).toEqual([
      'failed',
      'template_not_found',
    ]);
  });

  it('a stored frequency cap that does not parse fails the campaign with invalid_frequency_cap', async () => {
    const members = pushMembers(2);
    const sent = fakeChannel('push');
    const id = await setup({ channel: 'push', members });
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET frequency_cap = '{"max": "lots"}'::jsonb WHERE id = $1::uuid`,
      id
    );

    await runDispatchCycle(depsFor(createFakeSource({ members })));

    expect(sent).toHaveLength(0);
    const state = await campaign(id);
    expect([state.state, state.state_reason]).toEqual([
      'failed',
      'invalid_frequency_cap',
    ]);
  });

  it('a capped batch paused between lock chunks delivers the rows already marked sending and releases the rest', async () => {
    const total = 250;
    const members = pushMembers(total);
    const sent = fakeChannel('push');
    let campaignId = '';
    let paused = false;
    // The pause commits right after the first chunk's markSending transaction, before the second chunk starts.
    const pauseAfterFirstChunk = hookedSql({
      afterTransaction: async (result) => {
        if (paused || !isMarkSendingResult(result)) {
          return;
        }
        paused = true;
        await sql.$executeRawUnsafe(
          "UPDATE marketing.campaigns SET state = 'paused' WHERE id = $1::uuid",
          campaignId
        );
      },
    });
    campaignId = await setup({
      channel: 'push',
      members,
      frequencyCap: { max: 5, periodSeconds: 86_400 },
    });

    await runDispatchCycle(
      depsFor(createFakeSource({ members }), { sql: pauseAfterFirstChunk })
    );

    const firstChunk = members
      .map((member) => member.id)
      .sort()
      .slice(0, CAP_LOCK_CHUNK);
    expect(sent.map((s) => s.to.profileId).sort()).toEqual(firstChunk);
    expect(await statuses(campaignId)).toEqual({
      sent: CAP_LOCK_CHUNK,
      pending: total - CAP_LOCK_CHUNK,
    });
  });

  it('the abort signal fires once the send deadline has passed, and not before', async () => {
    const members = pushMembers(2);
    const aborted: boolean[] = [];
    registerBatchAdapter({
      id: 'push',
      configSchema: zFakeConfig,
      maxBatch: 100,
      async sendBatch(items, _config, opts) {
        // One macrotask: a timer due now has fired by then.
        await new Promise((resolve) => setTimeout(resolve, 0));
        aborted.push(opts.signal?.aborted === true);
        return items.map((item) => ({
          profileId: item.profileId,
          outcome: 'sent' as const,
        }));
      },
    });
    let marks = 0;
    // The second batch's clock reaches its deadline right after markSending, before the timer is armed.
    const jumpOnSecondMark = hookedSql({
      afterTransaction: (result) => {
        if (isMarkSendingResult(result)) {
          marks += 1;
          if (marks === 2) {
            advance(SEND_DEADLINE_MS);
          }
        }
      },
    });
    // A rate of 0.1 per second claims one recipient per cycle.
    await setup({ channel: 'push', members, settings: { ratePerSecond: 0.1 } });

    await runUntilIdle(
      depsFor(createFakeSource({ members }), { sql: jumpOnSecondMark })
    );

    expect(aborted).toEqual([false, true]);
  });
});
