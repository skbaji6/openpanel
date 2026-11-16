import { describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { loadConfig } from './config';
import { sql } from './db/client';
import { migrate } from './db/migrate';
import { resetMarketingTables } from './db/test-helpers';
import { createKafka } from './kafka/consumer';
import { createStopAll, startWorker } from './worker';

const WORKER_TEST_TIMEOUT_MS = 30_000;
const LAG_WAIT_MS = 10_000;
const POLL_MS = 100;
const FAST_TICK_MS = 50;
const STOPPED_WAIT_MS = FAST_TICK_MS * 6;

async function waitUntil(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + LAG_WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

async function insertCampaign(
  project: string,
  state: string,
  materializeState: string
): Promise<string> {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold,
       created_by, materialize_state, started_at)
     VALUES ($1::uuid, $2, 'c', $3, 'push', '{"body":"Hi"}'::jsonb, 5000, 'u1', $4, now())`,
    id,
    project,
    state,
    materializeState
  );
  await sql.$executeRawUnsafe(
    'INSERT INTO marketing.campaign_counters (campaign_id, queued) VALUES ($1::uuid, 1)',
    id
  );
  return id;
}

async function insertRecipient(
  campaignId: string,
  project: string,
  status: string,
  leaseUntil: Date | null
) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status, due_at, lease_until,
       lease_token)
     VALUES ($1::uuid, 'p1', $2, $3, now() - interval '1 minute', $4, $5::uuid)`,
    campaignId,
    project,
    status,
    leaseUntil,
    leaseUntil ? randomUUID() : null
  );
}

async function insertTestSend(campaignId: string, project: string) {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaign_test_sends (id, campaign_id, project_id, profile_id, requested_by)
     VALUES ($1::uuid, $2::uuid, $3, 'p1', 'u1')`,
    id,
    campaignId,
    project
  );
  return id;
}

async function insertJourneyTestSend(project: string) {
  const ruleId = randomUUID();
  const definition = {
    name: 'Journey',
    trigger: { event: 'signup' },
    goal: { kind: 'event', event: 'paid' },
    steps: [{ delaySeconds: 60, channel: 'push', template: { body: 'Hi' } }],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
  };
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, 'Journey', 'draft', $3::jsonb)`,
    ruleId,
    project,
    JSON.stringify(definition)
  );
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.journey_test_sends (id, project_id, rule_id, step_index, variant_key, profile_id)
     VALUES ($1::uuid, $2, $3::uuid, 0, 'default', 'p1')`,
    id,
    project,
    ruleId
  );
  return id;
}

async function firstValue(query: string, id: string): Promise<unknown> {
  const [row] = await sql.$queryRawUnsafe<{ value: unknown }[]>(query, id);
  return row?.value;
}

const testSendState = (id: string) =>
  firstValue(
    "SELECT status || ':' || COALESCE(reason, '') AS value FROM marketing.campaign_test_sends WHERE id = $1::uuid",
    id
  );

describe('createStopAll', () => {
  it('a concurrent second stop (fatal consumer plus SIGTERM) stops each part once, newest first', async () => {
    const stopped: string[] = [];
    const part = (name: string) => ({
      async stop() {
        await Bun.sleep(5);
        stopped.push(name);
      },
    });
    const started = [part('first'), part('second')];
    const stopAll = createStopAll(started, []);
    await Promise.all([stopAll(), stopAll()]);
    await stopAll();
    expect(stopped).toEqual(['second', 'first']);
    expect(started).toHaveLength(0);
  });
});

describe('startWorker', () => {
  it(
    'starts every part, hands the HTTP hook its context, and stops the HTTP server first',
    async () => {
      const runId = randomUUID();
      const cfg = loadConfig({
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
        KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? '127.0.0.1:23092',
        KAFKA_EVENTS_TOPIC: `marketing-worker-${runId}`,
        MARKETING_KAFKA_GROUP: `marketing-worker-${runId}`,
        ENCRYPTION_KEY: 'test-encryption-key',
        MARKETING_PROXY_SECRET: 'test-proxy-secret',
        MARKETING_PUBLIC_URL: 'https://marketing.test',
      });
      const admin = createKafka(cfg.kafka).admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: cfg.kafka.topic, numPartitions: 1 }],
        waitForLeaders: true,
      });
      await migrate();
      await sql.$executeRawUnsafe('DELETE FROM marketing.consumer_state');
      const order: string[] = [];
      const startHttp = mock(() => {
        order.push('http started');
        return Promise.resolve({
          stop: () => {
            order.push('http stopped');
            return Promise.resolve();
          },
        });
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
      const worker = await startWorker(cfg, { startHttp });
      expect(warn).toHaveBeenCalledWith(
        'marketing worker:',
        'no unsubscribe link renderer; sending is off'
      );
      warn.mockRestore();
      expect(startHttp).toHaveBeenCalledTimes(1);
      const [context] = startHttp.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ];
      expect(Object.keys(context).sort()).toEqual([
        'cfg',
        'engine',
        'redis',
        'refreshInterest',
        'reportMatcher',
        'sources',
        'sql',
        'trackingSettings',
      ]);

      const deadline = Date.now() + LAG_WAIT_MS;
      let rows: { lag: bigint }[] = [];
      while (rows.length === 0 && Date.now() < deadline) {
        await Bun.sleep(POLL_MS);
        rows = await sql.$queryRawUnsafe<{ lag: bigint }[]>(
          'SELECT lag FROM marketing.consumer_state WHERE id = 1'
        );
      }

      await worker.stop();
      await admin.deleteTopics({ topics: [cfg.kafka.topic] });
      await admin.disconnect();
      expect(rows.map((row) => Number(row.lag))).toEqual([0]);
      expect(order).toEqual(['http started', 'http stopped']);
    },
    WORKER_TEST_TIMEOUT_MS
  );
});

describe('startWorker campaign jobs', () => {
  it(
    'startWorker starts the lane, the reaper and the test-send job and stops them',
    async () => {
      const runId = randomUUID();
      const cfg = loadConfig({
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
        KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? '127.0.0.1:23092',
        KAFKA_EVENTS_TOPIC: `marketing-worker-${runId}`,
        MARKETING_KAFKA_GROUP: `marketing-worker-${runId}`,
        ENCRYPTION_KEY: 'test-encryption-key',
        MARKETING_PROXY_SECRET: 'test-proxy-secret',
        MARKETING_PUBLIC_URL: 'https://marketing.test',
        MARKETING_TICK_MS: String(FAST_TICK_MS),
      });
      const admin = createKafka(cfg.kafka).admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: cfg.kafka.topic, numPartitions: 1 }],
        waitForLeaders: true,
      });
      // The shared Redis client was disconnected by the worker stopped in the test above.
      const redis = getRedisCache();
      if (redis.status === 'end') {
        await redis.connect();
      }
      await migrate();
      await resetMarketingTables();
      const testProject = `worker-test-${runId}`;
      const draft = await insertCampaign(testProject, 'draft', 'not_started');
      const testSend = await insertTestSend(draft, testProject);
      const journeyTestSend = await insertJourneyTestSend(testProject);
      const reapProject = `worker-reap-${runId}`;
      const reaped = await insertCampaign(reapProject, 'running', 'done');
      await insertRecipient(
        reaped,
        reapProject,
        'sending',
        new Date(Date.now() - 1000)
      );
      const laneProject = `worker-lane-${runId}`;
      const dispatched = await insertCampaign(laneProject, 'running', 'done');
      await insertRecipient(dispatched, laneProject, 'pending', null);

      const worker = await startWorker(cfg, {
        renderUnsubscribeUrl: () => 'https://marketing.test/u',
      });
      try {
        await waitUntil(
          async () =>
            (await testSendState(testSend)) === 'failed:channel_not_configured',
          'the test send to fail without credentials'
        );
        await waitUntil(
          async () =>
            (await firstValue(
              "SELECT status || ':' || COALESCE(reason, '') AS value FROM marketing.journey_test_sends WHERE id = $1::uuid",
              journeyTestSend
            )) === 'skipped:channel_not_configured',
          'the journey test send to end without credentials'
        );
        await waitUntil(
          async () =>
            (await firstValue(
              'SELECT state AS value FROM marketing.campaigns WHERE id = $1::uuid',
              reaped
            )) === 'completed',
          'the reaped campaign to complete'
        );
        await waitUntil(
          async () =>
            (await firstValue(
              'SELECT dispatch_error AS value FROM marketing.campaigns WHERE id = $1::uuid',
              dispatched
            )) === 'channel_not_configured',
          'the lane to look at the running campaign'
        );
      } finally {
        await worker.stop();
        await admin.deleteTopics({ topics: [cfg.kafka.topic] });
        await admin.disconnect();
      }
      expect(
        await firstValue(
          "SELECT status || ':' || reason AS value FROM marketing.campaign_recipients WHERE campaign_id = $1::uuid",
          reaped
        )
      ).toBe('uncertain:lease_expired');

      const afterStop = await insertTestSend(draft, testProject);
      await Bun.sleep(STOPPED_WAIT_MS);
      expect(await testSendState(afterStop)).toBe('pending:');
    },
    WORKER_TEST_TIMEOUT_MS
  );
});
