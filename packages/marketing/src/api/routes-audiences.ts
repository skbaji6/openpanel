import { randomUUID } from 'node:crypto';
import type { Redis } from '@openpanel/redis';
import { z } from 'zod';
import {
  countAudience,
  explainAudience,
  MAX_PREVIEW_LIMIT,
  previewAudience,
  resolveInputs,
} from '../audience/builder';
import { MAX_PAGE_SIZE } from '../audience/contract';
import { zAudienceInput, zIdListChange } from '../audience/definition';
import type { SourceResolver } from '../audience/resolver';
import type { AudienceSource } from '../audience/source';
import { createAudienceStore, sourceHttpError } from '../audience/store';
import type { Sql } from '../engine/engine';
import { HttpError, json, parseJsonBody, type Route, validate } from './http';
import { zIdentifier } from './routes-sync';

const DEFAULT_VALUES_LIMIT = 20;
const MAX_VALUES_LIMIT = 100;
const MAX_QUERY_LENGTH = 200;
const MAX_CURSOR_LENGTH = 256;
const MAX_RESOLVE_INPUT_LENGTH = 256;
// A paste may hold blank and duplicate lines; the builder caps what is left after trimming.
const MAX_RESOLVE_BODY_INPUTS = 1000;
const DEFAULT_PREVIEW_LIMIT = 20;
const FREEZE_LOCK_PREFIX = 'marketing:audience-freeze:';
// Renewed while the freeze runs; only bounds how long a crashed holder blocks the audience.
const FREEZE_LOCK_TTL_MS = 60_000;
const RENEW_DIVISOR = 3;
const NO_CONTENT = 204;

const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const RENEW_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;

const zExpectedVersion = z.number().int().min(1);
const zUpdate = z.strictObject({
  ...zAudienceInput.shape,
  expectedVersion: zExpectedVersion,
});
const zValuesQuery = z.object({
  q: z.string().max(MAX_QUERY_LENGTH).default(''),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_VALUES_LIMIT)
    .default(DEFAULT_VALUES_LIMIT),
});
const zIdsQuery = z.object({
  list: z.enum(['include', 'exclude']),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(MAX_PAGE_SIZE),
});
const zResolve = z.strictObject({
  inputs: z
    .array(z.string().max(MAX_RESOLVE_INPUT_LENGTH))
    .max(MAX_RESOLVE_BODY_INPUTS),
});
const zPreview = z.strictObject({
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PREVIEW_LIMIT)
    .default(DEFAULT_PREVIEW_LIMIT),
});
const zExplain = z.strictObject({ id: zIdentifier });

interface Deps {
  sql: Sql;
  redis: Redis;
  resolver: SourceResolver;
  now?: () => number;
  freezeLockTtlMs?: number;
}

// Path and query parameters are not the body, so their failures get their own code.
function validateQuery<T>(schema: z.ZodType<T>, data: unknown): T {
  try {
    return validate(schema, data);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'invalid_body') {
      throw new HttpError(400, 'invalid_query', error.issues);
    }
    throw error;
  }
}

// Upstream source failures as HTTP errors; null for non-HTTP errors, so the caller rethrows them.
// The API reports every protocol failure as source_error.
export function sourceErrorToHttp(error: unknown): HttpError | null {
  const mapped = sourceHttpError(error);
  if (!(mapped instanceof HttpError)) {
    return null;
  }
  return mapped.code === 'source_protocol_error'
    ? new HttpError(502, 'source_error')
    : mapped;
}

function apiError(error: unknown): unknown {
  return sourceErrorToHttp(error) ?? error;
}

export function audienceRoutes(deps: Deps): Route[] {
  const { sql, redis, resolver } = deps;
  const now = deps.now ?? Date.now;
  const lockTtlMs = deps.freezeLockTtlMs ?? FREEZE_LOCK_TTL_MS;
  const store = createAudienceStore({
    sql,
    source: (projectId) => resolver.forProject(projectId),
    now: () => new Date(now()),
  });

  async function missingSourceError(projectId: string) {
    return (await store.hasSourceRow(projectId))
      ? new HttpError(409, 'source_not_http')
      : new HttpError(409, 'source_not_configured');
  }

  async function withSource<T>(
    projectId: string,
    run: (source: AudienceSource) => Promise<T>
  ): Promise<T> {
    const source = await resolver.forProject(projectId);
    if (!source) {
      throw await missingSourceError(projectId);
    }
    try {
      return await run(source);
    } catch (error) {
      throw apiError(error);
    }
  }

  // One freeze per audience at a time: a second would wipe the pages the first is writing.
  async function withFreezeLock<T>(
    audienceId: string,
    run: (assertHeld: () => void) => Promise<T>
  ): Promise<T> {
    const key = `${FREEZE_LOCK_PREFIX}${audienceId}`;
    const token = randomUUID();
    const acquired = await redis.set(key, token, 'PX', lockTtlMs, 'NX');
    if (acquired !== 'OK') {
      throw new HttpError(409, 'freeze_in_progress');
    }
    let lost = false;
    const markLost = () => {
      if (!lost) {
        lost = true;
        console.error('marketing api: audience freeze lock lost');
      }
    };
    const timer = setInterval(() => {
      redis
        .eval(RENEW_LOCK, 1, key, token, lockTtlMs)
        .then((renewed) => {
          if (renewed !== 1) {
            markLost();
          }
        })
        .catch(markLost);
    }, lockTtlMs / RENEW_DIVISOR);
    const assertHeld = () => {
      if (lost) {
        throw new HttpError(409, 'freeze_lock_lost');
      }
    };
    try {
      return await run(assertHeld);
    } finally {
      clearInterval(timer);
      await redis.eval(RELEASE_LOCK, 1, key, token).catch(() => undefined);
    }
  }

  const ctxOf = (ctx: { projectId: string; userId: string }) => ({
    projectId: ctx.projectId,
    userId: ctx.userId,
  });
  const query = (url: URL) => Object.fromEntries(url.searchParams);
  const audiencePath = (suffix: string) =>
    new RegExp(`^/marketing/audiences/([^/]+)${suffix}$`);

  // The body is split so the strict id-change schema still rejects unknown keys.
  async function parseIdChange(req: Request) {
    const raw = await parseJsonBody(req, z.record(z.string(), z.unknown()));
    const { expectedVersion, ...rest } = raw;
    return {
      change: validate(zIdListChange, rest),
      expectedVersion: validate(zExpectedVersion, expectedVersion),
    };
  }

  return [
    {
      method: 'GET',
      pattern: /^\/marketing\/audience\/schema$/,
      auth: 'dashboard',
      async handle(ctx) {
        return json(
          await withSource(ctx.projectId, (source) => source.schema())
        );
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/audience\/dimensions\/([^/]+)\/values$/,
      auth: 'dashboard',
      async handle(ctx) {
        const { q, limit } = validateQuery(zValuesQuery, query(ctx.url));
        const key = validateQuery(zIdentifier, ctx.params[0]);
        const values = await withSource(ctx.projectId, (source) =>
          source.dimensionValues(key, q, limit)
        );
        return json({ values });
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/audience\/resolve$/,
      auth: 'dashboard',
      async handle(ctx) {
        const { inputs } = await parseJsonBody(ctx.req, zResolve);
        return json(
          await withSource(ctx.projectId, async (source) => {
            try {
              return await resolveInputs(source, inputs);
            } catch (error) {
              const mapped = apiError(error);
              if (mapped instanceof HttpError) {
                throw mapped;
              }
              // The original message may echo the contact details that were sent.
              throw new Error('resolve failed');
            }
          })
        );
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/audiences$/,
      auth: 'dashboard',
      async handle(ctx) {
        return json({ audiences: await store.list(ctxOf(ctx)) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/audiences$/,
      auth: 'dashboard',
      async handle(ctx) {
        const body = await parseJsonBody(ctx.req, zAudienceInput);
        return json(await store.create(ctxOf(ctx), body), 201);
      },
    },
    {
      method: 'GET',
      pattern: audiencePath(''),
      auth: 'dashboard',
      async handle(ctx) {
        return json(await store.get(ctxOf(ctx), ctx.params[0] as string));
      },
    },
    {
      method: 'PUT',
      pattern: audiencePath(''),
      auth: 'dashboard',
      async handle(ctx) {
        const { expectedVersion, ...input } = await parseJsonBody(
          ctx.req,
          zUpdate
        );
        return json(
          await store.update(
            ctxOf(ctx),
            ctx.params[0] as string,
            input,
            expectedVersion
          )
        );
      },
    },
    {
      method: 'DELETE',
      pattern: audiencePath(''),
      auth: 'dashboard',
      async handle(ctx) {
        await store.remove(ctxOf(ctx), ctx.params[0] as string);
        return new Response(null, { status: NO_CONTENT });
      },
    },
    {
      method: 'GET',
      pattern: audiencePath('/ids'),
      auth: 'dashboard',
      async handle(ctx) {
        const { list, cursor, limit } = validateQuery(
          zIdsQuery,
          query(ctx.url)
        );
        return json(
          await store.listIds(
            ctxOf(ctx),
            ctx.params[0] as string,
            list,
            cursor ?? null,
            limit
          )
        );
      },
    },
    {
      method: 'POST',
      pattern: audiencePath('/ids'),
      auth: 'dashboard',
      async handle(ctx) {
        const { change, expectedVersion } = await parseIdChange(ctx.req);
        return json(
          await store.changeIds(
            ctxOf(ctx),
            ctx.params[0] as string,
            change,
            expectedVersion
          )
        );
      },
    },
    {
      method: 'POST',
      pattern: audiencePath('/count'),
      auth: 'dashboard',
      async handle(ctx) {
        const definition = await store.definition(
          ctxOf(ctx),
          ctx.params[0] as string
        );
        return json(
          await withSource(ctx.projectId, (source) =>
            countAudience(source, definition, () => new Date(now()))
          )
        );
      },
    },
    {
      method: 'POST',
      pattern: audiencePath('/preview'),
      auth: 'dashboard',
      async handle(ctx) {
        const { cursor, limit } = await parseJsonBody(ctx.req, zPreview);
        const definition = await store.definition(
          ctxOf(ctx),
          ctx.params[0] as string
        );
        return json(
          await withSource(ctx.projectId, (source) =>
            previewAudience(source, definition, cursor, limit)
          )
        );
      },
    },
    {
      method: 'POST',
      pattern: audiencePath('/explain'),
      auth: 'dashboard',
      async handle(ctx) {
        const { id } = await parseJsonBody(ctx.req, zExplain);
        const audienceId = ctx.params[0] as string;
        const definition = await store.definition(ctxOf(ctx), audienceId);
        const membership = await store.listMembership(
          ctxOf(ctx),
          audienceId,
          id
        );
        return json(
          await withSource(ctx.projectId, (source) =>
            explainAudience(
              source,
              {
                filter: definition.filter,
                excludeFilter: definition.excludeFilter,
                ...membership,
              },
              id
            )
          )
        );
      },
    },
    {
      method: 'POST',
      pattern: audiencePath('/freeze'),
      auth: 'dashboard',
      async handle(ctx) {
        const audienceId = ctx.params[0] as string;
        // Scoped lookup first, so another project's audience id never touches its lock.
        await store.get(ctxOf(ctx), audienceId);
        return json(
          await withFreezeLock(audienceId, async (assertHeld) => {
            try {
              return await store.freeze(ctxOf(ctx), audienceId, assertHeld);
            } catch (error) {
              if (
                error instanceof HttpError &&
                error.code === 'source_not_http'
              ) {
                throw await missingSourceError(ctx.projectId);
              }
              throw apiError(error);
            }
          })
        );
      },
    },
  ];
}
