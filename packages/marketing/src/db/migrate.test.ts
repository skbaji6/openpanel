import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './client';
import { migrate, splitStatements } from './migrate';
import { resetMarketingTables } from './test-helpers';

const TABLES = [
  'rules',
  'enrollments',
  'steps',
  'events',
  'reference_sets',
  'contacts',
  'devices',
  'opt_outs',
  'channel_configs',
  'api_keys',
  'project_settings',
  'consumer_state',
  'schema_migrations',
];
const PENDING_DUE_INDEX = 'steps_pending_due_idx';
const EVENTS_LOOKUP_INDEX = 'events_lookup_idx';
const RULE_ID = '00000000-0000-0000-0000-000000000001';
const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations');

async function insertEnrollment(status: string) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, match_value, status, trigger_time)
     VALUES (gen_random_uuid(), 'p1', $1::uuid, '{}'::jsonb, 'u1', '', $2, now())`,
    RULE_ID,
    status
  );
}

describe('marketing schema', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);

  it('migrate creates schema marketing and every listed table', async () => {
    const rows = await sql.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'marketing'`
    );
    const names = rows.map((r) => r.table_name);
    for (const table of TABLES) {
      expect(names).toContain(table);
    }
  });

  it('migrate twice applies nothing the second time', async () => {
    expect(await migrate()).toEqual([]);
  });

  it('no table was created in schema public by migrate', async () => {
    const rows = await sql.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('rules','enrollments','steps','events')`
    );
    expect(rows).toHaveLength(0);
  });

  it('partial unique index rejects a second active enrollment for the same (project, rule, profile, match_value) but allows one after the first is completed', async () => {
    await insertEnrollment('active');
    await expect(insertEnrollment('active')).rejects.toThrow();
    await sql.$executeRawUnsafe(
      `UPDATE marketing.enrollments SET status = 'completed'`
    );
    await insertEnrollment('active');
    const [row] = await sql.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM marketing.enrollments'
    );
    expect(row?.count).toBe(2);
  });

  it('PERF claim query uses the partial pending-due index', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status)
       SELECT gen_random_uuid(), 0, now() + (g || ' seconds')::interval - interval '5 hours',
              CASE WHEN g % 10 = 0 THEN 'sent' ELSE 'pending' END
       FROM generate_series(1, 20000) g`
    );
    await sql.$executeRawUnsafe('ANALYZE marketing.steps');
    const plan = await sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN SELECT enrollment_id, step_index FROM marketing.steps
         WHERE status = 'pending' AND due_at <= $1
         ORDER BY due_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
        new Date()
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain(PENDING_DUE_INDEX);
  });

  it('PERF events lookup by (project_id, profile_id, name, event_time) uses its index', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.events (project_id, event_id, profile_id, name, properties, event_time)
       SELECT 'p1', 'e' || g, 'u' || (g % 500), 'view', '{}'::jsonb, now() - (g || ' seconds')::interval
       FROM generate_series(1, 20000) g`
    );
    await sql.$executeRawUnsafe('ANALYZE marketing.events');
    const plan = await sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN SELECT 1 FROM marketing.events
         WHERE project_id = 'p1' AND profile_id = 'u7' AND name = 'view' AND event_time >= now() - interval '1 day'`
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain(EVENTS_LOOKUP_INDEX);
  });
});

describe('marketing migrations under concurrency', () => {
  it('two replicas migrating a fresh schema at once apply every file exactly once', async () => {
    await sql.$executeRawUnsafe('DROP SCHEMA IF EXISTS marketing CASCADE');
    const runs = await Promise.all([migrate(), migrate()]);
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(runs.flat().sort()).toEqual(files);
    const [row] = await sql.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM marketing.schema_migrations'
    );
    expect(row?.count).toBe(files.length);
  });

  it('0016 allows status draft and keeps existing rows', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.rules (id, project_id, name, status, definition)
       VALUES (gen_random_uuid(), 'p1', 'a', 'active', '{}'::jsonb), (gen_random_uuid(), 'p1', 'd', 'draft', '{}'::jsonb)`
    );
    await expect(
      (async () =>
        await sql.$executeRawUnsafe(
          `INSERT INTO marketing.rules (id, project_id, name, status, definition)
           VALUES (gen_random_uuid(), 'p1', 'x', 'bogus', '{}'::jsonb)`
        ))()
    ).rejects.toThrow();
    const [row] = await sql.$queryRawUnsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM marketing.rules WHERE status IN ('active','draft')`
    );
    expect(row?.count).toBe(2);
    await migrate();
  });
});

describe('migration 0019 message tracking', () => {
  const FILE = '0019_message_tracking.sql';
  const CAMPAIGN_ID = '00000000-0000-0000-0000-0000000000c1';
  const ENROLLMENT_ID = '00000000-0000-0000-0000-0000000000e1';
  const OLD_CAMPAIGN_ID = '00000000-0000-0000-0000-0000000000c2';
  const OLD_DAYS = 500;

  async function trackingRefs(): Promise<string[]> {
    const rows = await sql.$queryRawUnsafe<{ source_ref: string }[]>(
      'SELECT source_ref FROM marketing.message_tracking ORDER BY source_ref'
    );
    return rows.map((row) => row.source_ref);
  }

  async function reapply(): Promise<string[]> {
    await sql.$executeRawUnsafe(
      'DELETE FROM marketing.schema_migrations WHERE name = $1',
      FILE
    );
    return await migrate();
  }

  it('0019 backfills a sent recipient and a sent step and is idempotent on a second run', async () => {
    await migrate();
    await resetMarketingTables();
    for (const [id, daysAgo] of [
      [CAMPAIGN_ID, 1],
      [OLD_CAMPAIGN_ID, OLD_DAYS],
    ] as const) {
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by)
         VALUES ($1::uuid, 'p1', 'c', 'completed', 'sms', '{}'::jsonb, 5000, 'u')`,
        id
      );
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status, provider_ref, sent_at)
         VALUES ($1::uuid, 'a', 'p1', 'sent', 'req-1', now() - make_interval(days => $2::int))`,
        id,
        daysAgo
      );
    }
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, match_value, status, trigger_time)
       VALUES ($1::uuid, 'p1', $2::uuid, '{"steps":[{"channel":"email"}]}'::jsonb, 'u1', '', 'completed', now())`,
      ENROLLMENT_ID,
      RULE_ID
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status, sent_at)
       VALUES ($1::uuid, 0, now(), 'sent', now() - interval '2 days')`,
      ENROLLMENT_ID
    );
    // The triggers already wrote rows; the backfill is for sends made before they existed.
    await sql.$executeRawUnsafe('DELETE FROM marketing.message_tracking');

    expect(await reapply()).toEqual([FILE]);

    const expected = [`campaign:${CAMPAIGN_ID}:a`, `step:${ENROLLMENT_ID}:0`];
    expect(await trackingRefs()).toEqual(expected);
    const [step] = await sql.$queryRawUnsafe<
      { channel: string; rule_id: string; accepted_at: Date | null }[]
    >(
      'SELECT channel, rule_id::text, accepted_at FROM marketing.message_tracking WHERE source_ref = $1',
      `step:${ENROLLMENT_ID}:0`
    );
    expect(step).toMatchObject({ channel: 'email', rule_id: RULE_ID });
    expect(step?.accepted_at).not.toBeNull();

    expect(await reapply()).toEqual([FILE]);
    expect(await trackingRefs()).toEqual(expected);
    expect(await migrate()).toEqual([]);
  });

  it('splitStatements keeps a dollar-quoted function body in one statement', () => {
    const statements = splitStatements(
      'CREATE TABLE a (x int);\nCREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT 1;'
    );
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain('RETURN 1; END;');
    expect(statements[1]?.endsWith('LANGUAGE plpgsql')).toBe(true);
  });
});
