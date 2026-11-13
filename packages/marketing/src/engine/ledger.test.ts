import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import type { Queryable } from './engine';
import {
  type CapScope,
  capLockKey,
  countChannelSendsSince,
  countRecentSends,
  effectiveCap,
  ledgerRef,
  lockCap,
  purgeSendHistory,
  recordLedger,
} from './ledger';

const PROJECT = 'p1';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Long enough that, without the lock, the second transaction counts before the first inserts.
const RACE_PAUSE_MS = 150;
const RACERS = 2;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

async function ledgerRows() {
  return await sql.$queryRawUnsafe<{ source_ref: string; sent_at: Date }[]>(
    'SELECT source_ref, sent_at FROM marketing.send_ledger ORDER BY source_ref'
  );
}

async function insertCampaign(state: string, finishedAt: Date | null) {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by, finished_at)
     VALUES ($1::uuid, $2, 'c', $3, 'push', '{}'::jsonb, 5000, 'u', $4::timestamptz)`,
    id,
    PROJECT,
    state,
    finishedAt?.toISOString() ?? null
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status)
     VALUES ($1::uuid, 'u1', $2, 'sent')`,
    id,
    PROJECT
  );
  return id;
}

// Resolves once every racer has an open transaction, so neither can finish before the other starts.
function startingLine(racers: number) {
  let arrived = 0;
  let open: () => void = () => undefined;
  const allArrived = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived++;
    if (arrived === racers) {
      open();
    }
    await allArrived;
  };
}

// Admits a send only if the cap allows it, the way every sender must: lock, count, then write.
async function sendUnderCap(
  start: () => Promise<void>,
  channel: string,
  scope: CapScope,
  ref: string,
  takeLock: boolean
): Promise<boolean> {
  return await sql.$transaction(
    async (tx: Queryable) => {
      await tx.$queryRawUnsafe('SELECT 1');
      await start();
      if (takeLock) {
        await lockCap(tx, {
          projectId: PROJECT,
          profileId: 'u1',
          channel,
          scope,
        });
      }
      const counts = await countRecentSends(tx, {
        projectId: PROJECT,
        profileIds: ['u1'],
        channel: scope === 'all' ? null : channel,
        since: ago(DAY_MS),
      });
      await Bun.sleep(RACE_PAUSE_MS);
      if ((counts.get('u1') ?? 0) >= 1) {
        return false;
      }
      await recordLedger(tx, [
        {
          sourceRef: ref,
          projectId: PROJECT,
          profileId: 'u1',
          channel,
          sentAt: NOW,
        },
      ]);
      return true;
    },
    { timeout: 10_000 }
  );
}

describe('send ledger', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(async () => {
    await resetMarketingTables();
  });
  afterAll(async () => {
    await resetMarketingTables();
    await sql.$disconnect();
  });

  it('countRecentSends counts sent and uncertain-held rows inside the window and not older ones', async () => {
    await recordLedger(sql, [
      {
        sourceRef: 'campaign:c1:u1',
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'push',
        sentAt: ago(HOUR_MS),
      },
      {
        sourceRef: 'step:e1:0',
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'push',
        sentAt: ago(2 * HOUR_MS),
      },
      {
        sourceRef: 'step:e2:0',
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'push',
        sentAt: ago(2 * DAY_MS),
      },
      {
        sourceRef: 'step:e3:0',
        projectId: PROJECT,
        profileId: 'u2',
        channel: 'push',
        sentAt: ago(HOUR_MS),
      },
      {
        sourceRef: 'step:e4:0',
        projectId: 'other',
        profileId: 'u1',
        channel: 'push',
        sentAt: ago(HOUR_MS),
      },
    ]);
    const counts = await countRecentSends(sql, {
      projectId: PROJECT,
      profileIds: ['u1', 'u2', 'u3'],
      channel: 'push',
      since: ago(DAY_MS),
    });
    expect(counts.get('u1')).toBe(2);
    expect(counts.get('u2')).toBe(1);
    expect(counts.get('u3') ?? 0).toBe(0);
  });

  it('channel null counts every channel, a channel counts only that one', async () => {
    await recordLedger(sql, [
      {
        sourceRef: 'step:e1:0',
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'push',
        sentAt: ago(HOUR_MS),
      },
      {
        sourceRef: 'step:e1:1',
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'email',
        sentAt: ago(HOUR_MS),
      },
    ]);
    const args = { projectId: PROJECT, profileIds: ['u1'], since: ago(DAY_MS) };
    expect(
      (await countRecentSends(sql, { ...args, channel: null })).get('u1')
    ).toBe(2);
    expect(
      (await countRecentSends(sql, { ...args, channel: 'email' })).get('u1')
    ).toBe(1);
    expect(
      await countChannelSendsSince(sql, PROJECT, 'email', ago(DAY_MS))
    ).toBe(1);
    expect(await countChannelSendsSince(sql, PROJECT, 'sms', ago(DAY_MS))).toBe(
      0
    );
  });

  it("excludeRefs leaves out the caller's own row", async () => {
    const own = ledgerRef.step('e1', 0);
    await recordLedger(sql, [
      {
        sourceRef: own,
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'push',
        sentAt: ago(HOUR_MS),
      },
      {
        sourceRef: ledgerRef.campaign('c1', 'u1'),
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'push',
        sentAt: ago(HOUR_MS),
      },
    ]);
    const counts = await countRecentSends(sql, {
      projectId: PROJECT,
      profileIds: ['u1'],
      channel: 'push',
      since: ago(DAY_MS),
      excludeRefs: [own],
    });
    expect(counts.get('u1')).toBe(1);
    expect(own).toBe('step:e1:0');
    expect(ledgerRef.campaign('c1', 'u1')).toBe('campaign:c1:u1');
  });

  it('recordLedger twice for one ref keeps one row with the later time', async () => {
    const row = {
      sourceRef: 'step:e1:0',
      projectId: PROJECT,
      profileId: 'u1',
      channel: 'push',
    };
    await recordLedger(sql, [{ ...row, sentAt: ago(HOUR_MS) }]);
    await recordLedger(sql, [{ ...row, sentAt: NOW }]);
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sent_at.toISOString()).toBe(NOW.toISOString());
  });

  it("effectiveCap prefers the campaign's max and period and keeps the project scope", () => {
    const project = { max: 3, periodSeconds: 86_400, scope: 'all' as const };
    expect(effectiveCap({ max: 1, periodSeconds: 3600 }, project)).toEqual({
      max: 1,
      periodSeconds: 3600,
      scope: 'all',
    });
    expect(effectiveCap(null, project)).toEqual(project);
    expect(effectiveCap(null, { max: 3, periodSeconds: 60 })).toEqual({
      max: 3,
      periodSeconds: 60,
      scope: 'channel',
    });
    expect(effectiveCap({ max: 2, periodSeconds: 60 }, null)).toEqual({
      max: 2,
      periodSeconds: 60,
      scope: 'channel',
    });
    expect(effectiveCap(null, null)).toBeNull();
  });

  it('purgeSendHistory removes a 401-day-old ledger row and a 401-day-old recipient of a completed campaign, keeps a 399-day row and keeps recipients of a running campaign', async () => {
    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
    await recordLedger(sql, [
      {
        sourceRef: 'step:old:0',
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'push',
        sentAt: daysAgo(401),
      },
      {
        sourceRef: 'step:kept:0',
        projectId: PROJECT,
        profileId: 'u1',
        channel: 'push',
        sentAt: daysAgo(399),
      },
    ]);
    const completedOld = await insertCampaign('completed', daysAgo(401));
    const cancelledOld = await insertCampaign('cancelled', daysAgo(401));
    const completedRecent = await insertCampaign('completed', daysAgo(399));
    const running = await insertCampaign('running', null);

    expect(await purgeSendHistory(sql)).toEqual({ ledger: 1, recipients: 2 });

    expect((await ledgerRows()).map((row) => row.source_ref)).toEqual([
      'step:kept:0',
    ]);
    const recipients = await sql.$queryRawUnsafe<{ id: string }[]>(
      'SELECT campaign_id::text AS id FROM marketing.campaign_recipients ORDER BY 1'
    );
    expect(recipients.map((row) => row.id)).toEqual(
      [completedRecent, running].sort()
    );
    expect([completedOld, cancelledOld]).not.toContain(recipients[0]?.id);
  });

  it('two concurrent sends to one profile on different channels cannot both pass a cap of 1 with scope all', async () => {
    const start = startingLine(RACERS);
    const admitted = await Promise.all([
      sendUnderCap(start, 'push', 'all', 'step:e1:0', true),
      sendUnderCap(start, 'email', 'all', 'campaign:c1:u1', true),
    ]);
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
  });

  it('without the lock the same two sends both pass, so the test above proves the lock', async () => {
    const start = startingLine(RACERS);
    const admitted = await Promise.all([
      sendUnderCap(start, 'push', 'all', 'step:e1:0', false),
      sendUnderCap(start, 'email', 'all', 'campaign:c1:u1', false),
    ]);
    expect(admitted.filter(Boolean)).toHaveLength(2);
  });

  it('the cap lock key is per profile for scope all, per profile and channel for scope channel, and never the engine profile lock', () => {
    const key = (channel: string, scope: CapScope) =>
      capLockKey({ projectId: PROJECT, profileId: 'u1', channel, scope });
    expect(key('push', 'all')).toBe(key('email', 'all'));
    expect(key('push', 'channel')).not.toBe(key('email', 'channel'));
    expect(key('push', 'channel')).not.toBe(key('push', 'all'));
    const engineProfileKey = JSON.stringify([PROJECT, 'u1']);
    expect([key('push', 'all'), key('push', 'channel')]).not.toContain(
      engineProfileKey
    );
  });

  it('two concurrent sends on one channel cannot both pass a cap of 1 with scope channel', async () => {
    const start = startingLine(RACERS);
    const admitted = await Promise.all([
      sendUnderCap(start, 'push', 'channel', 'step:e1:0', true),
      sendUnderCap(start, 'push', 'channel', 'campaign:c1:u1', true),
    ]);
    expect(admitted.filter(Boolean)).toHaveLength(1);
  });
});
