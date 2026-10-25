import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './client';
import { migrate } from './migrate';
import { resetNudgeTables } from './test-helpers';

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
    `INSERT INTO nudge.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, match_value, status, trigger_time)
     VALUES (gen_random_uuid(), 'p1', $1::uuid, '{}'::jsonb, 'u1', '', $2, now())`,
    RULE_ID,
    status
  );
}

describe('nudge schema', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetNudgeTables);

  it('migrate creates schema nudge and every listed table', async () => {
    const rows = await sql.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'nudge'`
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
      `UPDATE nudge.enrollments SET status = 'completed'`
    );
    await insertEnrollment('active');
    const [row] = await sql.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM nudge.enrollments'
    );
    expect(row?.count).toBe(2);
  });

  it('PERF claim query uses the partial pending-due index', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO nudge.steps (enrollment_id, step_index, due_at, status)
       SELECT gen_random_uuid(), 0, now() + (g || ' seconds')::interval - interval '5 hours',
              CASE WHEN g % 10 = 0 THEN 'sent' ELSE 'pending' END
       FROM generate_series(1, 20000) g`
    );
    await sql.$executeRawUnsafe('ANALYZE nudge.steps');
    const plan = await sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN SELECT enrollment_id, step_index FROM nudge.steps
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
      `INSERT INTO nudge.events (project_id, event_id, profile_id, name, properties, event_time)
       SELECT 'p1', 'e' || g, 'u' || (g % 500), 'view', '{}'::jsonb, now() - (g || ' seconds')::interval
       FROM generate_series(1, 20000) g`
    );
    await sql.$executeRawUnsafe('ANALYZE nudge.events');
    const plan = await sql.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN SELECT 1 FROM nudge.events
         WHERE project_id = 'p1' AND profile_id = 'u7' AND name = 'view' AND event_time >= now() - interval '1 day'`
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain(EVENTS_LOOKUP_INDEX);
  });
});

describe('nudge migrations under concurrency', () => {
  it('two replicas migrating a fresh schema at once apply every file exactly once', async () => {
    await sql.$executeRawUnsafe('DROP SCHEMA IF EXISTS nudge CASCADE');
    const runs = await Promise.all([migrate(), migrate()]);
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect(runs.flat().sort()).toEqual(files);
    const [row] = await sql.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM nudge.schema_migrations'
    );
    expect(row?.count).toBe(files.length);
  });
});
