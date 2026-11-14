import { z } from 'zod';
import { zCampaignDraft, zCampaignPatch } from '../campaign/definition';
import {
  estimateCampaign,
  listRecipients,
  listTestSends,
  retryUncertain,
  skipReasons,
  zRecipientQuery,
} from '../campaign/operator';
import type { CampaignRow, createCampaignService } from '../campaign/service';
import type { Sql } from '../engine/engine';
import {
  HttpError,
  json,
  parseJsonBody,
  type Route,
  readBodyText,
  validate,
} from './http';
import { sourceErrorToHttp, validateQuery } from './routes-audiences';
import { zIdentifier } from './routes-sync';

const CREATED = 201;
const NO_CONTENT = 204;
// Postgres text and jsonb cannot store NUL.
const ESCAPED_NUL = '\\u0000';

type CampaignService = ReturnType<typeof createCampaignService>;

const zConfirm = z.strictObject({
  count: z.number().int().min(0),
  channel: zCampaignPatch.shape.channel.unwrap(),
  spreadOverDays: z.boolean().optional(),
});
const zGateBody = z.strictObject({ confirm: zConfirm.optional() });
const zNoBody = z.strictObject({});
const zUpdate = z.strictObject({
  ...zCampaignPatch.shape,
  expectedVersion: z.number().int().min(1),
});
const zTestSend = z.strictObject({ profileId: zIdentifier });

type HiddenFields =
  | 'materializeLeaseToken'
  | 'materializeLeaseUntil'
  | 'materializeCursor'
  | 'materializeRetryAt';

// Worker bookkeeping (lease, cursor, retry time) is internal; a client must not see or rely on it.
function toResponse(row: CampaignRow): Omit<CampaignRow, HiddenFields> {
  const {
    materializeLeaseToken: _leaseToken,
    materializeLeaseUntil: _leaseUntil,
    materializeCursor: _cursor,
    materializeRetryAt: _retryAt,
    ...visible
  } = row;
  return visible;
}

// An action body may be absent, but never carry fields the action ignores.
async function parseOptionalBody<T>(
  req: Request,
  schema: z.ZodType<T>
): Promise<T> {
  const text = await readBodyText(req);
  if (text.trim() === '') {
    return validate(schema, {});
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (text.includes(ESCAPED_NUL)) {
    throw new HttpError(400, 'invalid_body');
  }
  return validate(schema, data);
}

export function campaignRoutes(
  campaigns: CampaignService,
  operator: {
    sql: Sql;
    now: () => Date;
    channelReady?: (
      projectId: string,
      channel: string,
      template: unknown
    ) => Promise<string | null>;
  }
): Route[] {
  const ctxOf = (ctx: { projectId: string; userId: string }) => ({
    projectId: ctx.projectId,
    userId: ctx.userId,
  });
  const campaignPath = (suffix: string) =>
    new RegExp(`^/marketing/campaigns/([^/]+)${suffix}$`);

  // Campaign operations can fail on the audience source; those map like the audience API's.
  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw sourceErrorToHttp(error) ?? error;
    }
  }

  const rowAction = (
    suffix: string,
    run: (
      ctx: { projectId: string; userId: string },
      id: string,
      req: Request
    ) => Promise<CampaignRow>
  ): Route => ({
    method: 'POST',
    pattern: campaignPath(suffix),
    auth: 'dashboard',
    async handle(ctx) {
      const row = await guarded(() =>
        run(ctxOf(ctx), ctx.params[0] as string, ctx.req)
      );
      return json(toResponse(row));
    },
  });
  const plainAction = (
    suffix: string,
    run: (
      ctx: { projectId: string; userId: string },
      id: string
    ) => Promise<CampaignRow>
  ) =>
    rowAction(suffix, async (ctx, id, req) => {
      await parseOptionalBody(req, zNoBody);
      return await run(ctx, id);
    });
  const gatedAction = (
    suffix: string,
    run: (
      ctx: { projectId: string; userId: string },
      id: string,
      body: z.infer<typeof zGateBody>
    ) => Promise<CampaignRow>
  ) =>
    rowAction(suffix, async (ctx, id, req) =>
      run(ctx, id, await parseOptionalBody(req, zGateBody))
    );

  return [
    {
      method: 'GET',
      pattern: /^\/marketing\/campaigns$/,
      auth: 'dashboard',
      async handle(ctx) {
        const rows = await campaigns.list(ctxOf(ctx));
        return json({ campaigns: rows.map(toResponse) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/campaigns$/,
      auth: 'dashboard',
      async handle(ctx) {
        const draft = await parseJsonBody(ctx.req, zCampaignDraft);
        const row = await guarded(() => campaigns.create(ctxOf(ctx), draft));
        return json(toResponse(row), CREATED);
      },
    },
    {
      method: 'GET',
      pattern: campaignPath(''),
      auth: 'dashboard',
      async handle(ctx) {
        const row = await campaigns.get(ctxOf(ctx), ctx.params[0] as string);
        return json(toResponse(row));
      },
    },
    {
      method: 'PATCH',
      pattern: campaignPath(''),
      auth: 'dashboard',
      async handle(ctx) {
        const { expectedVersion, ...patch } = await parseJsonBody(
          ctx.req,
          zUpdate
        );
        const row = await guarded(() =>
          campaigns.update(
            ctxOf(ctx),
            ctx.params[0] as string,
            patch,
            expectedVersion
          )
        );
        return json(toResponse(row));
      },
    },
    {
      method: 'DELETE',
      pattern: campaignPath(''),
      auth: 'dashboard',
      async handle(ctx) {
        await campaigns.remove(ctxOf(ctx), ctx.params[0] as string);
        return new Response(null, { status: NO_CONTENT });
      },
    },
    {
      method: 'POST',
      pattern: campaignPath('/count-preview'),
      auth: 'dashboard',
      async handle(ctx) {
        await parseOptionalBody(ctx.req, zNoBody);
        return json(
          await guarded(() =>
            campaigns.countPreview(ctxOf(ctx), ctx.params[0] as string)
          )
        );
      },
    },
    gatedAction('/start', (ctx, id, body) => campaigns.start(ctx, id, body)),
    gatedAction('/schedule', (ctx, id, body) =>
      campaigns.schedule(ctx, id, body)
    ),
    plainAction('/unschedule', (ctx, id) => campaigns.unschedule(ctx, id)),
    plainAction('/pause', (ctx, id) => campaigns.pause(ctx, id)),
    plainAction('/resume', (ctx, id) => campaigns.resume(ctx, id)),
    plainAction('/cancel', (ctx, id) => campaigns.cancel(ctx, id)),
    {
      method: 'POST',
      pattern: campaignPath('/retry-uncertain'),
      auth: 'dashboard',
      async handle(ctx) {
        await parseOptionalBody(ctx.req, zNoBody);
        const id = ctx.params[0] as string;
        const { retried } = await retryUncertain(operator.sql, ctx, id);
        const row = await campaigns.get(ctxOf(ctx), id);
        return json({ retried, campaign: toResponse(row) });
      },
    },
    {
      method: 'GET',
      pattern: campaignPath('/recipients'),
      auth: 'dashboard',
      async handle(ctx) {
        const query = validateQuery(
          zRecipientQuery,
          Object.fromEntries(ctx.url.searchParams)
        );
        return json(
          await listRecipients(
            operator.sql,
            ctx,
            ctx.params[0] as string,
            query
          )
        );
      },
    },
    {
      method: 'GET',
      pattern: campaignPath('/skip-reasons'),
      auth: 'dashboard',
      async handle(ctx) {
        return json(
          await skipReasons(operator.sql, ctx, ctx.params[0] as string)
        );
      },
    },
    {
      method: 'GET',
      pattern: campaignPath('/test-sends'),
      auth: 'dashboard',
      async handle(ctx) {
        return json(
          await listTestSends(operator.sql, ctx, ctx.params[0] as string)
        );
      },
    },
    {
      method: 'POST',
      pattern: campaignPath('/estimate'),
      auth: 'dashboard',
      async handle(ctx) {
        await parseOptionalBody(ctx.req, zNoBody);
        return json(
          await estimateCampaign(
            { ...operator, campaigns },
            ctxOf(ctx),
            ctx.params[0] as string
          )
        );
      },
    },
    {
      method: 'POST',
      pattern: campaignPath('/test-send'),
      auth: 'dashboard',
      async handle(ctx) {
        const { profileId } = await parseJsonBody(ctx.req, zTestSend);
        return json(
          await campaigns.requestTestSend(
            ctxOf(ctx),
            ctx.params[0] as string,
            profileId
          )
        );
      },
    },
  ];
}
