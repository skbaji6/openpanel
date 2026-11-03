import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';

const UNIQUE_VIOLATION = '23505';
const SEEDED_RECIPIENTS = 10_000;

async function insertCampaign(projectId: string, state: string) {
  const [row] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by)
     VALUES (gen_random_uuid(), $1, 'c', $2, 'push', '{}'::jsonb, 5000, 'u1') RETURNING id`,
    projectId,
    state
  );
  return row?.id as string;
}

async function insertAudience() {
  const [row] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.audiences (id, project_id, name, mode, created_by)
     VALUES (gen_random_uuid(), 'p1', 'a', 'dynamic', 'u1') RETURNING id`
  );
  return row?.id as string;
}

async function insertRecipient(campaignId: string, onConflict = '') {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id) VALUES ($1::uuid, 'u9', 'p1') ${onConflict}`,
    campaignId
  );
}

// Prisma reports the Postgres code under meta.code for raw queries.
async function errorCode(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    const { meta, code } = error as { meta?: { code?: string }; code?: string };
    return meta?.code ?? code ?? 'unknown';
  }
  return;
}

describe('campaign schema', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);

  it('a second running campaign in one project violates campaigns_one_active_per_project', async () => {
    await insertCampaign('p1', 'running');
    expect(await errorCode(insertCampaign('p1', 'running'))).toBe(
      UNIQUE_VIOLATION
    );
  });

  it('a paused and a running campaign in one project also conflict', async () => {
    await insertCampaign('p1', 'paused');
    expect(await errorCode(insertCampaign('p1', 'running'))).toBe(
      UNIQUE_VIOLATION
    );
  });

  it('two running campaigns in different projects are allowed', async () => {
    await insertCampaign('p1', 'running');
    await insertCampaign('p2', 'running');
  });

  it('an unknown campaign state is rejected by the check', async () => {
    expect(await errorCode(insertCampaign('p1', 'bogus'))).toBeDefined();
  });

  it("a recipient row has idempotency_key '<campaign_id>:<profile_id>'", async () => {
    const campaignId = await insertCampaign('p1', 'draft');
    await insertRecipient(campaignId);
    const [row] = await sql.$queryRawUnsafe<{ idempotency_key: string }[]>(
      'SELECT idempotency_key FROM marketing.campaign_recipients'
    );
    expect(row?.idempotency_key).toBe(`${campaignId}:u9`);
  });

  it('inserting the same (campaign_id, profile_id) twice with ON CONFLICT DO NOTHING keeps one row', async () => {
    const campaignId = await insertCampaign('p1', 'draft');
    await insertRecipient(campaignId, 'ON CONFLICT DO NOTHING');
    await insertRecipient(campaignId, 'ON CONFLICT DO NOTHING');
    const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM marketing.campaign_recipients'
    );
    expect(row?.n).toBe(1);
  });

  it('the claim query uses campaign_recipients_claim_idx', async () => {
    const campaignId = await insertCampaign('p1', 'running');
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, due_at)
       SELECT $1::uuid, 'u' || g, 'p1', now() + (g || ' seconds')::interval FROM generate_series(1, ${SEEDED_RECIPIENTS}) g`,
      campaignId
    );
    await sql.$executeRawUnsafe('ANALYZE marketing.campaign_recipients');
    const plan = await sql.$queryRawUnsafe<Record<string, string>[]>(
      `EXPLAIN SELECT profile_id FROM marketing.campaign_recipients
       WHERE campaign_id = '${campaignId}'::uuid AND status = 'pending'
       ORDER BY due_at LIMIT 500 FOR UPDATE SKIP LOCKED`
    );
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toContain('campaign_recipients_claim_idx');
  });

  it('deleting an audience referenced by a campaign fails', async () => {
    const audienceId = await insertAudience();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, confirm_threshold, created_by)
       VALUES (gen_random_uuid(), 'p1', 'c', 'draft', 'push', '{}'::jsonb, $1::uuid, 5000, 'u1')`,
      audienceId
    );
    const deletion = sql.$executeRawUnsafe(
      'DELETE FROM marketing.audiences WHERE id = $1::uuid',
      audienceId
    );
    expect(await errorCode(deletion)).toBeDefined();
  });
});
