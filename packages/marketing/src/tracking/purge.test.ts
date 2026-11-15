import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { MS_PER_DAY } from '../engine/engine';
import { LEDGER_RETENTION_DAYS } from '../engine/ledger';
import { purgeTracking } from './purge';

const RULE = '00000000-0000-0000-0000-0000000000a1';
const OLD_DAYS = LEDGER_RETENTION_DAYS + 5;
const NEW_DAYS = LEDGER_RETENTION_DAYS - 5;

const daysAgo = (days: number) => new Date(Date.now() - days * MS_PER_DAY);

async function insertTracking(ref: string, sentAt: Date) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.message_tracking (source_ref, project_id, profile_id, status, sent_at)
     VALUES ($1, 'p1', 'u1', 'sent', $2::timestamptz)`,
    ref,
    sentAt.toISOString()
  );
}

async function insertCounts(variantKey: string, day: Date) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.journey_variant_counts (project_id, rule_id, step_index, variant_key, day, sent)
     VALUES ('p1', $1::uuid, 0, $2, $3::date, 1)`,
    RULE,
    variantKey,
    day.toISOString().slice(0, 10)
  );
}

describe('tracking purge', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);

  it('purgeTracking deletes rows older than 400 days and keeps newer ones', async () => {
    await insertTracking('old', daysAgo(OLD_DAYS));
    await insertTracking('new', daysAgo(NEW_DAYS));
    await insertCounts('old', daysAgo(OLD_DAYS));
    await insertCounts('new', daysAgo(NEW_DAYS));
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.tracked_links (id, project_id, url)
       VALUES (gen_random_uuid(), 'p1', 'https://example.test/a')`
    );

    const purged = await purgeTracking(sql);

    expect(purged).toEqual({ messages: 1, variantCounts: 1 });
    const kept = await sql.$queryRawUnsafe<{ source_ref: string }[]>(
      'SELECT source_ref FROM marketing.message_tracking'
    );
    expect(kept.map((row) => row.source_ref)).toEqual(['new']);
    const [counts] = await sql.$queryRawUnsafe<{ n: number; key: string }[]>(
      'SELECT count(*)::int AS n, min(variant_key) AS key FROM marketing.journey_variant_counts'
    );
    expect(counts).toEqual({ n: 1, key: 'new' });
    const [links] = await sql.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM marketing.tracked_links'
    );
    expect(links?.n).toBe(1);
  });
});
