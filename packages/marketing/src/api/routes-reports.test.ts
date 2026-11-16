import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createServer } from './server';

const PROXY_SECRET = 'proxy-secret-for-tests';
const cfg = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  KAFKA_BROKERS: '127.0.0.1:1',
  KAFKA_EVENTS_TOPIC: 'unused',
  ENCRYPTION_KEY: 'cd'.repeat(32),
  MARKETING_PROXY_SECRET: PROXY_SECRET,
  MARKETING_PUBLIC_URL: 'https://marketing.test',
});
const app = createServer({ cfg, sql });

function get(path: string, project = 'proj-a') {
  return app.fetch(
    new Request(`http://marketing.internal${path}`, {
      headers: {
        'x-marketing-proxy-secret': PROXY_SECRET,
        'x-marketing-project-id': project,
        'x-marketing-user-id': 'user-1',
      },
    })
  );
}

async function insertCampaign(project: string) {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by, materialize_state)
     VALUES ($1::uuid, $2, 'c', 'completed', 'push', '{}'::jsonb, 5000, 'u', 'done')`,
    id,
    project
  );
  return id;
}

beforeAll(migrate);
beforeEach(resetMarketingTables);

describe('report routes', () => {
  it('GET campaign report 200', async () => {
    const id = await insertCampaign('proj-a');
    const response = await get(`/marketing/reports/campaigns/${id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      campaignId: string;
      channel: string;
    };
    expect(body.campaignId).toBe(id);
    expect(body.channel).toBe('push');
  });

  it('404 for another project, an unknown id and a malformed id', async () => {
    const id = await insertCampaign('proj-b');
    expect((await get(`/marketing/reports/campaigns/${id}`)).status).toBe(404);
    expect(
      (await get(`/marketing/reports/campaigns/${randomUUID()}`)).status
    ).toBe(404);
    expect((await get(`/marketing/reports/journeys/${id}`)).status).toBe(404);
    expect((await get('/marketing/reports/journeys/not-a-uuid')).status).toBe(
      404
    );
  });

  it('400 invalid_timezone', async () => {
    const id = await insertCampaign('proj-a');
    const response = await get(
      `/marketing/reports/campaigns/${id}?tz=Mars/Base`
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_timezone' });
  });

  it('needs dashboard auth', async () => {
    const response = await app.fetch(
      new Request(
        `http://marketing.internal/marketing/reports/campaigns/${randomUUID()}`
      )
    );
    expect(response.status).toBe(401);
  });
});
