import { beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { truncateMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from '../templates/registry';
import { pinTemplate } from './channel-ready';
import { runScheduleTick } from './scheduler';

const START = new Date('2026-11-03T10:00:00.000Z');
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const AUDIENCE_VERSION = 7;
// Two default batches, so overlapping ticks contend for the same rows.
const PARALLEL_PROJECTS = 40;
const CTX = { projectId: 'p1', userId: 'u1' };
const SMS_TEMPLATE = {
  channel: 'sms' as const,
  displayName: 'Welcome',
  category: 'service' as const,
  providerRef: { flowId: 'abc123' },
  approvedText: 'Hi {#var#}',
  variables: [{ slot: 'var1', value: '{{profile.firstName}}' }],
};

let now = START;
const templates = createTemplateRegistry({ sql, now: () => now });
const tick = () => runScheduleTick({ sql, now: () => now, pinTemplate });
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * MINUTE_MS);

async function insertAudience(projectId: string): Promise<string> {
  const [row] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.audiences (id, project_id, name, mode, created_by, version)
     VALUES (gen_random_uuid(), $1, 'a', 'dynamic', 'u1', $2) RETURNING id::text`,
    projectId,
    AUDIENCE_VERSION
  );
  return row?.id as string;
}

async function insertCampaign(opts: {
  projectId?: string;
  state?: string;
  sendKind?: 'now' | 'scheduled';
  sendAt?: Date;
  ifLate?: number;
  channel?: string;
  template?: unknown;
}): Promise<string> {
  const projectId = opts.projectId ?? 'p1';
  const [row] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, send_kind, send_at,
       if_late_minutes, confirm_threshold, created_by)
     VALUES (gen_random_uuid(), $1, 'c', $2, $7, $8::jsonb, $3::uuid, $4, $5, $6, 5000, 'u1')
     RETURNING id::text`,
    projectId,
    opts.state ?? 'scheduled',
    await insertAudience(projectId),
    opts.sendKind ?? 'scheduled',
    opts.sendAt ?? now,
    opts.ifLate ?? 60,
    opts.channel ?? 'push',
    JSON.stringify(opts.template ?? {})
  );
  return row?.id as string;
}

async function campaign(id: string) {
  const [row] = await sql.$queryRawUnsafe<
    {
      state: string;
      state_reason: string | null;
      audience_version: number | null;
      started_at: Date | null;
      materialize_state: string;
      template_version: number | null;
    }[]
  >(
    `SELECT state, state_reason, audience_version, started_at, materialize_state, template_version
     FROM marketing.campaigns WHERE id = $1::uuid`,
    id
  );
  return row;
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  now = START;
  await truncateMarketingTables([
    'campaigns',
    'audiences',
    'message_templates',
  ]);
});

describe('runScheduleTick', () => {
  it('a campaign due 59 minutes ago starts', async () => {
    const id = await insertCampaign({ sendAt: minutesAgo(59), ifLate: 60 });
    expect(await tick()).toEqual({ started: 1, missed: 0 });
    expect(await campaign(id)).toMatchObject({
      state: 'running',
      audience_version: AUDIENCE_VERSION,
      started_at: now,
      materialize_state: 'not_started',
    });
    const counters = await sql.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM marketing.campaign_counters WHERE campaign_id = $1::uuid',
      id
    );
    expect(counters).toHaveLength(1);
  });

  it('a campaign due 61 minutes ago with ifLate 60 is missed with reason late', async () => {
    const id = await insertCampaign({ sendAt: minutesAgo(61), ifLate: 60 });
    expect(await tick()).toEqual({ started: 0, missed: 1 });
    expect(await campaign(id)).toMatchObject({
      state: 'missed',
      state_reason: 'late',
    });
  });

  it('a late campaign is missed even when its project is busy', async () => {
    await insertCampaign({ state: 'running' });
    const id = await insertCampaign({ sendAt: minutesAgo(61), ifLate: 60 });
    expect(await tick()).toEqual({ started: 0, missed: 1 });
    expect((await campaign(id))?.state).toBe('missed');
  });

  it('ifLate 0 misses anything not claimed at its minute', async () => {
    const onTime = await insertCampaign({
      projectId: 'p1',
      sendAt: new Date(now.getTime() - 59 * SECOND_MS),
      ifLate: 0,
    });
    const late = await insertCampaign({
      projectId: 'p2',
      sendAt: minutesAgo(1),
      ifLate: 0,
    });
    expect(await tick()).toEqual({ started: 1, missed: 1 });
    expect((await campaign(onTime))?.state).toBe('running');
    expect((await campaign(late))?.state).toBe('missed');
  });

  it('a campaign not yet due is left alone', async () => {
    const id = await insertCampaign({ sendAt: new Date(now.getTime() + 1) });
    expect(await tick()).toEqual({ started: 0, missed: 0 });
    expect((await campaign(id))?.state).toBe('scheduled');
  });

  it('a queued now campaign starts when the running one completes and is never missed', async () => {
    const running = await insertCampaign({ state: 'running' });
    const queued = await insertCampaign({
      sendKind: 'now',
      sendAt: now,
      ifLate: 0,
    });
    now = new Date(now.getTime() + 180 * MINUTE_MS);
    expect(await tick()).toEqual({ started: 0, missed: 0 });
    expect((await campaign(queued))?.state).toBe('scheduled');

    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET state = 'completed' WHERE id = $1::uuid`,
      running
    );
    expect(await tick()).toEqual({ started: 1, missed: 0 });
    expect(await campaign(queued)).toMatchObject({
      state: 'running',
      audience_version: AUDIENCE_VERSION,
    });
  });

  it('two runScheduleTick calls in parallel start each due campaign once', async () => {
    await sql.$executeRawUnsafe(
      `WITH a AS (
         INSERT INTO marketing.audiences (id, project_id, name, mode, created_by, version)
         SELECT gen_random_uuid(), 'p' || n, 'a', 'dynamic', 'u1', $2 FROM generate_series(1, $1::int) AS n
         RETURNING id, project_id)
       INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, send_kind,
         send_at, if_late_minutes, confirm_threshold, created_by)
       SELECT gen_random_uuid(), a.project_id, 'c', 'scheduled', 'push', '{}'::jsonb, a.id, 'scheduled', $3, 60,
         5000, 'u1' FROM a`,
      PARALLEL_PROJECTS,
      AUDIENCE_VERSION,
      now
    );
    const results = await Promise.all([tick(), tick(), tick()]);
    const started = results.reduce((sum, result) => sum + result.started, 0);
    expect(started).toBe(PARALLEL_PROJECTS);
    const states = await sql.$queryRawUnsafe<{ state: string; n: number }[]>(
      'SELECT state, count(*)::int AS n FROM marketing.campaigns GROUP BY state'
    );
    expect(states).toEqual([{ state: 'running', n: PARALLEL_PROJECTS }]);
  });

  it('two due campaigns of one project: one running, one still scheduled', async () => {
    const first = await insertCampaign({ sendAt: minutesAgo(2) });
    const second = await insertCampaign({ sendAt: minutesAgo(1) });
    expect(await tick()).toEqual({ started: 1, missed: 0 });
    expect((await campaign(first))?.state).toBe('running');
    expect((await campaign(second))?.state).toBe('scheduled');
    expect(await tick()).toEqual({ started: 0, missed: 0 });
  });

  it('a busy project leaves its due campaign scheduled without hiding other projects', async () => {
    await insertCampaign({ projectId: 'busy', state: 'paused' });
    const waiting = await insertCampaign({
      projectId: 'busy',
      sendAt: minutesAgo(5),
    });
    const other = await insertCampaign({ projectId: 'free' });
    const result = await runScheduleTick({
      sql,
      now: () => now,
      pinTemplate,
      batch: 1,
    });
    expect(result).toEqual({ started: 1, missed: 0 });
    expect((await campaign(waiting))?.state).toBe('scheduled');
    expect((await campaign(other))?.state).toBe('running');
  });

  it('a due campaign starts pinned to its template version', async () => {
    const push = await insertCampaign({ projectId: 'p2' });
    const template = await templates.create(CTX, SMS_TEMPLATE);
    await templates.update(CTX, template.templateId, SMS_TEMPLATE, 1);
    const sms = await insertCampaign({
      channel: 'sms',
      template: { templateId: template.templateId },
    });
    expect(await tick()).toEqual({ started: 2, missed: 0 });
    expect(await campaign(sms)).toMatchObject({
      state: 'running',
      template_version: 2,
    });
    expect((await campaign(push))?.template_version).toBe(0);
  });

  it('a scheduled sms campaign whose template was disabled fails with template_unavailable when due', async () => {
    const template = await templates.create(CTX, SMS_TEMPLATE);
    const id = await insertCampaign({
      channel: 'sms',
      template: { templateId: template.templateId },
      sendAt: minutesAgo(1),
    });
    await templates.setEnabled(CTX, template.templateId, false);
    expect(await tick()).toEqual({ started: 0, missed: 0 });
    expect(await campaign(id)).toMatchObject({
      state: 'failed',
      state_reason: 'template_unavailable',
      template_version: null,
    });
  });
  it('a bad campaign and a healthy one in one batch: the bad one fails and the healthy one still starts', async () => {
    const bad = await insertCampaign({
      channel: 'sms',
      template: { templateId: 'not-a-uuid' },
      sendAt: minutesAgo(2),
    });
    const healthy = await insertCampaign({
      projectId: 'p2',
      sendAt: minutesAgo(1),
    });
    expect(await tick()).toEqual({ started: 1, missed: 0 });
    expect(await campaign(bad)).toMatchObject({
      state: 'failed',
      state_reason: 'template_unavailable',
    });
    expect((await campaign(healthy))?.state).toBe('running');
  });

  it('a queued start-now sms campaign gets its template pinned when it starts', async () => {
    const running = await insertCampaign({ state: 'running' });
    const template = await templates.create(CTX, SMS_TEMPLATE);
    await templates.update(CTX, template.templateId, SMS_TEMPLATE, 1);
    const queued = await insertCampaign({
      channel: 'sms',
      template: { templateId: template.templateId },
      sendKind: 'now',
    });
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET state = 'completed' WHERE id = $1::uuid`,
      running
    );
    expect(await tick()).toEqual({ started: 1, missed: 0 });
    expect(await campaign(queued)).toMatchObject({
      state: 'running',
      template_version: 2,
    });
  });
  it('a campaign whose template pin throws stays scheduled and a healthy one in the same batch still starts', async () => {
    const broken = await insertCampaign({ sendAt: minutesAgo(2) });
    const healthy = await insertCampaign({
      projectId: 'p2',
      sendAt: minutesAgo(1),
    });
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    let result: Awaited<ReturnType<typeof runScheduleTick>>;
    let line = '';
    try {
      result = await runScheduleTick({
        sql,
        now: () => now,
        pinTemplate: (tx, projectId, channel, template) =>
          projectId === 'p1'
            ? Promise.reject(new Error('registry exploded'))
            : pinTemplate(tx, projectId, channel, template),
      });
      line = logged.mock.calls.flat().map(String).join(' ');
    } finally {
      logged.mockRestore();
    }
    expect(result).toEqual({ started: 1, missed: 0 });
    expect((await campaign(broken))?.state).toBe('scheduled');
    expect((await campaign(healthy))?.state).toBe('running');
    expect(line).toContain(broken);
    expect(line).toContain('registry exploded');
  });
});
