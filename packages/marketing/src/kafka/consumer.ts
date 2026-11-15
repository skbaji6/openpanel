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
import type { ConversionRecorder } from '../tracking/conversions';
import type { InterestSet, ProfileKey } from './interest';

const LOG_PREFIX = 'marketing consumer:';
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

export interface ConsumerLogDeps {
  // Every logged error is redacted against these (the worker passes its config secrets).
  secrets?: string[];
  logger?: Pick<Console, 'warn' | 'error'>;
}

function createLog(deps: ConsumerLogDeps) {
  const logger = deps.logger ?? console;
  const secrets = deps.secrets ?? [];
  return {
    warn: (message: string, error: unknown) =>
      logger.warn(LOG_PREFIX, message, redactSecrets(error, secrets)),
    error: (message: string, error: unknown) =>
      logger.error(LOG_PREFIX, message, redactSecrets(error, secrets)),
  };
}

export function createBatchHandler(
  deps: ConsumerLogDeps & {
    engine: Pick<ReturnType<typeof createEngine>, 'handleEvents'>;
    interest: InterestSet;
    conversions: Pick<ConversionRecorder, 'record'>;
    retryDelaysMs?: number[];
  }
): HandleBatch {
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const log = createLog(deps);

  function parse(value: Buffer | null): unknown {
    if (value === null) {
      return null;
    }
    try {
      return JSON.parse(value.toString('utf8'));
    } catch (error) {
      log.error('dropping unparseable message', error);
      return null;
    }
  }

  async function withTransientRetry(
    run: () => Promise<unknown>
  ): Promise<void> {
    for (const delay of [...retryDelaysMs, null]) {
      try {
        await run();
        return;
      } catch (error) {
        if (delay === null || !isTransient(error)) {
          throw error;
        }
        log.warn('retrying batch', error);
        await Bun.sleep(delay);
      }
    }
  }

  return async (values) => {
    // Events without a profile id (anonymous traffic) normalize to null and are skipped silently.
    const candidates = values
      .map((value) => normalizeEvent(parse(value)))
      .filter((event): event is NormalizedEvent => event !== null);
    // Before the interest filter: an app open is rarely from a profile the rules know. Idempotent, so a replay is safe.
    // Optional: a failure here must not block rules. A missed conversion is credited by a later event, if any.
    try {
      await withTransientRetry(() => deps.conversions.record(candidates));
    } catch (error) {
      log.error(
        'conversion record failed',
        error instanceof Error ? error.name : typeof error
      );
    }
    const interesting = await deps.interest.hasMany(candidates);
    const kept = candidates.filter((_event, index) => interesting[index]);
    if (kept.length === 0) {
      return;
    }
    await withTransientRetry(() => deps.engine.handleEvents(kept));
    const profiles: ProfileKey[] = kept.map((event) => ({
      projectId: event.projectId,
      profileId: event.profileId,
    }));
    try {
      await deps.interest.add(profiles);
    } catch (error) {
      // The periodic refresh rebuilds the set; failing here must not replay a batch that is already written.
      log.error('interest add failed', error);
    }
  };
}

export function createEachBatch(
  handleBatch: HandleBatch,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS
): EachBatchHandler {
  return async ({
    batch,
    resolveOffset,
    heartbeat,
    commitOffsetsIfNecessary,
  }) => {
    const beat = setInterval(() => {
      heartbeat().catch(() => undefined);
    }, heartbeatIntervalMs);
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
  handleBatch: HandleBatch,
  deps: ConsumerLogDeps & {
    // Called when kafkajs gives up on the consumer; the worker then stops so a process manager restarts it.
    onFatal?: () => void;
  } = {}
): Promise<{ stop(): Promise<void> }> {
  const log = createLog(deps);
  const consumer = createKafka(cfg).consumer({ groupId: cfg.groupId });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    log.error(
      payload.restart ? 'crashed, restarting' : 'crashed, not restarting',
      payload.error
    );
    if (!payload.restart) {
      deps.onFatal?.();
    }
  });
  await consumer.connect();
  await consumer.subscribe({ topic: cfg.topic, fromBeginning: false });
  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: createEachBatch(handleBatch),
  });
  return { stop: () => consumer.disconnect() };
}
