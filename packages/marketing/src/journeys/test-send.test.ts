import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import { HttpError } from '../api/http';
import { createFakeSource, type FakeMember } from '../audience/fake-source';
import type { AudienceSource } from '../audience/source';
import { createAudienceStore } from '../audience/store';
import type { DispatchDeps } from '../campaign/dispatch';
import { createChannelBackoff, createRateBucket } from '../campaign/pacing';
import { SENDING_LEASE_MS } from '../campaign/recipients';
import { createCampaignService } from '../campaign/service';
import { registerAdapter } from '../channels/registry';
import type {
  ChannelAdapter,
  Recipient,
  RenderedMessage,
  SendOptions,
  SendResult,
} from '../channels/types';
import type { MarketingConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from '../templates/registry';
import {
  type JourneyTestSendRequest,
  listJourneyTestSends,
  requestJourneyTestSend,
  runJourneyTestSendTick,
} from './test-send';

const ENCRYPTION_KEY = 'a'.repeat(64);
const CFG = {
  encryptionKey: ENCRYPTION_KEY,
  leaseSeconds: 120,
  sourceConcurrency: 4,
} as MarketingConfig;
const START = new Date('2026-11-03T15:30:00.000Z');
const USER = 'u1';
const CANARY_TOKEN = 'canary-device-token-123';
const CANARY_NAME = 'Canary Student';
const CANARY_BODY = 'AP wording for sure';
const LIMIT = 10;
const BAD_REQUEST = 400;
const TOO_MANY = 429;
const CONFLICT = 409;
const zFakeConfig = z.object({ key: z.string() });

const redis = getRedisCache();
const now = () => START;
const registry = createTemplateRegistry({ sql, now });
let project = '';

interface Sent {
  message: RenderedMessage;
  to: Recipient;
  opts: SendOptions;
}

function fakePush(result: SendResult = { ok: true }): Sent[] {
  const sent: Sent[] = [];
  const adapter: ChannelAdapter<z.infer<typeof zFakeConfig>> = {
    id: 'push',
    configSchema: zFakeConfig,
    send(message, to, _config, opts) {
      sent.push({ message, to, opts });
      return Promise.resolve(result);
    },
  };
  registerAdapter(adapter);
  return sent;
}

const student = (id: string, state: string): FakeMember => ({
  id,
  values: {},
  traits: { state, name: CANARY_NAME },
  devices: [{ token: CANARY_TOKEN, platform: 'android' }],
});

function depsFor(source: AudienceSource | null): DispatchDeps {
  const resolve = async () => source;
  return {
    sql,
    redis,
    cfg: CFG,
    sources: { forProject: resolve, invalidate: () => undefined },
    registry,
    campaigns: createCampaignService({
      sql,
      cfg: CFG,
      audiences: createAudienceStore({ sql, source: resolve, now }),
      source: resolve,
      now,
    }),
    bucket: createRateBucket(redis, { now: () => START.getTime() }),
    backoff: createChannelBackoff(redis),
    renderUnsubscribeUrl: () => 'https://unsubscribe.test/u',
    now,
    sleep: async () => undefined,
  };
}

const definition = (step: Record<string, unknown>) => ({
  name: 'Journey',
  trigger: { event: 'signup' },
  goal: { kind: 'event', event: 'paid' },
  steps: [{ delaySeconds: 60, channel: 'push', ...step }],
  reentry: { enabled: false, cooldownSeconds: 0 },
  allowedEventProps: [],
});

async function insertRule(
  def: unknown,
  status = 'draft',
  projectId = project
): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, 'Journey', $3, $4::jsonb)`,
    id,
    projectId,
    status,
    JSON.stringify(def)
  );
  return id;
}

async function configurePush() {
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted) VALUES ($1, $2, $3)',
    project,
    'push',
    encryptCredential(ENCRYPTION_KEY, JSON.stringify({ key: 'k' }))
  );
}

const request = (ruleId: string, body: Partial<JourneyTestSendRequest> = {}) =>
  requestJourneyTestSend({ sql, registry, now }, project, ruleId, {
    profileId: 'p1',
    stepIndex: 0,
    variant: 'default',
    ...body,
  });

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) {
      return [error.status, error.code];
    }
    throw error;
  }
  return null;
};

interface Row {
  status: string;
  reason: string | null;
  lease_until: Date | null;
}

async function row(id: string): Promise<Row> {
  const [found] = await sql.$queryRawUnsafe<Row[]>(
    'SELECT status, reason, lease_until FROM marketing.journey_test_sends WHERE id = $1::uuid',
    id
  );
  if (!found) {
    throw new Error('test send missing');
  }
  return found;
}

const twoStates = () =>
  definition({
    template: { body: 'default wording' },
    variants: { AP: { body: CANARY_BODY }, TS: { body: 'TS wording' } },
  });

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
  project = `journey-test-send-${randomUUID()}`;
});

describe('journey test sends', () => {
  it('the AP variant is sent to a TS student when AP is requested', async () => {
    const sent = fakePush();
    await configurePush();
    const ruleId = await insertRule(twoStates());
    const { id } = await request(ruleId, { variant: 'AP' });

    const deps = depsFor(createFakeSource({ members: [student('p1', 'TS')] }));
    expect(await runJourneyTestSendTick(deps)).toBe(1);
    expect(await runJourneyTestSendTick(deps)).toBe(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.body).toBe(CANARY_BODY);
    expect(sent[0]?.opts.idempotencyKey).toBe(`test:${id}`);
    expect(await row(id)).toMatchObject({
      status: 'sent',
      reason: null,
      lease_until: null,
    });
  });

  it('a crash after claiming never sends twice', async () => {
    const sent = fakePush();
    await configurePush();
    const ruleId = await insertRule(twoStates());
    const id = randomUUID();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.journey_test_sends
         (id, project_id, rule_id, step_index, variant_key, profile_id, status, lease_until)
       VALUES ($1::uuid, $2, $3::uuid, 0, 'AP', 'p1', 'sending', $4)`,
      id,
      project,
      ruleId,
      new Date(START.getTime() - SENDING_LEASE_MS)
    );
    const deps = depsFor(createFakeSource({ members: [student('p1', 'TS')] }));

    await runJourneyTestSendTick(deps);
    await runJourneyTestSendTick(deps);

    expect(sent).toHaveLength(0);
    expect(await row(id)).toMatchObject({
      status: 'failed',
      reason: 'uncertain',
      lease_until: null,
    });
  });

  it('a row still inside its lease is left alone', async () => {
    const sent = fakePush();
    const ruleId = await insertRule(twoStates());
    const id = randomUUID();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.journey_test_sends
         (id, project_id, rule_id, step_index, variant_key, profile_id, status, lease_until)
       VALUES ($1::uuid, $2, $3::uuid, 0, 'AP', 'p1', 'sending', $4)`,
      id,
      project,
      ruleId,
      new Date(START.getTime() + SENDING_LEASE_MS)
    );

    await runJourneyTestSendTick(depsFor(createFakeSource({ members: [] })));

    expect(sent).toHaveLength(0);
    expect((await row(id)).status).toBe('sending');
  });

  it('an unknown variant is refused 400 unknown_variant', async () => {
    const ruleId = await insertRule(twoStates());
    expect(await refusal(request(ruleId, { variant: 'KA' }))).toEqual([
      BAD_REQUEST,
      'unknown_variant',
    ]);
    // 'toString' is not a variant even though every object has one.
    expect(await refusal(request(ruleId, { variant: 'toString' }))).toEqual([
      BAD_REQUEST,
      'unknown_variant',
    ]);
  });

  it('the default variant needs a default template', async () => {
    const ruleId = await insertRule(
      definition({ variants: { AP: { body: 'AP' } } })
    );
    expect(await refusal(request(ruleId))).toEqual([
      BAD_REQUEST,
      'unknown_variant',
    ]);
    expect(await refusal(request(ruleId, { variant: 'AP' }))).toBeNull();
  });

  it('a bad profile id or step is a 400 and queues nothing', async () => {
    const ruleId = await insertRule(twoStates());
    expect(await refusal(request(ruleId, { profileId: 'a\nb' }))).toEqual([
      BAD_REQUEST,
      'invalid_profile_id',
    ]);
    expect(await refusal(request(ruleId, { stepIndex: 5 }))).toEqual([
      BAD_REQUEST,
      'invalid_step',
    ]);
    expect(
      (await listJourneyTestSends(sql, project, ruleId)).testSends
    ).toEqual([]);
  });

  it("another project's rule is not found", async () => {
    const ruleId = await insertRule(twoStates(), 'draft', 'other-project');
    expect(await refusal(request(ruleId))).toEqual([404, 'not_found']);
  });

  it('the eleventh test send in an hour is 429, counted per project', async () => {
    const ruleId = await insertRule(twoStates());
    const otherRule = await insertRule(twoStates());
    for (let i = 0; i < LIMIT; i++) {
      await request(i % 2 === 0 ? ruleId : otherRule);
    }
    expect(await refusal(request(ruleId))).toEqual([
      TOO_MANY,
      'test_send_limit',
    ]);
    expect(await refusal(request(otherRule))).toEqual([
      TOO_MANY,
      'test_send_limit',
    ]);
    const elsewhere = await requestJourneyTestSend(
      { sql, registry, now },
      'other-project',
      await insertRule(twoStates(), 'draft', 'other-project'),
      { profileId: 'p1', stepIndex: 0, variant: 'default' }
    );
    expect(elsewhere.id).toBeTruthy();
  });

  it('a draft pins its template refs in memory and stores nothing', async () => {
    const sent = fakePush();
    await configurePush();
    const template = await registry.create(
      { projectId: project, userId: USER },
      {
        channel: 'push',
        displayName: 'Nudge',
        category: 'service',
        content: { subject: 'Hello', body: 'from the registry' },
      }
    );
    const def = definition({ template: { templateId: template.templateId } });
    const ruleId = await insertRule(def);
    const { id } = await request(ruleId);

    await runJourneyTestSendTick(
      depsFor(createFakeSource({ members: [student('p1', 'TS')] }))
    );

    expect(sent[0]?.message).toMatchObject({
      title: 'Hello',
      body: 'from the registry',
    });
    expect((await row(id)).status).toBe('sent');
    const [stored] = await sql.$queryRawUnsafe<{ definition: unknown }[]>(
      'SELECT definition FROM marketing.rules WHERE id = $1::uuid',
      ruleId
    );
    expect(stored?.definition).toEqual(def);
  });

  it('a disabled template refuses with its code, and ends a queued send skipped', async () => {
    const sent = fakePush();
    await configurePush();
    const ctx = { projectId: project, userId: USER };
    const template = await registry.create(ctx, {
      channel: 'push',
      displayName: 'Nudge',
      category: 'service',
      content: { subject: 'Hello', body: 'registry' },
    });
    const ruleId = await insertRule(
      definition({ template: { templateId: template.templateId } })
    );
    const { id } = await request(ruleId);
    await registry.setEnabled(ctx, template.templateId, false);

    expect(await refusal(request(ruleId))).toEqual([
      CONFLICT,
      'template_disabled',
    ]);
    await runJourneyTestSendTick(
      depsFor(createFakeSource({ members: [student('p1', 'TS')] }))
    );

    expect(sent).toHaveLength(0);
    expect(await row(id)).toMatchObject({
      status: 'skipped',
      reason: 'template_disabled',
    });
  });

  it('a student the source cannot find, or without a device, is skipped with a code', async () => {
    const sent = fakePush();
    await configurePush();
    const ruleId = await insertRule(twoStates());
    const missing = (await request(ruleId, { variant: 'AP' })).id;
    await runJourneyTestSendTick(depsFor(createFakeSource({ members: [] })));
    expect(await row(missing)).toMatchObject({
      status: 'skipped',
      reason: 'not_found',
    });
    expect(sent).toHaveLength(0);
  });

  it('a failing adapter ends failed with a fixed code and never echoes the error', async () => {
    fakePush({
      ok: false,
      retryable: true,
      reason: `rejected ${CANARY_TOKEN} for ${CANARY_NAME}`,
    });
    await configurePush();
    const ruleId = await insertRule(twoStates());
    const { id } = await request(ruleId, { variant: 'AP' });

    await runJourneyTestSendTick(
      depsFor(createFakeSource({ members: [student('p1', 'TS')] }))
    );

    expect(await row(id)).toMatchObject({
      status: 'failed',
      reason: 'send_failed',
    });
  });

  it('no phone, email or token is stored on the row', async () => {
    fakePush();
    await configurePush();
    const ruleId = await insertRule(twoStates());
    const queued = (await request(ruleId, { variant: 'AP' })).id;
    await runJourneyTestSendTick(
      depsFor(createFakeSource({ members: [student('p1', 'TS')] }))
    );

    const [stored] = await sql.$queryRawUnsafe<{ json: string }[]>(
      'SELECT row_to_json(t)::text AS json FROM marketing.journey_test_sends t WHERE id = $1::uuid',
      queued
    );
    const text = stored?.json ?? '';
    expect(text).toContain('p1');
    for (const canary of [CANARY_TOKEN, CANARY_NAME, CANARY_BODY, 'TS']) {
      expect(text).not.toContain(canary);
    }
    const listed = JSON.stringify(
      await listJourneyTestSends(sql, project, ruleId)
    );
    for (const canary of [CANARY_TOKEN, CANARY_NAME, CANARY_BODY]) {
      expect(listed).not.toContain(canary);
    }
  });

  it('the list shows the last 20 for the rule, newest first', async () => {
    const ruleId = await insertRule(twoStates());
    const other = await insertRule(twoStates());
    await request(other);
    const first = (await request(ruleId, { variant: 'AP' })).id;
    const { testSends } = await listJourneyTestSends(sql, project, ruleId);
    expect(testSends).toHaveLength(1);
    expect(testSends[0]).toMatchObject({
      id: first,
      stepIndex: 0,
      variant: 'AP',
      profileId: 'p1',
      status: 'pending',
      reason: null,
      sentAt: null,
    });
  });
});
