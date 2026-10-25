import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetNudgeTables } from '../db/test-helpers';
import { lagAllowsSending } from '../engine/gates';
import { createKafka } from './consumer';
import { computeLag, createLagReporter } from './lag';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const MESSAGES = 3;
const COMMITTED = 1;
const BROKER_TEST_TIMEOUT_MS = 30_000;

async function readState() {
  const [row] = await sql.$queryRawUnsafe<{ lag: bigint; updated_at: Date }[]>(
    'SELECT lag, updated_at FROM nudge.consumer_state WHERE id = 1'
  );
  return row ? { lag: Number(row.lag), updatedAt: row.updated_at } : null;
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetNudgeTables();
});

afterAll(async () => {
  await sql.$disconnect();
});

describe('computeLag', () => {
  it('sums end minus committed per partition and counts uncommitted partitions as caught up', () => {
    expect(
      computeLag(
        [
          { partition: 0, offset: '10' },
          { partition: 1, offset: '5' },
          { partition: 2, offset: '7' },
        ],
        [
          { partition: 0, offset: '4' },
          { partition: 1, offset: '5' },
          { partition: 2, offset: '-1' },
        ]
      )
    ).toBe(6);
  });
});

describe('lag reporter', () => {
  it(
    'writes the group lag with the injected clock, which lagAllowsSending then accepts',
    async () => {
      const runId = randomUUID();
      const kafkaConfig = {
        brokers: (process.env.KAFKA_BROKERS ?? '127.0.0.1:23092').split(','),
        clientId: `nudge-lag-${runId}`,
        topic: `nudge-lag-${runId}`,
        groupId: `nudge-lag-${runId}`,
        ssl: false as const,
      };
      const kafka = createKafka(kafkaConfig);
      const admin = kafka.admin();
      const producer = kafka.producer();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: kafkaConfig.topic, numPartitions: 1 }],
        waitForLeaders: true,
      });
      await producer.connect();
      const reporter = createLagReporter({
        kafka: kafkaConfig,
        sql,
        now: () => NOW,
      });
      try {
        await producer.send({
          topic: kafkaConfig.topic,
          messages: Array.from({ length: MESSAGES }, (_, index) => ({
            value: String(index),
          })),
        });
        expect(await reporter.report()).toBe(0);

        await admin.setOffsets({
          groupId: kafkaConfig.groupId,
          topic: kafkaConfig.topic,
          partitions: [{ partition: 0, offset: String(COMMITTED) }],
        });
        expect(await reporter.report()).toBe(MESSAGES - COMMITTED);

        const state = await readState();
        expect(state).toEqual({ lag: MESSAGES - COMMITTED, updatedAt: NOW });
        expect(lagAllowsSending(state, NOW, { maxLag: 1 })).toBe(false);
        expect(lagAllowsSending(state, NOW, { maxLag: 2 })).toBe(true);
      } finally {
        await reporter.stop();
        await producer.disconnect();
        await admin.deleteTopics({ topics: [kafkaConfig.topic] });
        await admin.disconnect();
      }
    },
    BROKER_TEST_TIMEOUT_MS
  );
});
