import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const SEED_TEST_TIMEOUT_MS = 60_000;
const LEDGER_ROWS = 200_000;
const LEDGER_PROFILES = 20_011;
const LEDGER_SPAN_SECONDS = 7_776_000;
const LEDGER_PROJECTS = 5;
const TEMPLATE_ID = '00000000-0000-0000-0000-000000000001';
const ENROLLMENT_ID = '00000000-0000-0000-0000-0000000000e1';
const LEDGER_MIGRATION = join(
  import.meta.dir,
  '..',
  '..',
  'migrations',
  '0015_send_ledger_dispatch.sql'
);

async function errorCode(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    const { meta, message } = error as {
      meta?: { code?: string };
      message: string;
    };
    return meta?.code ?? message;
  }
  return;
}

async function plan(query: string): Promise<string> {
  const rows = await sql.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN ${query}`
  );
  return rows.map((row) => Object.values(row)[0]).join('\n');
}

async function seedLedger() {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.send_ledger (source_ref, project_id, profile_id, channel, sent_at)
     SELECT 'campaign:c:' || g, 'p' || (g % ${LEDGER_PROJECTS}), 'u' || (g % ${LEDGER_PROFILES}),
            (ARRAY['sms','email','push'])[g % 3 + 1], now() - ((g * 38) % ${LEDGER_SPAN_SECONDS} || ' seconds')::interval
     FROM generate_series(1, ${LEDGER_ROWS}) g`
  );
  await sql.$executeRawUnsafe('ANALYZE marketing.send_ledger');
}

async function insertTemplate(channel: string) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.message_templates (id, project_id, channel, current_version, created_by)
     VALUES ('${TEMPLATE_ID}', 'p1', $1, 1, 'u1')`,
    channel
  );
}

function versionInsert(category = 'promotional') {
  return `INSERT INTO marketing.message_template_versions
    (template_id, version, display_name, category, provider_ref, approved_text, variables, created_by)
    VALUES ('${TEMPLATE_ID}', 1, 'n', '${category}', '{}'::jsonb, 'hi', '[]'::jsonb, 'u1')`;
}

async function indexDef(name: string) {
  const [row] = await sql.$queryRawUnsafe<{ indexdef: string }[]>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'marketing' AND indexname = '${name}'`
  );
  return row?.indexdef ?? '';
}

describe('dispatch schema', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);

  it('a second version row with the same (template_id, version) violates the primary key', async () => {
    await insertTemplate('sms');
    await sql.$executeRawUnsafe(versionInsert());
    expect(await errorCode(sql.$executeRawUnsafe(versionInsert()))).toBe(
      UNIQUE_VIOLATION
    );
  });

  it("a template channel 'push' is rejected", async () => {
    expect(await errorCode(insertTemplate('push'))).toBe(CHECK_VIOLATION);
  });

  it('a template version category outside promotional and service is rejected', async () => {
    await insertTemplate('sms');
    expect(await errorCode(sql.$executeRawUnsafe(versionInsert('other')))).toBe(
      CHECK_VIOLATION
    );
  });

  it('a channel_settings channel outside the five channels is rejected', async () => {
    expect(
      await errorCode(
        sql.$executeRawUnsafe(
          `INSERT INTO marketing.channel_settings (project_id, channel, settings) VALUES ('p1', 'fax', '{}'::jsonb)`
        )
      )
    ).toBe(CHECK_VIOLATION);
  });

  it('send_ledger source_ref is unique', async () => {
    const insert = () =>
      sql.$executeRawUnsafe(
        `INSERT INTO marketing.send_ledger (source_ref, project_id, profile_id, channel, sent_at) VALUES ('campaign:c:u1', 'p1', 'u1', 'sms', now())`
      );
    await insert();
    expect(await errorCode(insert())).toBe(UNIQUE_VIOLATION);
  });

  it(
    'EXPLAIN of the cap count over 200,000 ledger rows uses send_ledger_person_idx',
    async () => {
      await seedLedger();
      const text = await plan(
        `SELECT count(*) FROM marketing.send_ledger
       WHERE project_id = 'p1' AND profile_id = ANY(ARRAY['u1','u2','u3']) AND sent_at > now() - interval '1 day'`
      );
      expect(text).toContain('send_ledger_person_idx');
    },
    SEED_TEST_TIMEOUT_MS
  );

  it(
    'EXPLAIN of the day count uses send_ledger_channel_day_idx',
    async () => {
      await seedLedger();
      const text = await plan(
        `SELECT count(*) FROM marketing.send_ledger
       WHERE project_id = 'p1' AND channel = 'sms' AND sent_at >= now() - interval '30 days' AND sent_at < now()`
      );
      expect(text).toContain('send_ledger_channel_day_idx');
    },
    SEED_TEST_TIMEOUT_MS
  );

  it('campaign columns template_version, dispatch_retry_at, dispatch_error, dispatch_failures exist with their defaults', async () => {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by)
       VALUES (gen_random_uuid(), 'p1', 'c', 'draft', 'sms', '{}'::jsonb, 5000, 'u1')`
    );
    const [row] = await sql.$queryRawUnsafe<Record<string, unknown>[]>(
      'SELECT template_version, dispatch_retry_at, dispatch_error, dispatch_failures FROM marketing.campaigns'
    );
    expect(row).toEqual({
      template_version: null,
      dispatch_retry_at: null,
      dispatch_error: null,
      dispatch_failures: 0,
    });
  });

  it('campaigns_dispatch_idx covers running campaigns with a finished materialisation', async () => {
    const def = await indexDef('campaigns_dispatch_idx');
    expect(def).toContain('dispatch_retry_at');
    expect(def).toContain("'running'");
    expect(def).toContain("'done'");
  });

  it('campaign_recipients_token_idx covers rows that hold a lease token', async () => {
    const def = await indexDef('campaign_recipients_token_idx');
    expect(def).toContain('(lease_token)');
    expect(def).toContain('IS NOT NULL');
  });

  it('campaign_test_sends has lease_until and provider_ref, campaign_recipients has lease_token', async () => {
    const rows = await sql.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'marketing'
       AND ((table_name = 'campaign_test_sends' AND column_name IN ('lease_until', 'provider_ref'))
         OR (table_name = 'campaign_recipients' AND column_name = 'lease_token'))`
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'lease_token',
      'lease_until',
      'provider_ref',
    ]);
  });

  it('running migrate() twice is a no-op', async () => {
    expect(await migrate()).toEqual([]);
  });

  it('the ledger backfill copies sent journey steps once and is idempotent', async () => {
    const snapshot = JSON.stringify({
      steps: [{ channel: 'email' }, { channel: 'push' }, { channel: 'email' }],
    });
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time)
       VALUES ('${ENROLLMENT_ID}', 'p1', gen_random_uuid(), $1::jsonb, 'u1', 'active', now())`,
      snapshot
    );
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status, sent_at) VALUES
        ('${ENROLLMENT_ID}', 0, now(), 'sent', now()),
        ('${ENROLLMENT_ID}', 1, now(), 'pending', NULL),
        ('${ENROLLMENT_ID}', 2, now(), 'failed', now())`
    );
    const backfill = (await readFile(LEDGER_MIGRATION, 'utf8'))
      .split(';')
      .find((statement) =>
        statement.includes('INSERT INTO marketing.send_ledger')
      );
    expect(backfill).toBeDefined();
    await sql.$executeRawUnsafe(backfill as string);
    await sql.$executeRawUnsafe(backfill as string);
    const rows = await sql.$queryRawUnsafe<Record<string, string>[]>(
      'SELECT source_ref, project_id, profile_id, channel FROM marketing.send_ledger'
    );
    expect(rows).toEqual([
      {
        source_ref: `step:${ENROLLMENT_ID}:0`,
        project_id: 'p1',
        profile_id: 'u1',
        channel: 'email',
      },
    ]);
  });
});
