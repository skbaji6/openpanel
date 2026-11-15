import { timingSafeEqual } from 'node:crypto';
import { HttpError, json, readBodyText } from '../api/http';
import type { RateLimiter } from '../api/rate-limit';
import type { Queryable } from '../engine/engine';
import { applyDeliveryUpdates } from './delivery';
import { webhookSecret } from './keys';
import { MAX_REPORTS_PER_CALL, parseMsg91Reports } from './msg91-reports';
import type { ReportMatcher } from './report-matcher';

export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
const TOO_MANY_REQUESTS = 429;
const UNAUTHORIZED = 401;
const PAYLOAD_TOO_LARGE = 413;
const SERVICE_UNAVAILABLE = 503;

function secretsMatch(given: string, expected: string): boolean {
  const givenBytes = Buffer.from(given);
  const expectedBytes = Buffer.from(expected);
  return (
    givenBytes.length === expectedBytes.length &&
    timingSafeEqual(givenBytes, expectedBytes)
  );
}

export function createMsg91WebhookHandler(deps: {
  matcher: Pick<ReportMatcher, 'match'>;
  sql: Queryable;
  encryptionKey: string;
  failedAuthLimiter: Pick<RateLimiter, 'limited' | 'take'>;
  // Only the route name and error types are ever passed: never the path, the secret or the body.
  log: {
    warn(message: string): void;
    error(message: string, error: unknown): void;
  };
  now?: () => Date;
}) {
  const { matcher, sql, failedAuthLimiter: limiter, log } = deps;
  const now = deps.now ?? (() => new Date());

  return async (
    projectId: string,
    secret: string,
    request: Request,
    ip: string
  ): Promise<Response> => {
    // Only wrong secrets are charged and limited, so a correct sender behind a shared bucket is never locked out.
    if (!secretsMatch(secret, webhookSecret(deps.encryptionKey, projectId))) {
      if (limiter.limited(ip)) {
        return json({ error: 'too_many_requests' }, TOO_MANY_REQUESTS);
      }
      limiter.take(ip);
      return json({ error: 'unauthorized' }, UNAUTHORIZED);
    }
    let text: string;
    try {
      text = await readBodyText(request, MAX_WEBHOOK_BODY_BYTES);
    } catch (error) {
      if (error instanceof HttpError && error.status === PAYLOAD_TOO_LARGE) {
        return json({ error: 'payload_too_large' }, PAYLOAD_TOO_LARGE);
      }
      text = '';
    }
    const { reports, ignored } = parseMsg91Reports(text, now());
    if (reports.length > MAX_REPORTS_PER_CALL) {
      return json({ error: 'payload_too_large' }, PAYLOAD_TOO_LARGE);
    }
    if (reports.length === 0 && ignored === 0) {
      log.warn('msg91 report unparseable');
      return json({ applied: 0, unmatched: 0, ignored: 0 });
    }
    let matched: Awaited<ReturnType<typeof matcher.match>>;
    try {
      matched = await matcher.match(projectId, reports);
    } catch (error) {
      log.error('msg91 report lookup failed', error);
      return json({ error: 'source_unavailable' }, SERVICE_UNAVAILABLE);
    }
    try {
      const applied = await applyDeliveryUpdates(
        sql,
        projectId,
        matched.updates
      );
      return json({ applied, unmatched: matched.unmatched, ignored });
    } catch (error) {
      log.error('msg91 report write failed', error);
      return json({ error: 'unavailable' }, SERVICE_UNAVAILABLE);
    }
  };
}
