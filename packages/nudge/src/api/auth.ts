import crypto from 'node:crypto';
import { verifyPassword } from '@openpanel/shared/server';
import type { Queryable } from '../engine/engine';
import { HttpError } from './http';

const API_KEY_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{20,128})$/;
const API_KEY_CACHE_MS = 5 * 60_000;
const API_KEY_CACHE_MAX = 1000;
// The proxy forwards ids it verified with core; the format check keeps junk out of queries and logs.
const DASHBOARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestIpSource {
  requestIP(req: Request): { address: string } | null;
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

// Hashing first gives equal-length inputs, so neither the result nor the timing leaks the secret's length.
export function secretsMatch(given: string, expected: string): boolean {
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

// The rightmost x-forwarded-for entry is the one our own proxy appended; earlier ones are client-controlled.
export function clientIp(
  req: Request,
  server: RequestIpSource | undefined,
  trustProxy: boolean
): string {
  if (trustProxy) {
    const forwarded = req.headers
      .get('x-forwarded-for')
      ?.split(',')
      .at(-1)
      ?.trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return server?.requestIP(req)?.address ?? 'unknown';
}

export function authenticateDashboard(req: Request, proxySecret: string) {
  const given = req.headers.get('x-nudge-proxy-secret');
  if (given === null || !secretsMatch(given, proxySecret)) {
    throw new HttpError(401, 'unauthorized');
  }
  const projectId = req.headers.get('x-nudge-project-id') ?? '';
  const userId = req.headers.get('x-nudge-user-id') ?? '';
  const validIdentity =
    DASHBOARD_ID_PATTERN.test(projectId) && DASHBOARD_ID_PATTERN.test(userId);
  if (!validIdentity) {
    throw new HttpError(400, 'invalid_identity');
  }
  if (
    MUTATING_METHODS.has(req.method) &&
    req.headers.get('x-nudge-csrf') !== '1'
  ) {
    throw new HttpError(403, 'csrf_header_required');
  }
  return projectId;
}

async function verifySecret(secret: string, keyHash: string) {
  try {
    return await verifyPassword(secret, keyHash);
  } catch {
    return false;
  }
}

// Resolves an `<id>.<secret>` header to its project id, or null. Hits are cached by the header's hash.
export function createApiKeyVerifier(deps: {
  sql: Queryable;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { projectId: string; expiresAt: number }>();

  return async (header: string | null): Promise<string | null> => {
    const match = header ? API_KEY_PATTERN.exec(header) : null;
    if (!(header && match)) {
      return null;
    }
    const cacheKey = sha256(header).toString('hex');
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      return cached.projectId;
    }
    cache.delete(cacheKey);
    const [, id, secret] = match;
    const [row] = await deps.sql.$queryRawUnsafe<
      { project_id: string; key_hash: string }[]
    >(
      'SELECT project_id, key_hash FROM nudge.api_keys WHERE id = $1::uuid',
      id
    );
    if (!(row && secret && (await verifySecret(secret, row.key_hash)))) {
      return null;
    }
    const oldest = cache.keys().next();
    if (cache.size >= API_KEY_CACHE_MAX && !oldest.done) {
      cache.delete(oldest.value);
    }
    cache.set(cacheKey, {
      projectId: row.project_id,
      expiresAt: now() + API_KEY_CACHE_MS,
    });
    return row.project_id;
  };
}
