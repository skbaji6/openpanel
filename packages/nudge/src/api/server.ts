import type { NudgeConfig } from '../config';
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
import { dashboardRoutes } from './routes-dashboard';
import { syncRoutes } from './routes-sync';
import { createUnsubscribeHandlers } from './unsubscribe';

const LOG_PREFIX = 'nudge api:';
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

export interface ServerDeps {
  cfg: NudgeConfig;
  sql: Sql;
  // Lets the worker refresh its interest set as soon as rules change instead of on the next interval.
  onRulesChanged?: () => Promise<void>;
  now?: () => number;
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
  const unsubscribeLimiter = createRateLimiter({
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    now: deps.now,
  });
  const verifyApiKey = createApiKeyVerifier({ sql, now: deps.now });
  const unsubscribe = createUnsubscribeHandlers({
    sql,
    encryptionKey: cfg.encryptionKey,
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

  function limitUnsubscribe(ip: string) {
    if (!unsubscribeLimiter.take(ip)) {
      throw new HttpError(429, 'too_many_requests');
    }
  }

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/nudge\/health$/,
      auth: 'public',
      handle: () => json({ ok: true }),
    },
    ...syncRoutes(sql),
    ...dashboardRoutes({ cfg, sql, onRulesChanged }),
    {
      method: 'GET',
      pattern: /^\/nudge\/unsubscribe$/,
      auth: 'public',
      handle: (ctx) => {
        limitUnsubscribe(ctx.ip);
        return unsubscribe.confirm(ctx.url);
      },
    },
    {
      method: 'POST',
      pattern: /^\/nudge\/unsubscribe$/,
      auth: 'public',
      handle: (ctx) => {
        limitUnsubscribe(ctx.ip);
        return unsubscribe.optOut(ctx.req, ctx.url);
      },
    },
  ];

  async function authenticateApiKey(req: Request, ip: string): Promise<string> {
    if (failedKeyLimiter.limited(ip)) {
      throw new HttpError(429, 'too_many_requests');
    }
    const projectId = await verifyApiKey(req.headers.get('x-nudge-api-key'));
    if (!projectId) {
      failedKeyLimiter.take(ip);
      throw new HttpError(401, 'unauthorized');
    }
    return projectId;
  }

  async function authenticate(route: Route, req: Request, ip: string) {
    const usesApiKey =
      route.auth === 'apiKey' ||
      (route.auth === 'apiKeyOrDashboard' &&
        req.headers.has('x-nudge-api-key'));
    if (route.auth === 'public') {
      return '';
    }
    if (usesApiKey) {
      return await authenticateApiKey(req, ip);
    }
    return authenticateDashboard(req, cfg.proxySecret);
  }

  return {
    async fetch(req: Request, server?: RequestIpSource): Promise<Response> {
      try {
        const url = new URL(req.url);
        const { route, params } = matchRoute(routes, req.method, url.pathname);
        const ip = clientIp(req, server, cfg.trustProxy);
        const projectId = await authenticate(route, req, ip);
        return await route.handle({ req, url, params, projectId, ip });
      } catch (error) {
        if (error instanceof URIError) {
          return json({ error: 'invalid_path' }, 400);
        }
        if (error instanceof HttpError) {
          return json(
            error.issues
              ? { error: error.code, issues: error.issues }
              : { error: error.code },
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
  });
  const server = Bun.serve({
    port: context.cfg.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: (req, bunServer) => app.fetch(req, bunServer),
  });
  return { stop: () => server.stop() };
}
