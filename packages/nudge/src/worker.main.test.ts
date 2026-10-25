import { describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unsubscribeKey, verifyUnsubscribeToken } from './api/unsubscribe';
import { loadConfig } from './config';
import { migrate } from './db/migrate';
import { createKafka } from './kafka/consumer';
import { defaultWorkerDeps, startWorker } from './worker';

const WORKER_TEST_TIMEOUT_MS = 30_000;

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port ?? 0;
}

describe('defaultWorkerDeps', () => {
  it(
    'the deps the main path uses serve the HTTP API and turn the ticker on',
    async () => {
      const runId = randomUUID();
      const port = freePort();
      const cfg = loadConfig({
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
        KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? '127.0.0.1:23092',
        KAFKA_EVENTS_TOPIC: `nudge-main-${runId}`,
        NUDGE_KAFKA_GROUP: `nudge-main-${runId}`,
        ENCRYPTION_KEY: 'test-encryption-key',
        NUDGE_PROXY_SECRET: 'test-proxy-secret',
        NUDGE_PUBLIC_URL: 'https://nudge.test',
        NUDGE_PORT: String(port),
      });
      const admin = createKafka(cfg.kafka).admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: cfg.kafka.topic, numPartitions: 1 }],
        waitForLeaders: true,
      });
      await migrate();
      const deps = defaultWorkerDeps(cfg);
      const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
      const worker = await startWorker(cfg, deps);
      // The only warning startWorker emits is the "sending is off" one, when the ticker is not started.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
      const health = await fetch(`http://127.0.0.1:${port}/nudge/health`);
      expect(await health.json()).toEqual({ ok: true });

      const url = new URL(
        deps.renderUnsubscribeUrl?.('proj-a', 'u1', 'email') ?? ''
      );
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://nudge.test/nudge/unsubscribe'
      );
      expect(
        verifyUnsubscribeToken(
          unsubscribeKey(cfg.encryptionKey),
          url.searchParams.get('t')
        )
      ).toEqual({ projectId: 'proj-a', profileId: 'u1', channel: 'email' });

      await worker.stop();
      await admin.deleteTopics({ topics: [cfg.kafka.topic] });
      await admin.disconnect();
      await expect(
        fetch(`http://127.0.0.1:${port}/nudge/health`)
      ).rejects.toThrow();
    },
    WORKER_TEST_TIMEOUT_MS
  );
});
