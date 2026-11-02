import type { Redis } from '@openpanel/redis';
import { decryptCredential, encryptCredential } from '@openpanel/shared/server';
import { z } from 'zod';
import { createBreaker } from '../audience/breaker';
import {
  SourceAuthError,
  SourceBusyError,
  SourceProtocolError,
  SourceUnavailableError,
} from '../audience/errors';
import { createHttpSource } from '../audience/http-source';
import { createSourceLimiter } from '../audience/limiter';
import type { SourceResolver, SourceRow } from '../audience/resolver';
import type { MarketingConfig } from '../config';
import type { Queryable, Sql } from '../engine/engine';
import { HttpError, json, parseJsonBody, type Route } from './http';

const MAX_FIELD_LENGTH = 2048;
const TEST_SLOT_TTL_MS = 30_000;
// The test must show the real failure, so its throwaway breaker never opens.
const NEVER_OPEN = 1_000_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TRAILING_SLASHES = /\/+$/;

interface Deps {
  cfg: MarketingConfig;
  sql: Queryable & Pick<Sql, '$transaction'>;
  redis: Redis;
  resolver: SourceResolver;
  fetch?: typeof fetch;
  now?: () => number;
}

function normalizeBaseUrl(value: string): string | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  const allowedScheme =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  const path = url.pathname.replace(TRAILING_SLASHES, '');
  // An empty segment is never needed and // can be read as the start of another host.
  const clean = !(
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    path.includes('//')
  );
  if (!(allowedScheme && clean)) {
    return null;
  }
  return `${url.origin}${path}`;
}

const zBody = z.strictObject({
  kind: z.enum(['stored', 'http']),
  baseUrl: z.string().max(MAX_FIELD_LENGTH).optional(),
  keyId: z.string().trim().min(1).max(MAX_FIELD_LENGTH).optional(),
  // Empty keeps the stored secret.
  secret: z.string().max(MAX_FIELD_LENGTH).optional(),
});

const SAVE_SOURCE_SQL = `
  INSERT INTO marketing.audience_sources (project_id, kind, base_url, key_id, secret_encrypted)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (project_id) DO UPDATE SET kind = EXCLUDED.kind, base_url = EXCLUDED.base_url,
    key_id = EXCLUDED.key_id, secret_encrypted = EXCLUDED.secret_encrypted, updated_at = now(),
    status = 'unknown', status_at = NULL`;

// An http project keeps no contact data; its opt-outs and dead-token hashes are ids only and stay.
const PURGE_CONTACT_DATA_SQL = [
  'DELETE FROM marketing.contacts WHERE project_id = $1',
  'DELETE FROM marketing.devices WHERE project_id = $1',
];

function failureCode(error: unknown) {
  if (error instanceof SourceAuthError) {
    return 'source_auth_failed';
  }
  if (
    error instanceof SourceUnavailableError ||
    error instanceof SourceBusyError
  ) {
    return 'unreachable';
  }
  if (error instanceof SourceProtocolError) {
    return 'protocol_error';
  }
  throw error;
}

export function audienceSourceRoutes(deps: Deps): Route[] {
  const { cfg, sql } = deps;
  const now = deps.now ?? Date.now;

  async function load(projectId: string) {
    const [row] = await sql.$queryRawUnsafe<(SourceRow & { status: string })[]>(
      'SELECT kind, base_url, key_id, secret_encrypted, status FROM marketing.audience_sources WHERE project_id = $1',
      projectId
    );
    return row;
  }

  return [
    {
      method: 'GET',
      pattern: /^\/marketing\/audience-source$/,
      auth: 'dashboard',
      async handle(ctx) {
        const row = await load(ctx.projectId);
        return json({
          kind: row?.kind ?? 'stored',
          baseUrl: row?.base_url ?? null,
          keyId: row?.key_id ?? null,
          hasSecret: Boolean(row?.secret_encrypted),
          status: row?.status ?? 'unknown',
        });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/marketing\/audience-source$/,
      auth: 'dashboard',
      async handle(ctx) {
        const body = await parseJsonBody(ctx.req, zBody);
        let baseUrl: string | null = null;
        let keyId: string | null = null;
        let secretEncrypted: string | null = null;
        if (body.kind === 'http') {
          baseUrl = normalizeBaseUrl(body.baseUrl ?? '');
          if (!baseUrl) {
            throw new HttpError(400, 'invalid_base_url');
          }
          keyId = body.keyId ?? null;
          const stored = await load(ctx.projectId);
          // A kept secret must not sign requests to a host or key the admin did not enter it for.
          const targetChanged =
            stored?.base_url !== baseUrl || stored?.key_id !== keyId;
          if (!body.secret && stored?.secret_encrypted && targetChanged) {
            throw new HttpError(400, 'secret_required');
          }
          secretEncrypted = body.secret
            ? encryptCredential(cfg.encryptionKey, body.secret)
            : (stored?.secret_encrypted ?? null);
          if (!(keyId && secretEncrypted)) {
            throw new HttpError(400, 'invalid_body');
          }
        }
        // Separate statements in one transaction: the upsert waits for any sync holding the source row,
        // and each purge then takes a fresh snapshot that includes what that sync committed.
        await sql.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            SAVE_SOURCE_SQL,
            ctx.projectId,
            body.kind,
            baseUrl,
            keyId,
            secretEncrypted
          );
          if (body.kind === 'http') {
            for (const purge of PURGE_CONTACT_DATA_SQL) {
              await tx.$executeRawUnsafe(purge, ctx.projectId);
            }
          }
        });
        deps.resolver.invalidate(ctx.projectId);
        return json({
          kind: body.kind,
          baseUrl,
          keyId,
          hasSecret: secretEncrypted !== null,
          status: 'unknown',
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/audience-source\/test$/,
      auth: 'dashboard',
      async handle(ctx) {
        const row = await load(ctx.projectId);
        if (
          !(
            row?.kind === 'http' &&
            row.base_url &&
            row.key_id &&
            row.secret_encrypted
          )
        ) {
          throw new HttpError(400, 'not_configured');
        }
        const source = createHttpSource({
          baseUrl: row.base_url,
          keyId: row.key_id,
          secret: decryptCredential(cfg.encryptionKey, row.secret_encrypted),
          limiter: createSourceLimiter(deps.redis, {
            key: ctx.projectId,
            cap: cfg.sourceConcurrency,
            slotTtlMs: TEST_SLOT_TTL_MS,
            now,
          }),
          breaker: createBreaker({
            failureThreshold: NEVER_OPEN,
            openMs: NEVER_OPEN,
            now,
          }),
          fetch: deps.fetch,
          now,
        });
        const started = now();
        try {
          const schema = await source.schema();
          return json({
            ok: true,
            dimensions: schema.dimensions,
            latencyMs: now() - started,
          });
        } catch (error) {
          return json({ ok: false, error: failureCode(error) });
        }
      },
    },
  ];
}
