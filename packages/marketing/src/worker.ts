import type { Redis } from '@openpanel/redis';
import { createUnsubscribeUrlRenderer } from './api/unsubscribe';
import type { SourceResolver } from './audience/resolver';
import { loadConfig, type MarketingConfig } from './config';
import { purgeDeadTokens } from './engine/dead-tokens';
import type { createEngine, Sql } from './engine/engine';
import { purgeSendHistory } from './engine/ledger';
import type { TickDeps } from './engine/ticker';
import { redactSecrets } from './redact';
import { purgeTracking } from './tracking/purge';
import {
  createReportMatcher,
  HOLD_RETRY_MS,
  type ReportMatcher,
} from './tracking/report-matcher';
import {
  createTrackingSettingsCache,
  type TrackingSettingsCache,
} from './tracking/settings';

const LOG_PREFIX = 'marketing worker:';
const INTEREST_REFRESH_MS = 10_000;
// Hourly with a time budget per run, so a project that stores every event still keeps up.
const PURGE_INTERVAL_MS = 3_600_000;

export interface Stoppable {
  stop(): Promise<void>;
}

export interface WorkerContext {
  cfg: MarketingConfig;
  sql: Sql;
  engine: ReturnType<typeof createEngine>;
  refreshInterest: () => Promise<void>;
  redis: Redis;
  sources: SourceResolver;
  trackingSettings: TrackingSettingsCache;
  reportMatcher: ReportMatcher;
}

export interface WorkerDeps {
  // Extension point for the HTTP server (Task 9); it is started last and stopped first.
  startHttp?: (context: WorkerContext) => Promise<Stoppable>;
  // Without a signed unsubscribe link no step may be sent, so the ticker only runs once this is wired.
  renderUnsubscribeUrl?: TickDeps['renderUnsubscribeUrl'];
  // Called once with the per-project settings cache, so the renderer can read each project's public url.
  onTrackingSettings?: (cache: TrackingSettingsCache) => void;
  // Runs after the worker stopped itself because the consumer died for good.
  onFatal?: () => void;
}

// Per-project audience secrets are decrypted later and are not here, so no code path may log them.
function secretsOf(cfg: MarketingConfig): string[] {
  return [
    cfg.encryptionKey,
    cfg.proxySecret,
    cfg.databaseUrl,
    cfg.redisUrl,
    cfg.kafka.sasl?.password,
  ].filter((secret): secret is string => Boolean(secret));
}

// Runs the task now and then intervalMs after each run ends, so runs never overlap; stop waits for the current one.
// A long task can poll `stopping` to cut that wait short.
function every(
  intervalMs: number,
  label: string,
  secrets: string[],
  task: (stopping: () => boolean) => Promise<unknown>
): Stoppable {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    running = task(() => stopped)
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

// Stops the parts newest first, once: a fatal consumer and a SIGTERM can both ask at the same time.
export function createStopAll(
  started: Stoppable[],
  secrets: string[]
): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      for (const part of [...started].reverse()) {
        try {
          await part.stop();
        } catch (error) {
          console.error(
            LOG_PREFIX,
            'stop failed',
            redactSecrets(error, secrets)
          );
        }
      }
      started.length = 0;
    })();
    return stopping;
  };
}

export async function startWorker(
  cfg: MarketingConfig,
  deps: WorkerDeps = {}
): Promise<Stoppable> {
  // Must precede the first import of db/client so the pool honours MARKETING_DB_POOL.
  const dedicated = Boolean(process.env.MARKETING_DATABASE_URL?.trim());
  process.env[dedicated ? 'MARKETING_DATABASE_URL' : 'DATABASE_URL'] =
    cfg.databaseUrl;
  const [
    { sql },
    { migrate },
    { createEngine: buildEngine },
    { createTickState, runTick },
    { closeBatchAdapters, registerDefaultAdapters },
    { getRedisCache },
    { createBatchHandler, startConsumer },
    { createRedisInterestSet },
    { createLagReporter, LAG_REPORT_INTERVAL_MS },
    { createSourceResolver },
    { runScheduleTick },
    { createChannelReady, pinTemplate },
    { runMaterializeTick },
    { createAudienceStore },
    { createCampaignService },
    { createTemplateRegistry },
    { createChannelBackoff, createRateBucket },
    { runReapTick, startDispatchLane },
    { runTestSendTick },
    { runJourneyTestSendTick },
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
    import('./audience/resolver'),
    import('./campaign/scheduler'),
    import('./campaign/channel-ready'),
    import('./campaign/materialize-runner'),
    import('./audience/store'),
    import('./campaign/service'),
    import('./templates/registry'),
    import('./campaign/pacing'),
    import('./campaign/dispatch-lane'),
    import('./campaign/test-sends'),
    import('./journeys/test-send'),
  ]);
  const now = () => new Date();
  const secrets = secretsOf(cfg);
  const started: Stoppable[] = [];
  const stopAll = createStopAll(started, secrets);

  try {
    started.push({ stop: () => sql.$disconnect() });
    await migrate();
    registerDefaultAdapters({ webhookAllowHosts: cfg.webhookAllowHosts });
    // Pooled SMTP connections close only after every sending job above them has stopped.
    started.push({ stop: async () => closeBatchAdapters() });
    const engine = buildEngine({ sql });

    const redis = getRedisCache();
    started.push({ stop: async () => redis.disconnect() });
    const sources = createSourceResolver({ sql, cfg, redis });
    const trackingSettings = createTrackingSettingsCache({ sql });
    deps.onTrackingSettings?.(trackingSettings);
    const reportMatcher = createReportMatcher({
      sql,
      sources,
      log: (message) => console.warn(LOG_PREFIX, message),
    });
    const sourceFor = (projectId: string) => sources.forProject(projectId);
    const templates = createTemplateRegistry({ sql, now });
    const campaigns = createCampaignService({
      sql,
      cfg,
      audiences: createAudienceStore({ sql, source: sourceFor, now }),
      source: sourceFor,
      now,
      channelReady: createChannelReady({ sql, registry: templates }),
      pinTemplate,
    });
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
      const tickState = createTickState();
      started.push(
        every(cfg.tickMs, 'tick', secrets, () =>
          runTick({
            sql,
            engine,
            cfg,
            now: () => new Date(),
            renderUnsubscribeUrl,
            state: tickState,
            sources,
            trackingSettings,
          })
        )
      );
      const dispatchDeps = {
        sql,
        redis,
        cfg,
        sources,
        registry: templates,
        campaigns,
        bucket: createRateBucket(redis, {}),
        backoff: createChannelBackoff(redis),
        renderUnsubscribeUrl,
        trackingSettings,
        now,
        sleep: (ms: number) => Bun.sleep(ms),
      };
      started.push(
        startDispatchLane({
          ...dispatchDeps,
          concurrency: cfg.campaignConcurrency,
          idleMs: cfg.tickMs,
          secrets,
        }),
        every(cfg.tickMs, 'test sends', secrets, () =>
          runTestSendTick(dispatchDeps)
        ),
        every(cfg.tickMs, 'journey test sends', secrets, () =>
          runJourneyTestSendTick(dispatchDeps)
        )
      );
    } else {
      console.warn(LOG_PREFIX, 'no unsubscribe link renderer; sending is off');
    }

    // Not gated on the unsubscribe renderer: none of these jobs sends anything.
    started.push(
      every(cfg.tickMs, 'reap campaign leases', secrets, () =>
        runReapTick({ sql, campaigns, now, secrets })
      ),
      every(cfg.tickMs, 'campaign schedules', secrets, () =>
        runScheduleTick({ sql, now: () => new Date(), pinTemplate })
      ),
      every(cfg.tickMs, 'campaign materialisation', secrets, (stopping) =>
        runMaterializeTick({
          sql,
          sources,
          redis,
          cfg,
          now: () => new Date(),
          stopping,
        })
      )
    );

    // Reports that beat their message's mark are retried until they match or expire.
    started.push(
      every(HOLD_RETRY_MS, 'flush held reports', secrets, () =>
        reportMatcher.flushHeld()
      )
    );

    // Separate jobs: a persistent failure in one must not stop the other's retention.
    started.push(
      every(PURGE_INTERVAL_MS, 'purge dead tokens', secrets, () =>
        purgeDeadTokens(sql)
      ),
      every(PURGE_INTERVAL_MS, 'purge events', secrets, () =>
        engine.purgeOldEvents(cfg.retentionDays)
      ),
      every(PURGE_INTERVAL_MS, 'purge send history', secrets, () =>
        purgeSendHistory(sql)
      ),
      every(PURGE_INTERVAL_MS, 'purge tracking', secrets, () =>
        purgeTracking(sql)
      )
    );

    if (deps.startHttp) {
      started.push(
        await deps.startHttp({
          cfg,
          sql,
          engine,
          refreshInterest: () => interest.refresh(),
          redis,
          sources,
          trackingSettings,
          reportMatcher,
        })
      );
    }
  } catch (error) {
    await stopAll();
    throw error;
  }
  return { stop: stopAll };
}

// What the process runs in production: the HTTP API and signed unsubscribe links (which turn the ticker on).
export function defaultWorkerDeps(cfg: MarketingConfig): WorkerDeps {
  let settings: TrackingSettingsCache | undefined;
  return {
    renderUnsubscribeUrl: createUnsubscribeUrlRenderer(
      cfg,
      (projectId) => settings?.peek(projectId)?.publicUrl
    ),
    onTrackingSettings: (cache) => {
      settings = cache;
    },
    // Imported lazily so @openpanel/db is first loaded after startWorker sets DATABASE_URL.
    startHttp: async (context) => {
      const { startHttpServer } = await import('./api/server');
      return startHttpServer(context);
    },
  };
}

if (import.meta.main) {
  const cfg = loadConfig(process.env);
  const worker = await startWorker(cfg, {
    ...defaultWorkerDeps(cfg),
    onFatal: () => process.exit(1),
  });
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
