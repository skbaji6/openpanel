import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import {
  applyDeliveryUpdates,
  type DeliveryUpdate,
  reduceUpdates,
} from './delivery';

const PROJECT = 'p1';
const REF = 'campaign:c1:u1';
const SENT_AT = '2026-11-15T09:00:00Z';
const T1 = new Date('2026-11-15T10:00:00Z');
const T2 = new Date('2026-11-15T11:00:00Z');

interface Row {
  status: string;
  reason: string | null;
  accepted_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  failed_at: Date | null;
}

async function insertRow(
  overrides: {
    ref?: string;
    project?: string;
    status?: string;
    acceptedAt?: string | null;
    failedAt?: string | null;
  } = {}
) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.message_tracking (source_ref, project_id, profile_id, status, sent_at, accepted_at, failed_at)
     VALUES ($1, $2, 'u1', $3, $4::timestamptz, $5::timestamptz, $6::timestamptz)`,
    overrides.ref ?? REF,
    overrides.project ?? PROJECT,
    overrides.status ?? 'sent',
    SENT_AT,
    overrides.acceptedAt === undefined ? SENT_AT : overrides.acceptedAt,
    overrides.failedAt ?? null
  );
}

async function readRow(ref = REF): Promise<Row> {
  const [row] = await sql.$queryRawUnsafe<Row[]>(
    `SELECT status, reason, accepted_at, delivered_at, read_at, failed_at
     FROM marketing.message_tracking WHERE source_ref = $1`,
    ref
  );
  if (!row) {
    throw new Error('row missing');
  }
  return row;
}

const update = (
  status: DeliveryUpdate['status'],
  at: Date,
  extra: Partial<DeliveryUpdate> = {}
): DeliveryUpdate => ({ sourceRef: REF, status, at, reason: null, ...extra });

const apply = (updates: DeliveryUpdate[], project = PROJECT) =>
  applyDeliveryUpdates(sql, project, updates);

describe('applyDeliveryUpdates', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);

  it('the same delivered report applied twice changes the row once', async () => {
    await insertRow();
    expect(await apply([update('delivered', T1)])).toBe(1);
    expect(await apply([update('delivered', T2)])).toBe(0);
    const row = await readRow();
    expect(row.status).toBe('delivered');
    expect(row.delivered_at?.toISOString()).toBe(T1.toISOString());
  });

  it('read then delivered leaves read with delivered_at = read time', async () => {
    await insertRow();
    await apply([update('read', T2)]);
    expect(await apply([update('delivered', T1)])).toBe(0);
    const row = await readRow();
    expect(row.status).toBe('read');
    expect(row.delivered_at?.toISOString()).toBe(T2.toISOString());
    expect(row.read_at?.toISOString()).toBe(T2.toISOString());
  });

  it('failed after delivered leaves delivered and failed_at null', async () => {
    await insertRow();
    await apply([update('delivered', T1)]);
    expect(await apply([update('failed', T2, { reason: 'msg91_16' })])).toBe(0);
    const row = await readRow();
    expect(row.status).toBe('delivered');
    expect(row.failed_at).toBeNull();
    expect(row.reason).toBeNull();
  });

  it('delivered after a provider failure raises to delivered and keeps failed_at', async () => {
    await insertRow();
    await apply([update('failed', T1, { reason: 'msg91_16' })]);
    const failed = await readRow();
    expect(failed.status).toBe('failed');
    expect(failed.failed_at?.toISOString()).toBe(T1.toISOString());
    expect(failed.reason).toBe('msg91_16');
    expect(await apply([update('delivered', T2)])).toBe(1);
    const row = await readRow();
    expect(row.status).toBe('delivered');
    expect(row.failed_at?.toISOString()).toBe(T1.toISOString());
    expect(row.delivered_at?.toISOString()).toBe(T2.toISOString());
  });

  it('delivered for an uncertain row sets accepted_at', async () => {
    await insertRow({ status: 'uncertain', acceptedAt: null });
    expect(await apply([update('delivered', T1)])).toBe(1);
    const row = await readRow();
    expect(row.status).toBe('delivered');
    expect(row.accepted_at?.toISOString()).toBe(T1.toISOString());
  });

  it('two reports for one row in one call apply the furthest', async () => {
    await insertRow();
    const updates = [
      update('failed', T1, { reason: 'msg91_2' }),
      update('read', T2),
      update('delivered', T1),
    ];
    expect(reduceUpdates(updates)).toEqual([update('read', T2)]);
    expect(await apply(updates)).toBe(1);
    const row = await readRow();
    expect(row.status).toBe('read');
    expect(row.failed_at).toBeNull();
  });

  it("a report for another project's source_ref changes nothing", async () => {
    await insertRow({ project: 'other' });
    expect(await apply([update('delivered', T1)])).toBe(0);
    expect((await readRow()).status).toBe('sent');
  });

  it('a skipped row is never updated', async () => {
    await insertRow({ status: 'skipped', acceptedAt: null });
    expect(await apply([update('delivered', T1)])).toBe(0);
    const row = await readRow();
    expect(row.status).toBe('skipped');
    expect(row.accepted_at).toBeNull();
  });

  it('an empty list does nothing', async () => {
    expect(await apply([])).toBe(0);
  });
});
