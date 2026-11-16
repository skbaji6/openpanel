import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import type { NormalizedEvent } from '../events/normalize';
import { createConversionRecorder } from './conversions';
import { putTrackingSettings } from './settings';

const PROJECT = 'p1';
const EVENT = 'app_open';
const NOW = new Date('2026-11-15T12:00:00Z');
const DAY_MS = 86_400_000;
const FUTURE_MS = 10 * 60_000;
const SENT = '2026-11-01T09:00:00Z';
const daysAfterSent = (days: number) =>
  new Date(Date.parse(SENT) + days * DAY_MS);

async function configure(conversionEvent: string | null = EVENT) {
  await putTrackingSettings(sql, PROJECT, {
    publicUrl: null,
    campaignUrl: null,
    conversionEvent,
    conversionWindowDays: 7,
  });
}

async function insertMessage(
  ref: string,
  sentAt: string,
  overrides: {
    status?: string;
    accepted?: boolean;
    convertedAt?: string | null;
  } = {}
) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.message_tracking
       (source_ref, project_id, profile_id, status, sent_at, accepted_at, converted_at)
     VALUES ($1, $2, 'u1', $3, $4::timestamptz, $5::timestamptz, $6::timestamptz)`,
    ref,
    PROJECT,
    overrides.status ?? 'delivered',
    sentAt,
    overrides.accepted === false ? null : sentAt,
    overrides.convertedAt ?? null
  );
}

const open = (time: Date): NormalizedEvent => ({
  eventId: 'e',
  projectId: PROJECT,
  profileId: 'u1',
  name: EVENT,
  time,
  properties: {},
});

const recorder = () =>
  createConversionRecorder({ sql, now: () => NOW, ttlMs: 0 });

async function rowOf(ref: string) {
  const [row] = await sql.$queryRawUnsafe<
    { status: string; converted_at: Date | null }[]
  >(
    'SELECT status, converted_at FROM marketing.message_tracking WHERE source_ref = $1',
    ref
  );
  if (!row) {
    throw new Error('row missing');
  }
  return row;
}

describe('conversion recorder', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(async () => {
    await resetMarketingTables();
    await configure();
  });

  it('an app open 2 days after a delivered message converts it', async () => {
    await insertMessage('a', SENT);
    expect(await recorder().record([open(daysAfterSent(2))])).toBe(1);
    const row = await rowOf('a');
    expect(row.status).toBe('converted');
    expect(row.converted_at?.toISOString()).toBe(
      daysAfterSent(2).toISOString()
    );
  });

  it('a second app open converts nothing more', async () => {
    await insertMessage('a', SENT);
    await recorder().record([open(daysAfterSent(2))]);
    expect(await recorder().record([open(daysAfterSent(3))])).toBe(0);
    expect((await rowOf('a')).converted_at?.toISOString()).toBe(
      daysAfterSent(2).toISOString()
    );
  });

  it('an app open before the message or after the window converts nothing', async () => {
    await insertMessage('a', SENT);
    expect(await recorder().record([open(daysAfterSent(-1))])).toBe(0);
    expect(await recorder().record([open(daysAfterSent(7))])).toBe(0);
    expect((await rowOf('a')).status).toBe('delivered');
    expect(await recorder().record([open(daysAfterSent(0))])).toBe(1);
  });

  it('with an older delivered and a newer sent message the newer one converts', async () => {
    await insertMessage('old', '2026-10-31T09:00:00Z');
    await insertMessage('new', SENT, { status: 'sent' });
    await recorder().record([open(daysAfterSent(1))]);
    expect((await rowOf('new')).status).toBe('converted');
    expect((await rowOf('old')).status).toBe('delivered');
  });

  it('a newer provider-failed message is passed over and the older delivered one converts', async () => {
    await insertMessage('old', '2026-10-31T09:00:00Z');
    await insertMessage('new', SENT, { status: 'failed' });
    await recorder().record([open(daysAfterSent(1))]);
    expect((await rowOf('old')).status).toBe('converted');
    expect((await rowOf('new')).status).toBe('failed');
  });

  it('if the latest message is already converted an older one is not credited', async () => {
    await insertMessage('old', '2026-10-31T09:00:00Z');
    await insertMessage('new', SENT, {
      status: 'converted',
      convertedAt: '2026-11-01T10:00:00Z',
    });
    expect(await recorder().record([open(daysAfterSent(1))])).toBe(0);
    expect((await rowOf('old')).status).toBe('delivered');
  });

  it('replaying the same batch changes nothing', async () => {
    await insertMessage('a', SENT);
    const batch = [open(daysAfterSent(2))];
    expect(await recorder().record(batch)).toBe(1);
    expect(await recorder().record(batch)).toBe(0);
    expect((await rowOf('a')).converted_at?.toISOString()).toBe(
      daysAfterSent(2).toISOString()
    );
  });

  it('an event 10 minutes in the future is ignored', async () => {
    await insertMessage('a', '2026-11-14T09:00:00Z');
    const future = new Date(NOW.getTime() + FUTURE_MS);
    expect(await recorder().record([open(future)])).toBe(0);
    expect((await rowOf('a')).status).toBe('delivered');
    expect(await recorder().record([open(NOW)])).toBe(1);
  });

  it('a project without conversionEvent is ignored', async () => {
    await insertMessage('a', SENT);
    await configure(null);
    expect(await recorder().record([open(daysAfterSent(2))])).toBe(0);
    await configure('other_event');
    expect(await recorder().record([open(daysAfterSent(2))])).toBe(0);
    expect((await rowOf('a')).status).toBe('delivered');
  });

  it('a skipped or send-time failed message is never converted', async () => {
    await insertMessage('skipped', SENT, {
      status: 'skipped',
      accepted: false,
    });
    await insertMessage('failed', SENT, { status: 'failed', accepted: false });
    expect(await recorder().record([open(daysAfterSent(2))])).toBe(0);
    expect((await rowOf('skipped')).status).toBe('skipped');
    expect((await rowOf('failed')).status).toBe('failed');
  });

  it('two events for one profile in one batch convert once with the earlier time', async () => {
    await insertMessage('a', SENT);
    const changed = await recorder().record([
      open(daysAfterSent(3)),
      open(daysAfterSent(2)),
    ]);
    expect(changed).toBe(1);
    expect((await rowOf('a')).converted_at?.toISOString()).toBe(
      daysAfterSent(2).toISOString()
    );
  });
});
