import { loadConfig, type NudgeConfig } from './config';
import type { createEngine, Sql } from './engine/engine';
import type { TickDeps } from './engine/ticker';
import { redactSecrets } from './redact';

const LOG_PREFIX = 'nudge worker:';
const INTEREST_REFRESH_MS = 10_000;
const PURGE_INTERVAL_MS = 86_400_000;

interface Stoppable {
  stop(): Promise<void>;
}

export interface WorkerContext {
  cfg: NudgeConfig;
  sql: Sql;
  engine: ReturnType<typeof createEngine>;
}

export interface WorkerDeps {
  // Extension point for the HTTP server (Task 9); it is started last and stopped first.
  startHttp?: (context: WorkerContext) => Promise<Stoppable>;
  // Without a signed unsubscribe link no step may be sent, so the ticker only runs once this is wired.
  renderUnsubscribeUrl?: TickDeps['renderUnsubscribeUrl'];
  // Runs after the worker stopped itself because the consumer died for good.
  onFatal?: () => void;
}

function secretsOf(cfg: NudgeConfig): string[] {
  return [
    cfg.encryptionKey,
    cfg.proxySecret,
    cfg.databaseUrl,
    cfg.redisUrl,
    cfg.kafka.sasl?.password,
  ].filter((secret): secret is string => Boolean(secret));
}

// Runs the task now and then intervalMs after each run ends, so runs never overlap; stop waits for the current one.
function every(
  intervalMs: number,
  label: string,
  secrets: string[],
  task: () => Promise<unknown>
): Stoppable {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    running = task()
      .then(
        () => undefined,
        (error: unknown) => {
          console.error(LOG_PREFIX, label, redactSecrets(error, secrets));
        }
      )
      .then(() => {
        if (!stopped) {
          timer = setTimeout(run, intervalMs);
        }
      });
  };
  run();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

export async function startWorker(
  cfg: NudgeConfig,
  deps: WorkerDeps = {}
): Promise<Stoppable> {
  // Must precede the first import of @openpanel/db so the pool honours NUDGE_DB_POOL.
  process.env.DATABASE_URL = cfg.databaseUrl;
  const [
    { sql },
    { migrate },
    { createEngine: buildEngine },
    { runTick },
    { registerDefaultAdapters },
    { getRedisCache },
    { createBatchHandler, startConsumer },
    { createRedisInterestSet },
    { createLagReporter, LAG_REPORT_INTERVAL_MS },
  ] = await Promise.all([
    import('./db/client'),
    import('./db/migrate'),
    import('./engine/engine'),
    import('./engine/ticker'),
    import('./channels/registry'),
    import('@openpanel/redis'),
    import('./kafka/consumer'),
    import('./kafka/interest'),
    import('./kafka/lag'),
  ]);
  const secrets = secretsOf(cfg);
  const started: Stoppable[] = [];
  const stopAll = async () => {
    for (const part of started.reverse()) {
      try {
        await part.stop();
      } catch (error) {
        console.error(LOG_PREFIX, 'stop failed', redactSecrets(error, secrets));
      }
    }
    started.length = 0;
  };

  try {
    started.push({ stop: () => sql.$disconnect() });
    await migrate();
    registerDefaultAdapters({ webhookAllowHosts: cfg.webhookAllowHosts });
    const engine = buildEngine({ sql });

    const redis = getRedisCache();
    started.push({ stop: async () => redis.disconnect() });
    const interest = createRedisInterestSet(redis, { engine, sql });
    // The consumer must not start before the first refresh, or it drops everything.
    await interest.refresh();
    started.push(
      every(INTEREST_REFRESH_MS, 'interest refresh', secrets, () =>
        interest.refresh()
      )
    );

    const lag = createLagReporter({
      kafka: cfg.kafka,
      sql,
      now: () => new Date(),
    });
    started.push(lag);
    started.push(
      every(LAG_REPORT_INTERVAL_MS, 'lag report', secrets, () => lag.report())
    );

    started.push(
      await startConsumer(
        cfg.kafka,
        createBatchHandler({ engine, interest, secrets }),
        {
          secrets,
          onFatal: () => {
            stopAll().finally(() => deps.onFatal?.());
          },
        }
      )
    );

    const { renderUnsubscribeUrl } = deps;
    if (renderUnsubscribeUrl) {
      started.push(
        every(cfg.tickMs, 'tick', secrets, () =>
          runTick({
            sql,
            engine,
            cfg,
            now: () => new Date(),
            renderUnsubscribeUrl,
          })
        )
      );
    } else {
      console.warn(LOG_PREFIX, 'no unsubscribe link renderer; sending is off');
    }

    started.push(
      every(PURGE_INTERVAL_MS, 'purge', secrets, () =>
        engine.purgeOldEvents(cfg.retentionDays)
      )
    );

    if (deps.startHttp) {
      started.push(await deps.startHttp({ cfg, sql, engine }));
    }
  } catch (error) {
    await stopAll();
    throw error;
  }
  return { stop: stopAll };
}

if (import.meta.main) {
  const cfg = loadConfig(process.env);
  const worker = await startWorker(cfg, {
    onFatal: () => process.exit(1),
  });
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
