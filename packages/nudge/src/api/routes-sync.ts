import { z } from 'zod';
import type { Queryable } from '../engine/engine';
import {
  HttpError,
  json,
  parseJsonBody,
  type Route,
  type RouteContext,
  validate,
} from './http';

const MAX_ID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;
const MAX_ATTRIBUTES = 200;
const MAX_ATTRIBUTE_KEY_LENGTH = 128;
const MAX_TOKEN_LENGTH = 4096;
const MAX_REFERENCE_VALUES = 100_000;
const MAX_REFERENCE_VALUE_LENGTH = 512;
// Path segments arrive URL-decoded; control characters have no business in an id.
const CONTROL_CHARACTERS = /\p{Cc}/u;

export const zIdentifier = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: 'must not contain control characters',
  });

const zContact = z.strictObject({
  email: z.email().max(MAX_EMAIL_LENGTH).optional(),
  attributes: z
    .record(z.string().max(MAX_ATTRIBUTE_KEY_LENGTH), z.unknown())
    .refine((attributes) => Object.keys(attributes).length <= MAX_ATTRIBUTES, {
      message: `at most ${MAX_ATTRIBUTES} attributes`,
    })
    .optional(),
});

const zDeviceToken = z.string().min(1).max(MAX_TOKEN_LENGTH);
const zDevice = z.strictObject({
  profileId: zIdentifier,
  token: zDeviceToken,
  platform: z.enum(['android', 'ios']),
});

const zReferenceSet = z.strictObject({
  values: z
    .array(z.string().min(1).max(MAX_REFERENCE_VALUE_LENGTH))
    .max(MAX_REFERENCE_VALUES),
});

const UPSERT_CONTACT_SQL = `
  INSERT INTO nudge.contacts (project_id, profile_id, email, attributes)
  VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
  ON CONFLICT (project_id, profile_id) DO UPDATE SET
    email = COALESCE(EXCLUDED.email, nudge.contacts.email),
    attributes = COALESCE($4::jsonb, nudge.contacts.attributes),
    updated_at = now()`;

// The token is the primary key: re-registering moves it to the new profile, but never into
// another project, or one project's API key could take over another project's devices.
const UPSERT_DEVICE_SQL = `
  INSERT INTO nudge.devices (token, project_id, profile_id, platform)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (token) DO UPDATE SET
    profile_id = EXCLUDED.profile_id, platform = EXCLUDED.platform, updated_at = now()
  WHERE nudge.devices.project_id = EXCLUDED.project_id`;

const UPSERT_REFERENCE_SET_SQL = `
  INSERT INTO nudge.reference_sets (project_id, set_key, values)
  VALUES ($1, $2, $3::jsonb)
  ON CONFLICT (project_id, set_key) DO UPDATE SET values = EXCLUDED.values`;

const PATH_SEGMENT = '([^/]+)';

function identifierParam(ctx: RouteContext): string {
  return validate(zIdentifier, ctx.params[0]);
}

export function referenceSetRoute(sql: Queryable): Route {
  return {
    method: 'PUT',
    pattern: new RegExp(`^/nudge/reference-sets/${PATH_SEGMENT}$`),
    auth: 'apiKeyOrDashboard',
    async handle(ctx) {
      const setKey = identifierParam(ctx);
      const { values } = await parseJsonBody(ctx.req, zReferenceSet);
      const unique = [...new Set(values)];
      await sql.$executeRawUnsafe(
        UPSERT_REFERENCE_SET_SQL,
        ctx.projectId,
        setKey,
        JSON.stringify(unique)
      );
      return json({ setKey, count: unique.length });
    },
  };
}

export function syncRoutes(sql: Queryable): Route[] {
  return [
    {
      method: 'PUT',
      pattern: new RegExp(`^/nudge/contacts/${PATH_SEGMENT}$`),
      auth: 'apiKey',
      async handle(ctx) {
        const profileId = identifierParam(ctx);
        const contact = await parseJsonBody(ctx.req, zContact);
        await sql.$executeRawUnsafe(
          UPSERT_CONTACT_SQL,
          ctx.projectId,
          profileId,
          contact.email ?? null,
          contact.attributes ? JSON.stringify(contact.attributes) : null
        );
        return json({ ok: true });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/nudge\/devices$/,
      auth: 'apiKey',
      async handle(ctx) {
        const device = await parseJsonBody(ctx.req, zDevice);
        const written = await sql.$executeRawUnsafe(
          UPSERT_DEVICE_SQL,
          device.token,
          ctx.projectId,
          device.profileId,
          device.platform
        );
        if (written === 0) {
          throw new HttpError(409, 'token_in_use');
        }
        return json({ ok: true });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/nudge\/devices$/,
      auth: 'apiKey',
      async handle(ctx) {
        const { token } = await parseJsonBody(
          ctx.req,
          z.strictObject({ token: zDeviceToken })
        );
        await sql.$executeRawUnsafe(
          'DELETE FROM nudge.devices WHERE token = $1 AND project_id = $2',
          token,
          ctx.projectId
        );
        return json({ ok: true });
      },
    },
    referenceSetRoute(sql),
  ];
}
