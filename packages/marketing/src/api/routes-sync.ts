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

// Param $1 is the project. Locking the source row makes a sync racing a switch to http wait for
// it and then see kind = 'http', so the switch's purge cannot miss the row.
// shortcut: a project's very first source row has nothing to lock yet; that race window is one statement long.
const SOURCE_IS_STORED = `NOT EXISTS (
  SELECT 1 FROM (SELECT kind FROM marketing.audience_sources WHERE project_id = $1 FOR SHARE) source
  WHERE source.kind = 'http')`;

const IS_HTTP_SOURCE_SQL = `
  SELECT 1 FROM marketing.audience_sources WHERE project_id = $1 AND kind = 'http'`;

// An http project keeps no contact data, so its contacts are never written.
const UPSERT_CONTACT_SQL = `
  INSERT INTO marketing.contacts (project_id, profile_id, email, attributes)
  SELECT $1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb) WHERE ${SOURCE_IS_STORED}
  ON CONFLICT (project_id, profile_id) DO UPDATE SET
    email = COALESCE(EXCLUDED.email, marketing.contacts.email),
    attributes = COALESCE($4::jsonb, marketing.contacts.attributes),
    updated_at = now()`;

// The token is the primary key: re-registering moves it to the new profile, but never into
// another project, or one project's API key could take over another project's devices.
const UPSERT_DEVICE_SQL = `
  INSERT INTO marketing.devices (project_id, token, profile_id, platform)
  SELECT $1, $2, $3, $4 WHERE ${SOURCE_IS_STORED}
  ON CONFLICT (token) DO UPDATE SET
    profile_id = EXCLUDED.profile_id, platform = EXCLUDED.platform, updated_at = now()
  WHERE marketing.devices.project_id = EXCLUDED.project_id`;

const UPSERT_REFERENCE_SET_SQL = `
  INSERT INTO marketing.reference_sets (project_id, set_key, values)
  VALUES ($1, $2, $3::jsonb)
  ON CONFLICT (project_id, set_key) DO UPDATE SET values = EXCLUDED.values`;

const PATH_SEGMENT = '([^/]+)';

async function rejectIfHttpSource(
  sql: Queryable,
  projectId: string
): Promise<void> {
  const rows = await sql.$queryRawUnsafe<unknown[]>(
    IS_HTTP_SOURCE_SQL,
    projectId
  );
  if (rows.length > 0) {
    throw new HttpError(409, 'source_is_http');
  }
}

function identifierParam(ctx: RouteContext): string {
  return validate(zIdentifier, ctx.params[0]);
}

export function referenceSetRoute(sql: Queryable): Route {
  return {
    method: 'PUT',
    pattern: new RegExp(`^/marketing/reference-sets/${PATH_SEGMENT}$`),
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
      pattern: new RegExp(`^/marketing/contacts/${PATH_SEGMENT}$`),
      auth: 'apiKey',
      async handle(ctx) {
        const profileId = identifierParam(ctx);
        const contact = await parseJsonBody(ctx.req, zContact);
        const written = await sql.$executeRawUnsafe(
          UPSERT_CONTACT_SQL,
          ctx.projectId,
          profileId,
          contact.email ?? null,
          contact.attributes ? JSON.stringify(contact.attributes) : null
        );
        if (written === 0) {
          await rejectIfHttpSource(sql, ctx.projectId);
        }
        return json({ ok: true });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/marketing\/devices$/,
      auth: 'apiKey',
      async handle(ctx) {
        const device = await parseJsonBody(ctx.req, zDevice);
        const written = await sql.$executeRawUnsafe(
          UPSERT_DEVICE_SQL,
          ctx.projectId,
          device.token,
          device.profileId,
          device.platform
        );
        if (written === 0) {
          await rejectIfHttpSource(sql, ctx.projectId);
          throw new HttpError(409, 'token_in_use');
        }
        return json({ ok: true });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/marketing\/devices$/,
      auth: 'apiKey',
      async handle(ctx) {
        const { token } = await parseJsonBody(
          ctx.req,
          z.strictObject({ token: zDeviceToken })
        );
        await sql.$executeRawUnsafe(
          'DELETE FROM marketing.devices WHERE token = $1 AND project_id = $2',
          token,
          ctx.projectId
        );
        return json({ ok: true });
      },
    },
    referenceSetRoute(sql),
  ];
}
