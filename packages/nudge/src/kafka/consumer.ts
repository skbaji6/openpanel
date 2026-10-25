import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import {
  type EachBatchHandler,
  Kafka,
  type KafkaConfig as KafkaJsConfig,
  logLevel,
  type SASLOptions,
} from 'kafkajs';
import type { KafkaConfig } from '../config';
import type { createEngine } from '../engine/engine';
import { type NormalizedEvent, normalizeEvent } from '../events/normalize';
import { redactSecrets } from '../redact';
import type { InterestSet, ProfileKey } from './interest';

const LOG_PREFIX = 'nudge consumer:';
const DEFAULT_RETRY_DELAYS_MS = [100, 400, 1600];
// Well inside kafkajs's 30 s session timeout, so a long batch transaction does not cost the partition.
const HEARTBEAT_INTERVAL_MS = 3000;
// P2034: Prisma's write conflict / deadlock in a transaction. Raw query errors carry the SQLSTATE in meta.code.
const TRANSIENT_PRISMA_CODES = new Set(['P2034']);
const TRANSIENT_SQLSTATES = new Set(['40P01', '40001']);

type HandleBatch = (values: (Buffer | null)[]) => Promise<void>;

function readCa(caPath: string): string {
  try {
    return readFileSync(caPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read KAFKA_SSL_CA_PATH "${caPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function toKafkaSsl(ssl: KafkaConfig['ssl']): ConnectionOptions | boolean {
  if (typeof ssl === 'boolean') {
    return ssl;
  }
  const options: ConnectionOptions = {};
  if (ssl.caPath) {
    options.ca = [readCa(ssl.caPath)];
  }
  if (ssl.rejectUnauthorized !== undefined) {
    options.rejectUnauthorized = ssl.rejectUnauthorized;
  }
  return options;
}

export function createKafka(cfg: KafkaConfig): Kafka {
  const options: KafkaJsConfig = {
    clientId: cfg.clientId,
    brokers: cfg.brokers,
    logLevel: logLevel.WARN,
    ssl: toKafkaSsl(cfg.ssl),
  };
  if (cfg.sasl) {
    // The config's mechanism enum is exactly kafkajs's non-OAuth set; TS cannot correlate the union members.
    options.sasl = { ...cfg.sasl } as SASLOptions;
  }
  return new Kafka(options);
}

function isTransient(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, meta } = error as { code?: unknown; meta?: { code?: unknown } };
  return (
    (typeof code === 'string' && TRANSIENT_PRISMA_CODES.has(code)) ||
    (typeof meta?.code === 'string' && TRANSIENT_SQLSTATES.has(meta.code))
  );
}

function parse(value: Buffer | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value.toString('utf8'));
  } catch (error) {
    console.error(
      LOG_PREFIX,
      'dropping unparseable message',
      redactSecrets(error, [])
    );
    return null;
  }
}

export function createBatchHandler(deps: {
  engine: Pick<ReturnType<typeof createEngine>, 'handleEvents'>;
  interest: InterestSet;
  retryDelaysMs?: number[];
}): HandleBatch {
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  async function write(events: NormalizedEvent[]): Promise<void> {
    for (const delay of [...retryDelaysMs, null]) {
      try {
        return await deps.engine.handleEvents(events);
      } catch (error) {
        if (delay === null || !isTransient(error)) {
          throw error;
        }
        console.warn(LOG_PREFIX, 'retrying batch', redactSecrets(error, []));
        await Bun.sleep(delay);
      }
    }
  }

  return async (values) => {
    // Events without a profile id (anonymous traffic) normalize to null and are skipped silently.
    const candidates = values
      .map((value) => normalizeEvent(parse(value)))
      .filter((event): event is NormalizedEvent => event !== null);
    const interesting = await Promise.all(
      candidates.map((event) =>
        deps.interest.has(event.projectId, event.name, event.profileId)
      )
    );
    const kept = candidates.filter((_event, index) => interesting[index]);
    if (kept.length === 0) {
      return;
    }
    await write(kept);
    const profiles: ProfileKey[] = kept.map((event) => ({
      projectId: event.projectId,
      profileId: event.profileId,
    }));
    try {
      await deps.interest.add(profiles);
    } catch (error) {
      // The periodic refresh rebuilds the set; failing here must not replay a batch that is already written.
      console.error(
        LOG_PREFIX,
        'interest add failed',
        redactSecrets(error, [])
      );
    }
  };
}

export function createEachBatch(handleBatch: HandleBatch): EachBatchHandler {
  return async ({
    batch,
    resolveOffset,
    heartbeat,
    commitOffsetsIfNecessary,
  }) => {
    const beat = setInterval(() => {
      heartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    try {
      await handleBatch(batch.messages.map((message) => message.value));
    } finally {
      clearInterval(beat);
    }
    for (const message of batch.messages) {
      resolveOffset(message.offset);
    }
    await commitOffsetsIfNecessary();
    await heartbeat();
  };
}

export async function startConsumer(
  cfg: KafkaConfig,
  handleBatch: HandleBatch
): Promise<{ stop(): Promise<void> }> {
  const consumer = createKafka(cfg).consumer({ groupId: cfg.groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: cfg.topic, fromBeginning: false });
  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: createEachBatch(handleBatch),
  });
  return { stop: () => consumer.disconnect() };
}
