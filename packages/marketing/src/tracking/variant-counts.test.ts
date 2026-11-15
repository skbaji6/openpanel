import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { countVariantOutcome } from './variant-counts';

const RULE_ID = '00000000-0000-4000-8000-0000000000aa';
const AT = new Date('2026-11-15T23:30:00Z');
const base = { projectId: 'p1', ruleId: RULE_ID, stepIndex: 0, at: AT };

beforeAll(migrate);
beforeEach(resetMarketingTables);

describe('countVariantOutcome', () => {
  it('a TS send and an AP skip land in separate rows with no profile id column', async () => {
    await countVariantOutcome(sql, {
      ...base,
      variantKey: 'TS',
      status: 'sent',
    });
    await countVariantOutcome(sql, {
      ...base,
      variantKey: 'TS',
      status: 'sent',
    });
    await countVariantOutcome(sql, {
      ...base,
      variantKey: 'AP',
      status: 'skipped',
    });
    const rows = await sql.$queryRawUnsafe<
      {
        variant_key: string;
        day: Date;
        sent: number;
        skipped: number;
        failed: number;
      }[]
    >(
      'SELECT variant_key, day, sent, skipped, failed FROM marketing.journey_variant_counts ORDER BY variant_key'
    );
    expect(
      rows.map((r) => [r.variant_key, r.sent, r.skipped, r.failed])
    ).toEqual([
      ['AP', 0, 1, 0],
      ['TS', 2, 0, 0],
    ]);
    expect(rows[0]?.day.toISOString().slice(0, 10)).toBe('2026-11-15');
    const columns = await sql.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = 'journey_variant_counts'`
    );
    expect(columns.map((c) => c.column_name)).not.toContain('profile_id');
  });
});
