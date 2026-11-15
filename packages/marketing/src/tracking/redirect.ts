import type { RateLimiter } from '../api/rate-limit';
import type { Sql } from '../engine/engine';
import { linkKey } from './keys';
import { openLinkToken } from './token';

const HTTP_URL_PATTERN = /^https?:\/\//i;
const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

// Fixed pages: nothing from the request, the token or the database is ever rendered.
function page(status: number, message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${message}</title></head><body><p>${message}</p></body></html>`,
    {
      status,
      headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8' },
    }
  );
}

const CLICK_SQL = `
  UPDATE marketing.message_tracking SET
    clicked_at = $1,
    accepted_at = COALESCE(accepted_at, sent_at),
    status = CASE WHEN marketing.message_status_rank(status) < marketing.message_status_rank('clicked')
      THEN 'clicked' ELSE status END
  WHERE source_ref = $2 AND project_id = $3 AND clicked_at IS NULL`;

export function createRedirectHandler(deps: {
  sql: Sql;
  encryptionKey: string;
  invalidTokenLimiter: Pick<RateLimiter, 'limited' | 'take'>;
  now: () => Date;
  log: { error(message: string, error: unknown): void };
}) {
  const { sql, invalidTokenLimiter: limiter } = deps;
  const keyFor = (projectId: string) => linkKey(deps.encryptionKey, projectId);

  return async (token: string, ip: string): Promise<Response> => {
    const now = deps.now();
    const opened = openLinkToken(keyFor, token, now);
    // Only invalid tokens are charged and limited, so students behind one shared IP are not locked out.
    if (!opened.ok && opened.reason === 'invalid') {
      if (limiter.limited(ip)) {
        return page(429, 'Too many requests');
      }
      limiter.take(ip);
      return page(404, 'Link not found');
    }
    if (!opened.ok) {
      return page(410, 'This link has expired');
    }
    const { projectId, target } = opened;
    const rows = await sql
      .$queryRawUnsafe<{ url: string }[]>(
        'SELECT url FROM marketing.tracked_links WHERE id = $1::uuid AND project_id = $2',
        target.linkId,
        projectId
      )
      .catch((error: unknown) => {
        deps.log.error('link lookup failed', error);
        return null;
      });
    const url = rows?.[0]?.url;
    if (!(url && HTTP_URL_PATTERN.test(url))) {
      return page(rows ? 404 : 503, rows ? 'Link not found' : 'Try again');
    }
    try {
      await sql.$executeRawUnsafe(CLICK_SQL, now, target.sourceRef, projectId);
    } catch (error) {
      deps.log.error('click write failed', error);
    }
    try {
      return new Response(null, {
        status: 302,
        headers: { ...HEADERS, location: url },
      });
    } catch {
      return page(404, 'Link not found');
    }
  };
}
