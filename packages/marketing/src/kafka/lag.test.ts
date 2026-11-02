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
import { resetMarketingTables } from '../db/test-helpers';
import { lagAllowsSending } from '../engine/gates';
import { createKafka } from './consumer';
import { computeLag, createLagReporter } from './lag';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const MESSAGES = 3;
const COMMITTED = 1;
const UNCONSUMED = 2;
const BROKER_TEST_TIMEOUT_MS = 30_000;

async function readState() {
  const [row] = await sql.$queryRawUnsafe<{ lag: bigint; updated_at: Date }[]>(
    'SELECT lag, updated_at FROM marketing.consumer_state WHERE id = 1'
  );
  return row ? { lag: Number(row.lag), updatedAt: row.updated_at } : null;
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
});

afterAll(async () => {
  await sql.$disconnect();
});

describe('computeLag', () => {
  it('sums end minus committed per partition; an uncommitted partition counts from its first-seen end offset', () => {
    const baselines = new Map<number, number>();
    const committed = [
      { partition: 0, offset: '4' },
      { partition: 1, offset: '5' },
      { partition: 2, offset: '-1' },
    ];
    expect(
      computeLag(
        [
          { partition: 0, offset: '10' },
          { partition: 1, offset: '5' },
          { partition: 2, offset: '7' },
        ],
        committed,
        baselines
      )
    ).toBe(6);
    expect(
      computeLag(
        [
          { partition: 0, offset: '10' },
          { partition: 1, offset: '5' },
          { partition: 2, offset: '12' },
        ],
        committed,
        baselines
      )
    ).toBe(11);
    expect(
      computeLag(
        [{ partition: 2, offset: '12' }],
        [{ partition: 2, offset: '9' }],
        baselines
      )
    ).toBe(3);
    expect(baselines.size).toBe(0);
  });
});

describe('lag reporter', () => {
  it(
    'writes the group lag with the injected clock, which lagAllowsSending then accepts',
    async () => {
      const runId = randomUUID();
      const kafkaConfig = {
        brokers: (process.env.KAFKA_BROKERS ?? '127.0.0.1:23092').split(','),
        clientId: `marketing-lag-${runId}`,
        topic: `marketing-lag-${runId}`,
        groupId: `marketing-lag-${runId}`,
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

        await producer.send({
          topic: kafkaConfig.topic,
          messages: Array.from({ length: UNCONSUMED }, (_, index) => ({
            value: String(index),
          })),
        });
        expect(await reporter.report()).toBe(UNCONSUMED);

        await admin.setOffsets({
          groupId: kafkaConfig.groupId,
          topic: kafkaConfig.topic,
          partitions: [{ partition: 0, offset: String(COMMITTED) }],
        });
        expect(await reporter.report()).toBe(MESSAGES + UNCONSUMED - COMMITTED);

        const state = await readState();
        expect(state).toEqual({
          lag: MESSAGES + UNCONSUMED - COMMITTED,
          updatedAt: NOW,
        });
        expect(lagAllowsSending(state, NOW, { maxLag: 3 })).toBe(false);
        expect(lagAllowsSending(state, NOW, { maxLag: 4 })).toBe(true);
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
