import { z } from 'zod';
import { renderProviderVariables } from '../templates/provider-render';
import type { createTemplateRegistry } from '../templates/registry';
import { HttpError, json, parseJsonBody, type Route } from './http';
import { validateQuery } from './routes-audiences';

const CREATED = 201;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const NUMBERED_PLACEHOLDER = /\{\{(\d+)\}\}/g;

type TemplateRegistry = ReturnType<typeof createTemplateRegistry>;

const zListQuery = z.strictObject({
  channel: z.enum(['sms', 'whatsapp']).optional(),
});
// The registry validates the template fields strictly; only expectedVersion is the route's.
const zUpdate = z.looseObject({ expectedVersion: z.number().int().min(1) });
const zPreview = z.strictObject({
  version: z.number().int().min(1).optional(),
  sample: z.strictObject({
    profile: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()])
    ),
  }),
});

const templatePath = (suffix: string) =>
  new RegExp(`^/marketing/templates/([^/]+)${suffix}$`);

export function templateRoutes(registry: TemplateRegistry): Route[] {
  const ctxOf = (ctx: { projectId: string; userId: string }) => ({
    projectId: ctx.projectId,
    userId: ctx.userId,
  });
  const enabledAction = (suffix: string, enabled: boolean): Route => ({
    method: 'POST',
    pattern: templatePath(suffix),
    auth: 'dashboard',
    async handle(ctx) {
      return json(
        await registry.setEnabled(ctxOf(ctx), ctx.params[0] as string, enabled)
      );
    },
  });

  return [
    {
      method: 'GET',
      pattern: /^\/marketing\/templates$/,
      auth: 'dashboard',
      async handle(ctx) {
        const { channel } = validateQuery(
          zListQuery,
          Object.fromEntries(ctx.url.searchParams)
        );
        return json({ templates: await registry.list(ctx.projectId, channel) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/templates$/,
      auth: 'dashboard',
      async handle(ctx) {
        const input = await parseJsonBody(ctx.req, z.unknown());
        return json(await registry.create(ctxOf(ctx), input), CREATED);
      },
    },
    {
      method: 'GET',
      pattern: templatePath(''),
      auth: 'dashboard',
      async handle(ctx) {
        return json(await registry.get(ctx.projectId, ctx.params[0] as string));
      },
    },
    {
      method: 'GET',
      pattern: templatePath('/versions/([^/]+)'),
      auth: 'dashboard',
      async handle(ctx) {
        const version = ctx.params[1] as string;
        if (!POSITIVE_INTEGER.test(version)) {
          throw new HttpError(404, 'not_found');
        }
        return json(
          await registry.getVersion(
            ctx.projectId,
            ctx.params[0] as string,
            Number(version)
          )
        );
      },
    },
    {
      method: 'PUT',
      pattern: templatePath(''),
      auth: 'dashboard',
      async handle(ctx) {
        const { expectedVersion, ...input } = await parseJsonBody(
          ctx.req,
          zUpdate
        );
        return json(
          await registry.update(
            ctxOf(ctx),
            ctx.params[0] as string,
            input,
            expectedVersion
          )
        );
      },
    },
    enabledAction('/enable', true),
    enabledAction('/disable', false),
    {
      method: 'POST',
      pattern: templatePath('/preview'),
      auth: 'dashboard',
      async handle(ctx) {
        const id = ctx.params[0] as string;
        const body = await parseJsonBody(ctx.req, zPreview);
        const template = await registry.get(ctx.projectId, id);
        const version = body.version
          ? await registry.getVersion(ctx.projectId, id, body.version)
          : template;
        const rendered = renderProviderVariables(version, body.sample.profile);
        if (!rendered.ok) {
          return json(rendered);
        }
        const values = new Map(
          rendered.variables.map((variable) => [variable.slot, variable.value])
        );
        // An sms flow's text has its own placeholders, which the provider fills.
        const text =
          template.channel === 'whatsapp'
            ? version.approvedText.replace(
                NUMBERED_PLACEHOLDER,
                (placeholder, n: string) =>
                  values.get(`body_${n}`) ?? placeholder
              )
            : version.approvedText;
        return json({ ok: true, variables: rendered.variables, text });
      },
    },
  ];
}
