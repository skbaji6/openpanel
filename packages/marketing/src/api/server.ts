import type { Redis } from '@openpanel/redis';
import type { SourceResolver } from '../audience/resolver';
import type { MarketingConfig } from '../config';
import type { Sql } from '../engine/engine';
import { redactSecrets } from '../redact';
import type { WorkerContext } from '../worker';
import {
  authenticateDashboard,
  clientIp,
  createApiKeyVerifier,
  type RequestIpSource,
} from './auth';
import { HttpError, json, MAX_BODY_BYTES, type Route } from './http';
import { createRateLimiter } from './rate-limit';
import { audienceSourceRoutes } from './routes-audience-source';
import { audienceRoutes } from './routes-audiences';
import { dashboardRoutes } from './routes-dashboard';
import { syncRoutes } from './routes-sync';
import { createUnsubscribeHandlers } from './unsubscribe';

const LOG_PREFIX = 'marketing api:';
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const SERVICE_UNAVAILABLE = 503;

export interface ServerDeps {
  cfg: MarketingConfig;
  sql: Sql;
  // Lets the worker refresh its interest set as soon as rules change instead of on the next interval.
  onRulesChanged?: () => Promise<void>;
  now?: () => number;
  // Both are needed for the audience source settings routes.
  redis?: Redis;
  sources?: SourceResolver;
  sourceFetch?: typeof fetch;
}

function matchRoute(routes: Route[], method: string, pathname: string) {
  let pathMatched = false;
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    pathMatched = true;
    if (route.method === method) {
      return { route, params: match.slice(1).map(decodeURIComponent) };
    }
  }
  throw new HttpError(
    pathMatched ? 405 : 404,
    pathMatched ? 'method_not_allowed' : 'not_found'
  );
}

export function createServer(deps: ServerDeps) {
  const { cfg, sql } = deps;
  const secrets = [
    cfg.encryptionKey,
    cfg.proxySecret,
    cfg.databaseUrl,
    cfg.redisUrl,
  ];
  const failedKeyLimiter = createRateLimiter({
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    now: deps.now,
  });
  const apiKeys = createApiKeyVerifier({ sql, now: deps.now });
  const unsubscribe = createUnsubscribeHandlers({
    sql,
    encryptionKey: cfg.encryptionKey,
    invalidTokenLimiter: createRateLimiter({
      limit: RATE_LIMIT,
      windowMs: RATE_WINDOW_MS,
      now: deps.now,
    }),
  });

  // The rule is already saved; a failed refresh is caught up by the worker's periodic refresh.
  async function onRulesChanged() {
    try {
      await deps.onRulesChanged?.();
    } catch (error) {
      console.error(
        LOG_PREFIX,
        'interest refresh failed',
        redactSecrets(error, secrets)
      );
    }
  }

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/marketing\/health$/,
      auth: 'public',
      // Healthy means the marketing database answers; the cause is logged nowhere and returned to no one.
      async handle() {
        try {
          await sql.$queryRawUnsafe('SELECT 1');
          return json({ ok: true });
        } catch {
          return json({ ok: false }, SERVICE_UNAVAILABLE);
        }
      },
    },
    ...syncRoutes(sql),
    ...dashboardRoutes({ cfg, sql, onRulesChanged }),
    ...(deps.redis && deps.sources
      ? [
          ...audienceSourceRoutes({
            cfg,
            sql,
            redis: deps.redis,
            resolver: deps.sources,
            fetch: deps.sourceFetch,
            now: deps.now,
          }),
          ...audienceRoutes({
            sql,
            redis: deps.redis,
            resolver: deps.sources,
            now: deps.now,
          }),
        ]
      : []),
    {
      method: 'GET',
      pattern: /^\/marketing\/unsubscribe$/,
      auth: 'public',
      handle: (ctx) => unsubscribe.confirm(ctx.url, ctx.ip),
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/unsubscribe$/,
      auth: 'public',
      handle: (ctx) => unsubscribe.optOut(ctx.url, ctx.ip),
    },
  ];

  // A recently verified key skips the limiter, so a caller behind a shared IP is not locked out by others.
  async function authenticateApiKey(req: Request, ip: string): Promise<string> {
    const header = req.headers.get('x-marketing-api-key');
    const cachedProjectId = apiKeys.cached(header);
    if (cachedProjectId) {
      return cachedProjectId;
    }
    if (failedKeyLimiter.limited(ip)) {
      throw new HttpError(429, 'too_many_requests');
    }
    const projectId = await apiKeys.verify(header);
    if (!projectId) {
      failedKeyLimiter.take(ip);
      throw new HttpError(401, 'unauthorized');
    }
    return projectId;
  }

  async function authenticate(
    route: Route,
    req: Request,
    ip: string
  ): Promise<{ projectId: string; userId: string }> {
    const usesApiKey =
      route.auth === 'apiKey' ||
      (route.auth === 'apiKeyOrDashboard' &&
        req.headers.has('x-marketing-api-key'));
    if (route.auth === 'public') {
      return { projectId: '', userId: '' };
    }
    if (usesApiKey) {
      return { projectId: await authenticateApiKey(req, ip), userId: '' };
    }
    return authenticateDashboard(req, cfg.proxySecret);
  }

  return {
    async fetch(req: Request, server?: RequestIpSource): Promise<Response> {
      try {
        const url = new URL(req.url);
        const { route, params } = matchRoute(routes, req.method, url.pathname);
        const ip = clientIp(req, server, cfg.trustProxy);
        const { projectId, userId } = await authenticate(route, req, ip);
        return await route.handle({ req, url, params, projectId, userId, ip });
      } catch (error) {
        if (error instanceof URIError) {
          return json({ error: 'invalid_path' }, 400);
        }
        if (error instanceof HttpError) {
          return json(
            {
              error: error.code,
              ...(error.issues && { issues: error.issues }),
              ...(error.details && { details: error.details }),
            },
            error.status
          );
        }
        console.error(LOG_PREFIX, redactSecrets(error, secrets));
        return json({ error: 'internal' }, 500);
      }
    },
  };
}

export function startHttpServer(context: WorkerContext) {
  const app = createServer({
    cfg: context.cfg,
    sql: context.sql,
    onRulesChanged: context.refreshInterest,
    redis: context.redis,
    sources: context.sources,
  });
  const server = Bun.serve({
    port: context.cfg.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: (req, bunServer) => app.fetch(req, bunServer),
  });
  return { stop: () => server.stop() };
}
