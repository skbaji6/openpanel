import { describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config';
import { sql } from './db/client';
import { migrate } from './db/migrate';
import { createKafka } from './kafka/consumer';
import { createStopAll, startWorker } from './worker';

const WORKER_TEST_TIMEOUT_MS = 30_000;
const LAG_WAIT_MS = 10_000;
const POLL_MS = 100;

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
        KAFKA_EVENTS_TOPIC: `nudge-worker-${runId}`,
        NUDGE_KAFKA_GROUP: `nudge-worker-${runId}`,
        ENCRYPTION_KEY: 'test-encryption-key',
        NUDGE_PROXY_SECRET: 'test-proxy-secret',
        NUDGE_PUBLIC_URL: 'https://nudge.test',
      });
      const admin = createKafka(cfg.kafka).admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: cfg.kafka.topic, numPartitions: 1 }],
        waitForLeaders: true,
      });
      await migrate();
      await sql.$executeRawUnsafe('DELETE FROM nudge.consumer_state');
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
        'nudge worker:',
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
        'refreshInterest',
        'sql',
      ]);

      const deadline = Date.now() + LAG_WAIT_MS;
      let rows: { lag: bigint }[] = [];
      while (rows.length === 0 && Date.now() < deadline) {
        await Bun.sleep(POLL_MS);
        rows = await sql.$queryRawUnsafe<{ lag: bigint }[]>(
          'SELECT lag FROM nudge.consumer_state WHERE id = 1'
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
