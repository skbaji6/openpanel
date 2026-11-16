import type { Redis } from '@openpanel/redis';
import { decryptCredential } from '@openpanel/shared/server';
import type { MarketingConfig } from '../config';
import type { Queryable } from '../engine/engine';
import { createBreaker } from './breaker';
import { createHttpSource } from './http-source';
import { createSourceLimiter } from './limiter';
import type { AudienceSource } from './source';

const CACHE_MS = 30_000;
// Above the 10 s request timeout, so a slot outlives any call that still holds it.
const SLOT_TTL_MS = 30_000;
const BREAKER_FAILURES = 5;
const BREAKER_OPEN_MS = 30_000;

export interface SourceRow {
  kind: 'stored' | 'http';
  base_url: string | null;
  key_id: string | null;
  secret_encrypted: string | null;
}

interface ResolverDeps {
  sql: Queryable;
  cfg: MarketingConfig;
  redis: Redis;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createSourceResolver(deps: ResolverDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<
    string,
    { source: AudienceSource | null; expiresAt: number }
  >();

  async function build(projectId: string): Promise<AudienceSource | null> {
    const [row] = await deps.sql.$queryRawUnsafe<SourceRow[]>(
      'SELECT kind, base_url, key_id, secret_encrypted FROM marketing.audience_sources WHERE project_id = $1',
      projectId
    );
    if (
      !(
        row?.kind === 'http' &&
        row.base_url &&
        row.key_id &&
        row.secret_encrypted
      )
    ) {
      return null;
    }
    return createHttpSource({
      baseUrl: row.base_url,
      keyId: row.key_id,
      secret: decryptCredential(deps.cfg.encryptionKey, row.secret_encrypted),
      limiter: createSourceLimiter(deps.redis, {
        key: projectId,
        cap: deps.cfg.sourceConcurrency,
        slotTtlMs: SLOT_TTL_MS,
        now,
      }),
      // Rebuilt on every cache refresh: breaker state is per process and resets about every 30 s.
      breaker: createBreaker({
        failureThreshold: BREAKER_FAILURES,
        openMs: BREAKER_OPEN_MS,
        now,
      }),
      fetch: deps.fetch,
      now,
    });
  }

  return {
    async forProject(projectId: string): Promise<AudienceSource | null> {
      const hit = cache.get(projectId);
      if (hit && hit.expiresAt > now()) {
        return hit.source;
      }
      const source = await build(projectId);
      cache.set(projectId, { source, expiresAt: now() + CACHE_MS });
      return source;
    },
    invalidate(projectId: string) {
      cache.delete(projectId);
    },
  };
}

export type SourceResolver = ReturnType<typeof createSourceResolver>;
