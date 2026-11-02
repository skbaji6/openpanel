import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { hashToken, purgeDeadTokens, recordDeadTokens } from './dead-tokens';

const README = readFileSync(
  join(import.meta.dir, '..', '..', 'README.md'),
  'utf8'
);
const RECIPE_START = 'WITH gone AS (';
const DAY_MS = 86_400_000;
const OLD_DAYS = 200;
const RECENT_DAYS = 10;

// The README's history-purge block, exactly as an operator would paste it.
function recipe(): string {
  const start = README.indexOf(RECIPE_START);
  const end = README.indexOf('```', start);
  if (start === -1 || end === -1) {
    throw new Error('history purge recipe not found in README.md');
  }
  return README.slice(start, end).trim().replace(/;$/, '');
}

async function insertRule(reentryEnabled: boolean): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, 'proj', 'r', 'active', $2::jsonb)`,
    id,
    JSON.stringify({ reentry: { enabled: reentryEnabled, cooldownSeconds: 0 } })
  );
  return id;
}

async function insertEnrollment(
  ruleId: string,
  status: string,
  ageDays: number
): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.enrollments (id, project_id, rule_id, rule_snapshot, profile_id, status, trigger_time, created_at)
     VALUES ($1::uuid, 'proj', $2::uuid, '{}'::jsonb, $1, $3, $4::timestamptz, $4::timestamptz)`,
    id,
    ruleId,
    status,
    createdAt
  );
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.steps (enrollment_id, step_index, due_at, status)
     VALUES ($1::uuid, 0, now(), 'sent')`,
    id
  );
  return id;
}

async function remaining(table: 'enrollments' | 'steps'): Promise<string[]> {
  const column = table === 'enrollments' ? 'id' : 'enrollment_id';
  const rows = await sql.$queryRawUnsafe<{ id: string }[]>(
    `SELECT ${column}::text AS id FROM marketing.${table} ORDER BY 1`
  );
  return rows.map((row) => row.id);
}

describe('README history purge recipe', () => {
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

  it('keeps completions that block re-entry, active and recent journeys, and removes the rest with their steps', async () => {
    const oneShot = await insertRule(false);
    const repeatable = await insertRule(true);
    const deletedRule = randomUUID();
    const kept = [
      await insertEnrollment(oneShot, 'completed', OLD_DAYS),
      await insertEnrollment(repeatable, 'active', OLD_DAYS),
      await insertEnrollment(repeatable, 'completed', RECENT_DAYS),
    ].sort();
    await insertEnrollment(oneShot, 'cancelled', OLD_DAYS);
    await insertEnrollment(repeatable, 'completed', OLD_DAYS);
    await insertEnrollment(deletedRule, 'completed', OLD_DAYS);

    await sql.$executeRawUnsafe(recipe());

    expect(await remaining('enrollments')).toEqual(kept);
    expect(await remaining('steps')).toEqual(kept);
  });

  it('purge removes rows older than 90 days and keeps newer', async () => {
    await recordDeadTokens(sql, 'p', ['old', 'new'], 'k'.repeat(32));
    await sql.$executeRawUnsafe(
      `UPDATE marketing.dead_tokens SET seen_at = now() - interval '91 days' WHERE token_hash = $1`,
      hashToken('k'.repeat(32), 'old')
    );
    await sql.$executeRawUnsafe(
      `UPDATE marketing.dead_tokens SET seen_at = now() - interval '89 days' WHERE token_hash = $1`,
      hashToken('k'.repeat(32), 'new')
    );
    expect(await purgeDeadTokens(sql)).toBe(1);
    const rows = await sql.$queryRawUnsafe<{ token_hash: Uint8Array }[]>(
      'SELECT token_hash FROM marketing.dead_tokens'
    );
    expect(
      rows.map((row) => Buffer.from(row.token_hash).toString('hex'))
    ).toEqual([hashToken('k'.repeat(32), 'new').toString('hex')]);
  });
});
