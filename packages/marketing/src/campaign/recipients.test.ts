import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DeliveryOutcome } from '../channels/batch';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import type { Queryable } from '../engine/engine';
import {
  capLockKey,
  type EffectiveCap,
  ledgerRef,
  lockCap,
  recordLedger,
} from '../engine/ledger';
import {
  CAP_LOCK_CHUNK,
  claimRecipients,
  MAX_SEND_ATTEMPTS,
  markLeasedFinal,
  markOutcomes,
  markSending,
  RECIPIENT_STATUSES,
  reapExpiredLeases,
  releaseLeased,
  SENDING_LEASE_MS,
} from './recipients';

const PROJECT = 'p1';
const CHANNEL = 'push';
const NOW = new Date('2026-11-03T10:00:00.000Z');
const LEASE_MS = 120_000;
const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CAP_ONE_PER_DAY: EffectiveCap = {
  max: 1,
  periodSeconds: 86_400,
  scope: 'channel',
};
const LOCK_POLL_MS = 20;
const LOCK_WAIT_LIMIT_MS = 5000;

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

async function insertCampaign(
  state = 'running',
  materializeState = 'done',
  queued = 0,
  projectId = PROJECT
): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by, materialize_state)
     VALUES ($1::uuid, $2, 'c', $3, 'push', '{}'::jsonb, 5000, 'u', $4)`,
    id,
    projectId,
    state,
    materializeState
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.campaign_counters (campaign_id, queued) VALUES ($1::uuid, $2)',
    id,
    queued
  );
  return id;
}

async function insertRecipients(
  campaignId: string,
  profileIds: string[],
  dueAt: Date = NOW
): Promise<void> {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, due_at)
     SELECT $1::uuid, p, $2, $3::timestamptz FROM unnest($4::text[]) AS p`,
    campaignId,
    PROJECT,
    dueAt.toISOString(),
    profileIds
  );
}

async function setState(campaignId: string, state: string): Promise<void> {
  await sql.$executeRawUnsafe(
    'UPDATE marketing.campaigns SET state = $2 WHERE id = $1::uuid',
    campaignId,
    state
  );
}

interface RecipientRow {
  profile_id: string;
  status: string;
  reason: string | null;
  attempt: number;
  due_at: Date;
  lease_until: Date | null;
  lease_token: string | null;
  provider_ref: string | null;
  sent_at: Date | null;
}

async function rows(campaignId: string): Promise<Map<string, RecipientRow>> {
  const result = await sql.$queryRawUnsafe<RecipientRow[]>(
    `SELECT profile_id, status, reason, attempt, due_at, lease_until, lease_token::text, provider_ref, sent_at
     FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid`,
    campaignId
  );
  return new Map(result.map((row) => [row.profile_id, row]));
}

async function row(campaignId: string, profileId: string) {
  const found = (await rows(campaignId)).get(profileId);
  if (!found) {
    throw new Error(`no recipient ${profileId}`);
  }
  return found;
}

async function counters(campaignId: string) {
  const [result] = await sql.$queryRawUnsafe<
    {
      queued: number;
      sent: number;
      failed: number;
      skipped: number;
      uncertain: number;
    }[]
  >(
    'SELECT queued, sent, failed, skipped, uncertain FROM marketing.campaign_counters WHERE campaign_id = $1::uuid',
    campaignId
  );
  return result;
}

async function ledgerRefs(): Promise<string[]> {
  const result = await sql.$queryRawUnsafe<{ source_ref: string }[]>(
    'SELECT source_ref FROM marketing.send_ledger ORDER BY source_ref'
  );
  return result.map((r) => r.source_ref);
}

async function ledgerSentAt(ref: string): Promise<Date | undefined> {
  const [result] = await sql.$queryRawUnsafe<{ sent_at: Date }[]>(
    'SELECT sent_at FROM marketing.send_ledger WHERE source_ref = $1',
    ref
  );
  return result?.sent_at;
}

function claim(campaignId: string, limit = 500, now = NOW) {
  return claimRecipients(sql, { campaignId, limit, now, leaseMs: LEASE_MS });
}

function send(
  campaignId: string,
  token: string,
  profileIds: string[],
  cap: EffectiveCap | null = null,
  now = NOW
) {
  return markSending(sql, {
    campaignId,
    projectId: PROJECT,
    channel: CHANNEL,
    token,
    profileIds,
    now,
    cap,
  });
}

function outcomes(
  campaignId: string,
  token: string,
  list: DeliveryOutcome[],
  now = NOW,
  retryAt = now
) {
  return markOutcomes(sql, {
    campaignId,
    token,
    outcomes: list,
    now,
    retryAt,
  });
}

// Claims and marks sending in one go; returns the token.
async function toSending(campaignId: string, now = NOW): Promise<string> {
  const claimed = await claim(campaignId, 500, now);
  await send(campaignId, claimed.token, claimed.profileIds, null, now);
  return claimed.token;
}

async function setAttempt(campaignId: string, profileId: string, n: number) {
  await sql.$executeRawUnsafe(
    'UPDATE marketing.campaign_recipients SET attempt = $3 WHERE campaign_id = $1::uuid AND profile_id = $2',
    campaignId,
    profileId,
    n
  );
}

// Resolves once a session of this database waits for the advisory lock on `key` (an 8-byte lock: classid is
// the high half of its hash, objid the low half): the code under test reached that lock and blocks on it.
async function waitForAdvisoryLockWaiter(key: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_LIMIT_MS;
  while (Date.now() < deadline) {
    const [waiting] = await sql.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_locks l, (SELECT hashtextextended($1, 0) AS h) k
       WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
         AND l.classid::bigint = (k.h >> 32) & 4294967295 AND l.objid::bigint = k.h & 4294967295
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      key
    );
    if ((waiting?.n ?? 0) > 0) {
      return;
    }
    await Bun.sleep(LOCK_POLL_MS);
  }
  throw new Error(
    `no session waited on an advisory lock within ${LOCK_WAIT_LIMIT_MS} ms`
  );
}

describe('campaign recipients', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(async () => {
    await resetMarketingTables();
  });

  it('exports the status list of the table', () => {
    expect([...RECIPIENT_STATUSES]).toEqual([
      'pending',
      'leased',
      'sending',
      'sent',
      'uncertain',
      'failed',
      'skipped',
    ]);
    expect(MAX_SEND_ATTEMPTS).toBe(5);
    expect(SENDING_LEASE_MS).toBe(61_000);
  });

  it('two parallel claims of 500 over 800 pending rows return disjoint sets totalling 800', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ids('u', 800));
    const [a, b] = await Promise.all([claim(id), claim(id)]);
    const all = new Set([...a.profileIds, ...b.profileIds]);
    expect(a.profileIds.length + b.profileIds.length).toBe(800);
    expect(all.size).toBe(800);
    expect(a.token).not.toBe(b.token);
    expect(a.leaseUntil.getTime()).toBe(NOW.getTime() + LEASE_MS);
  });

  it('rows due in the future are not claimed', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['now']);
    await insertRecipients(id, ['later'], at(SECOND_MS));
    const claimed = await claim(id);
    expect(claimed.profileIds).toEqual(['now']);
  });

  it('claim returns nothing for a paused campaign or one still materialising', async () => {
    const paused = await insertCampaign('paused');
    // One active campaign per project, so the second one lives in another project.
    const materialising = await insertCampaign(
      'running',
      'in_progress',
      0,
      'p2'
    );
    await insertRecipients(paused, ['a']);
    await insertRecipients(materialising, ['b']);
    expect((await claim(paused)).profileIds).toEqual([]);
    expect((await claim(materialising)).profileIds).toEqual([]);
    expect((await row(paused, 'a')).status).toBe('pending');
  });

  it('markSending on a paused campaign changes nothing and reports notRunning', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const claimed = await claim(id);
    await setState(id, 'paused');
    const result = await send(id, claimed.token, claimed.profileIds);
    expect(result).toEqual({ sending: [], capped: [], notRunning: true });
    expect((await row(id, 'a')).status).toBe('leased');
    expect(await ledgerRefs()).toEqual([]);
  });

  it('markSending with a cap of 1 per day skips a person with a ledger row today as capped and writes ledger rows for the rest', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b', 'c']);
    await recordLedger(sql, [
      {
        sourceRef: ledgerRef.step(randomUUID(), 0),
        projectId: PROJECT,
        profileId: 'b',
        channel: CHANNEL,
        sentAt: at(-HOUR_MS),
      },
    ]);
    const claimed = await claim(id);
    const result = await send(
      id,
      claimed.token,
      claimed.profileIds,
      CAP_ONE_PER_DAY
    );
    expect(result.notRunning).toBe(false);
    expect(result.capped).toEqual(['b']);
    expect(result.sending.sort()).toEqual(['a', 'c']);
    const b = await row(id, 'b');
    expect([b.status, b.reason]).toEqual(['skipped', 'capped']);
    const a = await row(id, 'a');
    expect(a.status).toBe('sending');
    expect(a.attempt).toBe(1);
    expect(a.lease_until?.getTime()).toBe(NOW.getTime() + SENDING_LEASE_MS);
    const refs = await ledgerRefs();
    expect(refs).toContain(ledgerRef.campaign(id, 'a'));
    expect(refs).toContain(ledgerRef.campaign(id, 'c'));
    expect(refs).not.toContain(ledgerRef.campaign(id, 'b'));
    expect((await counters(id))?.skipped).toBe(1);
  });

  it('markSending without a cap still writes a ledger row per sending row', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b']);
    await toSending(id);
    expect(await ledgerRefs()).toEqual(
      [ledgerRef.campaign(id, 'a'), ledgerRef.campaign(id, 'b')].sort()
    );
  });

  it('markSending with an old token changes nothing', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    await claim(id);
    const result = await send(id, randomUUID(), ['a']);
    expect(result).toEqual({ sending: [], capped: [], notRunning: false });
    expect((await row(id, 'a')).status).toBe('leased');
    expect(await ledgerRefs()).toEqual([]);
  });

  it('a cancelled campaign’s leased rows (plan 1 cancel marks them skipped) cannot be marked sending', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const claimed = await claim(id);
    await setState(id, 'cancelled');
    await sql.$executeRawUnsafe(
      `UPDATE marketing.campaign_recipients SET status = 'skipped', reason = 'cancelled', lease_until = NULL
       WHERE campaign_id = $1::uuid AND status IN ('pending', 'leased')`,
      id
    );
    const result = await send(id, claimed.token, ['a']);
    expect(result.sending).toEqual([]);
    expect(result.notRunning).toBe(true);
    // Even if the campaign were running again, the fence is on status too.
    await setState(id, 'running');
    expect((await send(id, claimed.token, ['a'])).sending).toEqual([]);
    expect((await row(id, 'a')).status).toBe('skipped');
  });

  it('markSending waits for a journey holding the cap lock', async () => {
    // One running campaign per project, so the other sender is a journey holding the same cap lock.
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const claimed = await claim(id);
    let journeyLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      journeyLocked = resolve;
    });
    let finishJourney: () => void = () => undefined;
    const journeyMayFinish = new Promise<void>((resolve) => {
      finishJourney = resolve;
    });
    const journey = sql.$transaction(
      async (tx: Queryable) => {
        await lockCap(tx, {
          projectId: PROJECT,
          profileId: 'a',
          channel: CHANNEL,
          scope: 'channel',
        });
        journeyLocked();
        await journeyMayFinish;
        await recordLedger(tx, [
          {
            sourceRef: ledgerRef.step(randomUUID(), 0),
            projectId: PROJECT,
            profileId: 'a',
            channel: CHANNEL,
            sentAt: NOW,
          },
        ]);
      },
      { timeout: 10_000 }
    );
    await locked;
    const sending = send(id, claimed.token, ['a'], CAP_ONE_PER_DAY);
    await waitForAdvisoryLockWaiter(
      capLockKey({
        projectId: PROJECT,
        profileId: 'a',
        channel: CHANNEL,
        scope: 'channel',
      })
    );
    finishJourney();
    await journey;
    const result = await sending;
    expect(result.capped).toEqual(['a']);
    expect(result.sending).toEqual([]);
  });

  it('a capped batch larger than one lock chunk marks every row correctly', async () => {
    const people = Array.from(
      { length: 250 },
      (_, i) => `c-${String(i).padStart(3, '0')}`
    );
    // One person already at the cap in each chunk of 100.
    const alreadySent = ['c-005', 'c-150', 'c-249'];
    expect(CAP_LOCK_CHUNK).toBe(100);
    const id = await insertCampaign('running', 'done', people.length);
    await insertRecipients(id, people);
    await recordLedger(
      sql,
      alreadySent.map((profileId) => ({
        sourceRef: ledgerRef.step(randomUUID(), 0),
        projectId: PROJECT,
        profileId,
        channel: CHANNEL,
        sentAt: at(-HOUR_MS),
      }))
    );
    const claimed = await claim(id);
    const result = await send(
      id,
      claimed.token,
      claimed.profileIds,
      CAP_ONE_PER_DAY
    );
    expect(result.notRunning).toBe(false);
    expect(result.capped.sort()).toEqual(alreadySent);
    expect(result.sending.length).toBe(247);
    const all = await rows(id);
    const statuses = people.map((p) => all.get(p)?.status);
    expect(statuses.filter((s) => s === 'sending').length).toBe(247);
    expect((await ledgerRefs()).length).toBe(250);
    expect((await counters(id))?.skipped).toBe(3);
  });

  it('markOutcomes maps each outcome as listed and updates counters once per call', async () => {
    const id = await insertCampaign('running', 'done', 6);
    const people = ['sent', 'failed', 'uncertain', 'retry', 'rate', 'chan'];
    await insertRecipients(id, people);
    const token = await toSending(id);
    const markAt = at(5 * SECOND_MS);
    const retryAt = at(10 * SECOND_MS);
    const result = await outcomes(
      id,
      token,
      [
        { profileId: 'sent', outcome: 'sent', providerRef: 'pr-1' },
        { profileId: 'failed', outcome: 'failed', reason: 'bad token' },
        {
          profileId: 'uncertain',
          outcome: 'uncertain',
          reason: 'timeout',
          providerRef: 'pr-2',
        },
        { profileId: 'retry', outcome: 'retry', reason: 'smtp ECONNREFUSED' },
        {
          profileId: 'rate',
          outcome: 'rate_limited',
          reason: 'http 429',
          retryAfterMs: 45 * SECOND_MS,
        },
        { profileId: 'chan', outcome: 'channel_error', reason: 'smtp EAUTH' },
      ],
      markAt,
      retryAt
    );
    expect(result.applied).toBe(6);
    const all = await rows(id);
    const sent = all.get('sent');
    expect([sent?.status, sent?.provider_ref]).toEqual(['sent', 'pr-1']);
    expect(sent?.sent_at?.getTime()).toBe(markAt.getTime());
    expect(
      (await ledgerSentAt(ledgerRef.campaign(id, 'sent')))?.getTime()
    ).toBe(markAt.getTime());
    const failed = all.get('failed');
    expect([failed?.status, failed?.reason]).toEqual(['failed', 'bad token']);
    const uncertain = all.get('uncertain');
    expect([
      uncertain?.status,
      uncertain?.reason,
      uncertain?.provider_ref,
    ]).toEqual(['uncertain', 'timeout', 'pr-2']);
    const retry = all.get('retry');
    expect([retry?.status, retry?.reason, retry?.lease_token]).toEqual([
      'pending',
      null,
      null,
    ]);
    // Attempt 1: 30 s of backoff from the mark beats the shared retryAt.
    expect(retry?.due_at.getTime()).toBe(markAt.getTime() + 30 * SECOND_MS);
    const rate = all.get('rate');
    expect([rate?.status, rate?.reason]).toEqual(['pending', 'rate_limited']);
    expect(rate?.due_at.getTime()).toBe(markAt.getTime() + 45 * SECOND_MS);
    const chan = all.get('chan');
    expect([chan?.status, chan?.reason]).toEqual(['pending', 'channel_error']);
    expect(chan?.due_at.getTime()).toBe(markAt.getTime() + 60 * SECOND_MS);
    expect(await ledgerRefs()).toEqual(
      [
        ledgerRef.campaign(id, 'sent'),
        ledgerRef.campaign(id, 'uncertain'),
      ].sort()
    );
    expect(await counters(id)).toEqual({
      queued: 6,
      sent: 1,
      failed: 1,
      skipped: 0,
      uncertain: 1,
    });
  });

  it('a retry at attempt 5 becomes failed max_attempts', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const token = await toSending(id);
    await setAttempt(id, 'a', MAX_SEND_ATTEMPTS);
    await outcomes(id, token, [{ profileId: 'a', outcome: 'retry' }]);
    const a = await row(id, 'a');
    expect([a.status, a.reason]).toEqual(['failed', 'max_attempts']);
    expect(await ledgerRefs()).toEqual([]);
    expect((await counters(id))?.failed).toBe(1);
  });

  it('a retry at attempt 2 is due no earlier than 60 s from now', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const token = await toSending(id);
    await setAttempt(id, 'a', 2);
    await outcomes(id, token, [{ profileId: 'a', outcome: 'retry' }]);
    const a = await row(id, 'a');
    expect(a.status).toBe('pending');
    expect(a.due_at.getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() + 60 * SECOND_MS
    );
  });

  it('a rate_limited outcome without retry-after backs off at least 30 s', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const token = await toSending(id);
    await outcomes(id, token, [{ profileId: 'a', outcome: 'rate_limited' }]);
    const a = await row(id, 'a');
    expect([a.status, a.attempt]).toEqual(['pending', 0]);
    expect(a.due_at.getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() + 30 * SECOND_MS
    );
  });

  it('five rate_limited outcomes in a row never reach max_attempts', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b']);
    let now = NOW;
    for (let round = 0; round < MAX_SEND_ATTEMPTS + 1; round++) {
      const token = await toSending(id, now);
      await outcomes(id, token, [
        { profileId: 'a', outcome: 'rate_limited', reason: 'http 429' },
        { profileId: 'b', outcome: 'channel_error', reason: 'smtp EAUTH' },
      ]);
      now = new Date(now.getTime() + HOUR_MS);
    }
    const a = await row(id, 'a');
    const b = await row(id, 'b');
    expect([a.status, a.attempt]).toEqual(['pending', 0]);
    expect([b.status, b.attempt]).toEqual(['pending', 0]);
  });

  it('six deadline, breaker or unreachable retries leave the row pending with its attempts given back', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b', 'c', 'd', 'e']);
    let now = NOW;
    for (let round = 0; round < MAX_SEND_ATTEMPTS + 1; round++) {
      const token = await toSending(id, now);
      await outcomes(
        id,
        token,
        [
          { profileId: 'a', outcome: 'retry', reason: 'deadline' },
          { profileId: 'b', outcome: 'retry', reason: 'breaker' },
          { profileId: 'c', outcome: 'retry', reason: 'exception' },
          { profileId: 'd', outcome: 'retry', reason: 'smtp ECONNREFUSED' },
          { profileId: 'e', outcome: 'retry', reason: 'not_sent' },
        ],
        now
      );
      now = new Date(now.getTime() + HOUR_MS);
    }
    const a = await row(id, 'a');
    expect([a.status, a.attempt, a.reason]).toEqual(['pending', 0, null]);
    expect(a.due_at.getTime()).toBeGreaterThanOrEqual(
      now.getTime() - HOUR_MS + 30 * SECOND_MS
    );
    const b = await row(id, 'b');
    expect([b.status, b.attempt]).toEqual(['pending', 0]);
    const c = await row(id, 'c');
    expect([c.status, c.reason]).toEqual(['failed', 'max_attempts']);
    const d = await row(id, 'd');
    expect([d.status, d.attempt]).toEqual(['pending', 0]);
    const e = await row(id, 'e');
    expect([e.status, e.attempt]).toEqual(['pending', 0]);
  });

  it('a late retry outcome on a cancelled campaign ends skipped, not pending', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b', 'c']);
    const token = await toSending(id);
    await setState(id, 'cancelled');
    await outcomes(id, token, [
      { profileId: 'a', outcome: 'retry' },
      { profileId: 'b', outcome: 'rate_limited' },
      { profileId: 'c', outcome: 'sent' },
    ]);
    const a = await row(id, 'a');
    const b = await row(id, 'b');
    expect([a.status, a.reason]).toEqual(['skipped', 'cancelled']);
    expect([b.status, b.reason]).toEqual(['skipped', 'cancelled']);
    expect((await row(id, 'c')).status).toBe('sent');
    expect(await ledgerRefs()).toEqual([ledgerRef.campaign(id, 'c')]);
    const result = await counters(id);
    expect([result?.skipped, result?.sent]).toEqual([2, 1]);
  });

  it('a late markOutcomes after the reaper set uncertain changes nothing and does not double-count', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    const token = await toSending(id);
    const reaped = await reapExpiredLeases(sql, at(SENDING_LEASE_MS + 1));
    expect(reaped).toEqual({ released: 0, uncertain: 1, campaignIds: [id] });
    const result = await outcomes(
      id,
      token,
      [{ profileId: 'a', outcome: 'sent' }],
      at(SENDING_LEASE_MS + 2)
    );
    expect(result.applied).toBe(0);
    const a = await row(id, 'a');
    expect([a.status, a.reason]).toEqual(['uncertain', 'lease_expired']);
    expect(await counters(id)).toMatchObject({ sent: 0, uncertain: 1 });
    expect(await ledgerRefs()).toEqual([ledgerRef.campaign(id, 'a')]);
  });

  it('releaseLeased returns only leased rows of that token', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b']);
    const first = await claim(id, 1);
    const second = await claim(id, 1);
    await send(id, second.token, second.profileIds);
    const due = at(HOUR_MS);
    expect(await releaseLeased(sql, second.token, due)).toBe(0);
    expect(await releaseLeased(sql, first.token, due)).toBe(1);
    const released = await row(id, first.profileIds[0] ?? '');
    expect([released.status, released.lease_token, released.attempt]).toEqual([
      'pending',
      null,
      0,
    ]);
    expect(released.due_at.getTime()).toBe(due.getTime());
    expect((await row(id, second.profileIds[0] ?? '')).status).toBe('sending');
  });

  it('markLeasedFinal finalises only leased rows of the token and counts them', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a', 'b']);
    const claimed = await claim(id);
    expect(
      await markLeasedFinal(sql, randomUUID(), 'skipped', [
        { profileId: 'a', reason: 'suppressed' },
      ])
    ).toBe(0);
    expect(
      await markLeasedFinal(sql, claimed.token, 'skipped', [
        { profileId: 'a', reason: 'suppressed' },
      ])
    ).toBe(1);
    expect(
      await markLeasedFinal(sql, claimed.token, 'failed', [
        { profileId: 'b', reason: 'render_failed' },
      ])
    ).toBe(1);
    const a = await row(id, 'a');
    expect([a.status, a.reason]).toEqual(['skipped', 'suppressed']);
    expect((await row(id, 'b')).status).toBe('failed');
    expect(await counters(id)).toMatchObject({ skipped: 1, failed: 1 });
  });

  it('reap turns an expired sending row uncertain and an expired leased row pending', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['leased', 'sending', 'fresh']);
    const leasedClaim = await claim(id, 1);
    const sendingClaim = await claim(id, 1);
    await send(id, sendingClaim.token, sendingClaim.profileIds);
    const leasedId = leasedClaim.profileIds[0] ?? '';
    const sendingId = sendingClaim.profileIds[0] ?? '';
    // The third row holds a lease that is still valid when the reaper runs.
    const reapAt = at(LEASE_MS + 1);
    const freshClaim = await claim(id, 1, at(LEASE_MS));
    const result = await reapExpiredLeases(sql, reapAt);
    expect(result).toEqual({ released: 1, uncertain: 1, campaignIds: [id] });
    const leased = await row(id, leasedId);
    expect([leased.status, leased.lease_token]).toEqual(['pending', null]);
    const sending = await row(id, sendingId);
    expect([sending.status, sending.reason]).toEqual([
      'uncertain',
      'lease_expired',
    ]);
    expect(await ledgerRefs()).toEqual([ledgerRef.campaign(id, sendingId)]);
    expect((await row(id, freshClaim.profileIds[0] ?? '')).status).toBe(
      'leased'
    );
    expect(await reapExpiredLeases(sql, reapAt)).toEqual({
      released: 0,
      uncertain: 0,
      campaignIds: [],
    });
  });

  it('reap skips an expired leased row of a cancelled campaign instead of re-queueing it', async () => {
    const id = await insertCampaign();
    await insertRecipients(id, ['a']);
    await claim(id);
    await setState(id, 'cancelled');
    await reapExpiredLeases(sql, at(DAY_MS));
    const a = await row(id, 'a');
    expect([a.status, a.reason]).toEqual(['skipped', 'cancelled']);
    expect((await counters(id))?.skipped).toBe(1);
  });

  it('counters equal a fresh COUNT(*) GROUP BY status after a mixed sequence of marks', async () => {
    const people = ids('m', 12);
    const id = await insertCampaign('running', 'done', people.length);
    await insertRecipients(id, people);
    await recordLedger(sql, [
      {
        sourceRef: ledgerRef.step(randomUUID(), 0),
        projectId: PROJECT,
        profileId: 'm-0',
        channel: CHANNEL,
        sentAt: NOW,
      },
    ]);
    const first = await claim(id, 6);
    await markLeasedFinal(sql, first.token, 'skipped', [
      { profileId: first.profileIds[5] ?? '', reason: 'suppressed' },
    ]);
    await send(id, first.token, first.profileIds, CAP_ONE_PER_DAY);
    const [s0, s1, s2, s3] = first.profileIds.filter((p) => p !== 'm-0');
    await outcomes(id, first.token, [
      { profileId: s0 ?? '', outcome: 'sent' },
      { profileId: s1 ?? '', outcome: 'failed', reason: 'x' },
      { profileId: s2 ?? '', outcome: 'uncertain', reason: 'y' },
      { profileId: s3 ?? '', outcome: 'retry' },
      // A duplicate for a row already marked in this call is ignored.
      { profileId: s0 ?? '', outcome: 'failed', reason: 'dup' },
    ]);
    const second = await claim(id, 4);
    await send(id, second.token, second.profileIds);
    await reapExpiredLeases(sql, at(DAY_MS));
    await outcomes(id, second.token, [
      { profileId: second.profileIds[0] ?? '', outcome: 'sent' },
    ]);

    const counted = await sql.$queryRawUnsafe<{ status: string; n: number }[]>(
      `SELECT status, count(*)::int AS n FROM marketing.campaign_recipients
       WHERE campaign_id = $1::uuid GROUP BY status`,
      id
    );
    const byStatus = Object.fromEntries(counted.map((c) => [c.status, c.n]));
    expect(await counters(id)).toEqual({
      queued: people.length,
      sent: byStatus.sent ?? 0,
      failed: byStatus.failed ?? 0,
      skipped: byStatus.skipped ?? 0,
      uncertain: byStatus.uncertain ?? 0,
    });
    expect(byStatus.uncertain).toBeGreaterThan(1);
  });
});
