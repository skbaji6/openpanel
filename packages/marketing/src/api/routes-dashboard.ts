import { randomBytes, randomUUID } from 'node:crypto';
import {
  decryptCredential,
  encryptCredential,
  hashPassword,
} from '@openpanel/shared/server';
import { z } from 'zod';
import { configSchemaFor } from '../channels/registry';
import { wakeWaitingCampaigns } from '../channels/settings';
import type { MarketingConfig } from '../config';
import {
  lockProfiles,
  lockRules,
  type Queryable,
  type Sql,
} from '../engine/engine';
import { HH_MM } from '../engine/gates';
import {
  MAX_DEFINITION_BYTES,
  MAX_DELAY_SECONDS,
  zInlineTemplate,
  zRuleDefinition,
  zStep,
} from '../rules/rule.schema';
import { STARTER_RULES } from '../rules/starter-rules';
import { renderTemplate } from '../template/render';
import { compileEmailContent, zEmailContent } from '../templates/email-blocks';
import { definitionBytes, pinOrThrow } from '../templates/pin';
import type { createTemplateRegistry } from '../templates/registry';
import { HttpError, json, parseJsonBody, type Route, validate } from './http';
import { zIdentifier } from './routes-sync';

const MASK = '********';
// Fields shown in clear on GET; everything else in a channel config is treated as a secret.
const PUBLIC_CONFIG_FIELDS: Record<string, string[]> = {
  email: ['host', 'port', 'secure', 'user', 'from'],
  webhook: ['url'],
  push: [],
  sms: ['baseUrl', 'defaultCountryCode'],
  whatsapp: ['integratedNumber', 'baseUrl', 'defaultCountryCode'],
};
const MAX_NAME_LENGTH = 200;
const MAX_FILTERS = 50;
const MAX_PROPERTY_NAMES = 100;
const MAX_LABEL_LENGTH = 100;
const MAX_CAP = 10_000;
const MAX_TIMEZONE_LENGTH = 64;
const MAX_SAMPLE_MISSING = 1000;
const API_KEY_SECRET_BYTES = 32;
// Each chunk holds this many profile advisory locks at once; the lock table is shared and finite.
const CANCEL_CHUNK_PROFILES = 1000;
// Stopping a rule first waits for in-flight consumer batches (up to 60 s each), then for profile locks.
const STOP_TRANSACTION = { timeout: 120_000, maxWait: 30_000 };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const zBoundedRule = zRuleDefinition
  .refine((rule) => definitionBytes(rule) <= MAX_DEFINITION_BYTES, {
    message: 'definition is too large',
  })
  .refine(
    (rule) =>
      rule.name.length <= MAX_NAME_LENGTH &&
      (rule.trigger.filters?.length ?? 0) <= MAX_FILTERS &&
      rule.allowedEventProps.length <= MAX_PROPERTY_NAMES &&
      (rule.goal.kind !== 'inactivity' ||
        rule.goal.excludeEvents.length <= MAX_PROPERTY_NAMES),
    {
      message: 'rule exceeds the allowed name length, filters or properties',
    }
  );
const zStatus = z.enum(['draft', 'active', 'paused']);
const zCreateRule = z.strictObject({
  definition: zBoundedRule,
  status: zStatus.default('draft'),
});
const zJourneyField = z.enum(['trigger', 'goal']);
const zUpdateRule = z
  .strictObject({
    definition: zBoundedRule.optional(),
    status: zStatus.optional(),
    confirmed: z.array(zJourneyField).optional(),
  })
  .refine(
    (body) =>
      body.definition !== undefined ||
      body.status !== undefined ||
      body.confirmed !== undefined,
    {
      message: 'definition, status or confirmed is required',
    }
  );

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// The ticker trusts stored settings, so anything it could not evaluate is rejected here.
const zSettings = z.strictObject({
  caps: z
    .strictObject({
      max: z.number().int().min(0).max(MAX_CAP),
      periodSeconds: z.number().int().positive().max(MAX_DELAY_SECONDS),
      scope: z.enum(['channel', 'all']).optional(),
    })
    .nullable(),
  quietHours: z
    .strictObject({
      start: z.string().regex(HH_MM),
      end: z.string().regex(HH_MM),
      timezone: z
        .string()
        .max(MAX_TIMEZONE_LENGTH)
        .refine(isTimeZone, { message: 'unknown timezone' }),
    })
    .nullable(),
});

const zRecord = z.record(z.string(), z.unknown());
const previewOptions = {
  sample: z
    .strictObject({
      profile: zRecord.optional(),
      event: zRecord.optional(),
      missing: z.array(z.string()).max(MAX_SAMPLE_MISSING).optional(),
    })
    .optional(),
  allowedEventProps: z.array(z.string()).max(MAX_PROPERTY_NAMES).optional(),
};
const zPreview = z.union([
  z.strictObject({
    channel: z.literal('email'),
    content: zEmailContent,
    ...previewOptions,
  }),
  z.strictObject({
    channel: zStep.shape.channel,
    template: zInlineTemplate,
    ...previewOptions,
  }),
]);

export const RULE_COLUMNS =
  'id::text, name, status, definition, version, created_at, updated_at, journey_key, unconfirmed';

export interface RuleRow {
  id: string;
  name: string;
  status: string;
  definition: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
  journey_key: string | null;
  unconfirmed: string[];
}

export function toRule(row: RuleRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    version: row.version,
    definition: row.definition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    journeyKey: row.journey_key,
    unconfirmed: row.unconfirmed,
  };
}

const ACTIVE_PROFILES_SQL = `
  SELECT DISTINCT profile_id FROM marketing.enrollments
  WHERE project_id = $1 AND rule_id = $2::uuid AND status = 'active'
  ORDER BY profile_id LIMIT ${CANCEL_CHUNK_PROFILES}`;

const CANCEL_SQL = `
  WITH cancelled AS (
    UPDATE marketing.enrollments SET status = 'cancelled', end_reason = 'rule_stopped'
    WHERE project_id = $1 AND rule_id = $2::uuid AND status = 'active'
      AND profile_id IN (SELECT jsonb_array_elements_text($3::jsonb))
    RETURNING id
  )
  UPDATE marketing.steps SET status = 'cancelled', outcome = '{"reason":"rule_stopped"}'
  WHERE status = 'pending' AND enrollment_id IN (SELECT id FROM cancelled)`;

// One row per rule of the project. Enrollments come from enrollments_rule_idx (project_id, rule_id),
// their steps from the steps primary key; cost is linear in the project's enrollments.
// Only a goal counts as a conversion: a sequence that ran out of steps also ends 'completed'.
const RESULTS_SQL = `
  SELECT r.id::text AS rule_id, r.name, r.definition->'goal'->>'kind' AS goal_kind,
    count(e.id)::int AS enrolled,
    count(e.id) FILTER (WHERE s.sent > 0)::int AS messaged,
    count(e.id) FILTER (WHERE s.sent > 0 AND e.end_reason = 'goal')::int AS completed_after_send,
    COALESCE(sum(s.sent), 0)::int AS sent,
    COALESCE(sum(s.skipped), 0)::int AS skipped,
    COALESCE(sum(s.failed), 0)::int AS failed
  FROM marketing.rules r
  LEFT JOIN marketing.enrollments e ON e.project_id = r.project_id AND e.rule_id = r.id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE status = 'sent') AS sent,
      count(*) FILTER (WHERE status = 'skipped') AS skipped,
      count(*) FILTER (WHERE status = 'failed') AS failed
    FROM marketing.steps WHERE enrollment_id = e.id
  ) s ON true
  WHERE r.project_id = $1 AND ($2::uuid IS NULL OR r.id = $2::uuid)
  GROUP BY r.id, r.name, r.created_at
  ORDER BY r.created_at`;

interface ResultRow {
  rule_id: string;
  name: string;
  goal_kind: string | null;
  enrolled: number;
  messaged: number;
  completed_after_send: number;
  sent: number;
  skipped: number;
  failed: number;
}

export function ruleIdParam(params: string[]): string {
  const id = params[0] ?? '';
  if (!UUID_PATTERN.test(id)) {
    throw new HttpError(404, 'not_found');
  }
  return id;
}

// A channel whose adapter is not registered is a clean 409, not a 500.
function channelConfigSchema(channel: string) {
  try {
    return configSchemaFor(channel);
  } catch {
    throw new HttpError(409, 'channel_unavailable');
  }
}

function publicFields(channel: string): Set<string> {
  return new Set(PUBLIC_CONFIG_FIELDS[channel] ?? []);
}

// Every secret, arrays included, becomes the same string, so neither length nor count leaks.
function maskConfig(channel: string, config: Record<string, unknown>) {
  const visible = publicFields(channel);
  return Object.fromEntries(
    Object.entries(config).map(([field, value]) => [
      field,
      visible.has(field) ? value : MASK,
    ])
  );
}

function containsMask(value: unknown): boolean {
  return value === MASK || (Array.isArray(value) && value.includes(MASK));
}

// Postgres jsonb reorders object keys, so stored and submitted values only compare equal with sorted keys.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

// A secret sent back as the mask keeps its stored value, but only while every public field is unchanged:
// otherwise a caller could point the stored secret at a host of their choosing.
function restoreMaskedSecrets(
  channel: string,
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>
): Record<string, unknown> {
  const visible = publicFields(channel);
  const echoed = Object.keys(incoming).filter(
    (field) =>
      !visible.has(field) && field in stored && incoming[field] === MASK
  );
  // A mask with nothing stored behind it (or inside a list) would otherwise be saved as the secret itself.
  const placeholders = Object.keys(incoming).filter(
    (field) =>
      !(visible.has(field) || echoed.includes(field)) &&
      containsMask(incoming[field])
  );
  if (placeholders.length > 0) {
    throw new HttpError(
      400,
      'secrets_required',
      placeholders.map((field) => ({
        path: `config.${field}`,
        message: 'enter this secret; the mask is only a placeholder',
      }))
    );
  }
  if (echoed.length === 0) {
    return incoming;
  }
  const publicChanged = [...visible].some(
    (field) => !sameValue(incoming[field], stored[field])
  );
  if (publicChanged) {
    throw new HttpError(
      400,
      'secrets_required',
      echoed.map((field) => ({
        path: `config.${field}`,
        message: 're-enter this secret when changing other settings',
      }))
    );
  }
  return {
    ...incoming,
    ...Object.fromEntries(echoed.map((field) => [field, stored[field]])),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface DashboardDeps {
  cfg: MarketingConfig;
  sql: Sql;
  onRulesChanged: () => Promise<void>;
  registry: ReturnType<typeof createTemplateRegistry>;
}

// Trigger and goal stay unconfirmed until an admin confirms them or edits them.
function remainingUnconfirmed(
  current: RuleRow,
  body: z.infer<typeof zUpdateRule>
): string[] {
  const confirmed = new Set<string>(body.confirmed);
  const stored = current.definition as {
    trigger?: { event?: string };
    goal?: unknown;
  };
  if (body.definition) {
    if (body.definition.trigger.event !== stored.trigger?.event) {
      confirmed.add('trigger');
    }
    if (!sameValue(body.definition.goal, stored.goal)) {
      confirmed.add('goal');
    }
  }
  return current.unconfirmed.filter((field) => !confirmed.has(field));
}

export function dashboardRoutes(deps: DashboardDeps): Route[] {
  const { cfg, sql, registry } = deps;

  async function cancelChunk(
    tx: Queryable,
    projectId: string,
    ruleId: string
  ): Promise<number> {
    const rows = await tx.$queryRawUnsafe<{ profile_id: string }[]>(
      ACTIVE_PROFILES_SQL,
      projectId,
      ruleId
    );
    if (rows.length === 0) {
      return 0;
    }
    const profileIds = rows.map((row) => row.profile_id);
    // Same lock order as the engine and ticker, so a concurrent step write cannot resurrect a cancelled step.
    await lockProfiles(
      tx,
      profileIds.map((profileId) => ({ projectId, profileId }))
    );
    await tx.$executeRawUnsafe(
      CANCEL_SQL,
      projectId,
      ruleId,
      JSON.stringify(profileIds)
    );
    return rows.length;
  }

  // Pauses the rule through `change` and cancels its work in one transaction; only a rule with more
  // than CANCEL_CHUNK_PROFILES enrolled profiles continues in further transactions. Once the pause
  // commits no batch enrolls into the rule, so the later chunks need no rule lock.
  async function stopRule<T>(
    projectId: string,
    ruleId: string,
    change: (tx: Queryable) => Promise<T | undefined>
  ): Promise<T | undefined> {
    let more = false;
    const result = await sql.$transaction(async (tx) => {
      await lockRules(tx, 'exclusive');
      const changed = await change(tx);
      if (changed !== undefined) {
        more =
          (await cancelChunk(tx, projectId, ruleId)) === CANCEL_CHUNK_PROFILES;
      }
      return changed;
    }, STOP_TRANSACTION);
    while (more) {
      const cancelled = await sql.$transaction(
        (tx) => cancelChunk(tx, projectId, ruleId),
        STOP_TRANSACTION
      );
      more = cancelled === CANCEL_CHUNK_PROFILES;
    }
    return result;
  }

  async function rulesChanged(): Promise<void> {
    await deps.onRulesChanged();
  }

  async function storedChannelConfig(projectId: string, channel: string) {
    const [row] = await sql.$queryRawUnsafe<{ config_encrypted: string }[]>(
      'SELECT config_encrypted FROM marketing.channel_configs WHERE project_id = $1 AND channel = $2',
      projectId,
      channel
    );
    if (!row) {
      return null;
    }
    // Unreadable (e.g. after an ENCRYPTION_KEY change) counts as not configured, so PUT can replace it.
    try {
      const parsed: unknown = JSON.parse(
        decryptCredential(cfg.encryptionKey, row.config_encrypted)
      );
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return [
    {
      method: 'GET',
      pattern: /^\/marketing\/rules$/,
      auth: 'dashboard',
      async handle(ctx) {
        const rows = await sql.$queryRawUnsafe<RuleRow[]>(
          `SELECT ${RULE_COLUMNS} FROM marketing.rules WHERE project_id = $1 ORDER BY created_at`,
          ctx.projectId
        );
        return json({ rules: rows.map(toRule) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/rules$/,
      auth: 'dashboard',
      async handle(ctx) {
        const body = await parseJsonBody(ctx.req, zCreateRule);
        const stored =
          body.status === 'active'
            ? (await pinOrThrow(registry, ctx.projectId, body.definition))
                .definition
            : body.definition;
        const [row] = await sql.$queryRawUnsafe<RuleRow[]>(
          `INSERT INTO marketing.rules (id, project_id, name, status, definition)
           VALUES ($1::uuid, $2, $3, $4, $5::jsonb) RETURNING ${RULE_COLUMNS}`,
          randomUUID(),
          ctx.projectId,
          body.definition.name,
          body.status,
          JSON.stringify(stored)
        );
        await rulesChanged();
        return json(row ? toRule(row) : null, 201);
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/marketing\/rules\/([^/]+)$/,
      auth: 'dashboard',
      async handle(ctx) {
        const ruleId = ruleIdParam(ctx.params);
        const body = await parseJsonBody(ctx.req, zUpdateRule);
        // The row lock serializes this with /start and other edits, so a stored active definition is always pinned.
        const update = async (tx: Queryable) => {
          const [current] = await tx.$queryRawUnsafe<RuleRow[]>(
            `SELECT ${RULE_COLUMNS} FROM marketing.rules
             WHERE id = $1::uuid AND project_id = $2 FOR UPDATE`,
            ruleId,
            ctx.projectId
          );
          if (!current) {
            return undefined;
          }
          if (current.status === 'draft' && body.status === 'active') {
            throw new HttpError(409, 'use_start');
          }
          const nextStatus = body.status ?? current.status;
          const unconfirmed = remainingUnconfirmed(current, body);
          if (
            nextStatus === 'active' &&
            current.status !== 'active' &&
            unconfirmed.length > 0
          ) {
            throw new HttpError(409, 'journey_unconfirmed', undefined, {
              fields: unconfirmed,
            });
          }
          let definition = body.definition ?? null;
          if (
            nextStatus === 'active' &&
            (body.definition || current.status !== 'active')
          ) {
            definition = (
              await pinOrThrow(
                registry,
                ctx.projectId,
                body.definition ?? zRuleDefinition.parse(current.definition)
              )
            ).definition;
          }
          const [row] = await tx.$queryRawUnsafe<RuleRow[]>(
            `UPDATE marketing.rules SET
               definition = COALESCE($3::jsonb, definition),
               name = COALESCE($4, name),
               version = version + CASE WHEN $3::jsonb IS NULL THEN 0 ELSE 1 END,
               status = COALESCE($5, status),
               unconfirmed = $6::text[],
               updated_at = now()
             WHERE id = $1::uuid AND project_id = $2
             RETURNING ${RULE_COLUMNS}`,
            ruleId,
            ctx.projectId,
            definition ? JSON.stringify(definition) : null,
            body.definition?.name ?? null,
            body.status ?? null,
            unconfirmed
          );
          return row;
        };
        const row =
          body.status === 'paused'
            ? await stopRule(ctx.projectId, ruleId, update)
            : await sql.$transaction(update);
        if (!row) {
          throw new HttpError(404, 'not_found');
        }
        await rulesChanged();
        return json(toRule(row));
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/marketing\/rules\/([^/]+)$/,
      auth: 'dashboard',
      async handle(ctx) {
        const ruleId = ruleIdParam(ctx.params);
        // The row goes last, so a delete that fails while cancelling can simply be retried.
        const paused = await stopRule(ctx.projectId, ruleId, (tx) =>
          tx
            .$queryRawUnsafe<{ id: string }[]>(
              `UPDATE marketing.rules SET status = 'paused', updated_at = now()
               WHERE id = $1::uuid AND project_id = $2 RETURNING id::text`,
              ruleId,
              ctx.projectId
            )
            .then(([row]) => row)
        );
        if (!paused) {
          throw new HttpError(404, 'not_found');
        }
        // A rule reactivated while its work was being cancelled has live enrollments again; keep it.
        const deleted = await sql.$executeRawUnsafe(
          `DELETE FROM marketing.rules WHERE id = $1::uuid AND project_id = $2 AND status = 'paused'`,
          ruleId,
          ctx.projectId
        );
        if (deleted === 0) {
          throw new HttpError(409, 'rule_reactivated');
        }
        await rulesChanged();
        return json({ ok: true });
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/starter-rules$/,
      auth: 'dashboard',
      handle() {
        return json({
          starterRules: Object.entries(STARTER_RULES).map(
            ([key, definition]) => ({
              key,
              definition,
            })
          ),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/channels\/(email|webhook|push|sms|whatsapp)$/,
      auth: 'dashboard',
      async handle(ctx) {
        const channel = ctx.params[0] ?? '';
        const stored = await storedChannelConfig(ctx.projectId, channel);
        return json({
          channel,
          configured: stored !== null,
          config: stored ? maskConfig(channel, stored) : null,
        });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/marketing\/channels\/(email|webhook|push|sms|whatsapp)$/,
      auth: 'dashboard',
      async handle(ctx) {
        const channel = ctx.params[0] ?? '';
        const { config } = await parseJsonBody(
          ctx.req,
          z.strictObject({ config: zRecord })
        );
        const stored =
          (await storedChannelConfig(ctx.projectId, channel)) ?? {};
        const parsed = channelConfigSchema(channel).safeParse(
          restoreMaskedSecrets(channel, config, stored)
        );
        if (!(parsed.success && isRecord(parsed.data))) {
          throw new HttpError(
            400,
            'invalid_body',
            parsed.error?.issues.map((issue) => ({
              path: ['config', ...issue.path.map(String)].join('.'),
              message: issue.message,
            }))
          );
        }
        await sql.$executeRawUnsafe(
          `INSERT INTO marketing.channel_configs (project_id, channel, config_encrypted)
           VALUES ($1, $2, $3)
           ON CONFLICT (project_id, channel) DO UPDATE SET config_encrypted = EXCLUDED.config_encrypted`,
          ctx.projectId,
          channel,
          encryptCredential(cfg.encryptionKey, JSON.stringify(parsed.data))
        );
        await wakeWaitingCampaigns(sql, ctx.projectId, channel);
        return json({
          channel,
          configured: true,
          config: maskConfig(channel, parsed.data),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/settings$/,
      auth: 'dashboard',
      async handle(ctx) {
        const [row] = await sql.$queryRawUnsafe<
          { caps: unknown; quiet_hours: unknown }[]
        >(
          'SELECT caps, quiet_hours FROM marketing.project_settings WHERE project_id = $1',
          ctx.projectId
        );
        return json({
          caps: row?.caps ?? null,
          quietHours: row?.quiet_hours ?? null,
        });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/marketing\/settings$/,
      auth: 'dashboard',
      async handle(ctx) {
        const settings = await parseJsonBody(ctx.req, zSettings);
        await sql.$executeRawUnsafe(
          `INSERT INTO marketing.project_settings (project_id, caps, quiet_hours)
           VALUES ($1, $2::jsonb, $3::jsonb)
           ON CONFLICT (project_id) DO UPDATE SET caps = EXCLUDED.caps, quiet_hours = EXCLUDED.quiet_hours`,
          ctx.projectId,
          settings.caps ? JSON.stringify(settings.caps) : null,
          settings.quietHours ? JSON.stringify(settings.quietHours) : null
        );
        return json(settings);
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/results$/,
      auth: 'dashboard',
      async handle(ctx) {
        const ruleIdFilter = ctx.url.searchParams.get('ruleId');
        const ruleId =
          ruleIdFilter === null ? null : ruleIdParam([ruleIdFilter]);
        const rows = await sql.$queryRawUnsafe<ResultRow[]>(
          RESULTS_SQL,
          ctx.projectId,
          ruleId
        );
        if (ruleId && rows.length === 0) {
          throw new HttpError(404, 'not_found');
        }
        return json({
          results: rows.map((row) => ({
            ruleId: row.rule_id,
            name: row.name,
            goalKind: row.goal_kind,
            enrolled: row.enrolled,
            messaged: row.messaged,
            sent: row.sent,
            completedAfterSend: row.completed_after_send,
            // Share of messaged enrollments that later reached the goal.
            conversionRate:
              row.messaged === 0 ? 0 : row.completed_after_send / row.messaged,
            skipped: row.skipped,
            failed: row.failed,
          })),
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/api-keys$/,
      auth: 'dashboard',
      async handle(ctx) {
        const { label } = await parseJsonBody(
          ctx.req,
          z.strictObject({ label: z.string().min(1).max(MAX_LABEL_LENGTH) })
        );
        const id = randomUUID();
        const secret = randomBytes(API_KEY_SECRET_BYTES).toString('base64url');
        await sql.$executeRawUnsafe(
          'INSERT INTO marketing.api_keys (id, project_id, key_hash, label) VALUES ($1::uuid, $2, $3, $4)',
          id,
          ctx.projectId,
          await hashPassword(secret),
          label
        );
        return json({ id, label, key: `${id}.${secret}` }, 201);
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/preview$/,
      auth: 'dashboard',
      async handle(ctx) {
        const body = await parseJsonBody(ctx.req, zPreview);
        const vars = {
          profile: body.sample?.profile ?? {},
          event: body.sample?.event ?? {},
          missing: body.sample?.missing ?? [],
          allowedEventProps: body.allowedEventProps ?? [],
        };
        if ('content' in body) {
          const email = compileEmailContent(body.content);
          return json({
            subject: renderTemplate(email.subject, vars, { mode: 'text' }),
            body: renderTemplate(email.body, vars, { mode: 'html' }),
            text: renderTemplate(email.text, vars, { mode: 'text' }),
          });
        }
        const { subject } = body.template;
        return json({
          subject:
            subject === undefined
              ? undefined
              : renderTemplate(subject, vars, { mode: 'text' }),
          body: renderTemplate(body.template.body, vars, {
            mode: body.channel === 'email' ? 'html' : 'text',
          }),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/reference-sets$/,
      auth: 'dashboard',
      async handle(ctx) {
        const rows = await sql.$queryRawUnsafe<
          { set_key: string; count: number }[]
        >(
          `SELECT set_key, jsonb_array_length(values)::int AS count
           FROM marketing.reference_sets WHERE project_id = $1 ORDER BY set_key`,
          ctx.projectId
        );
        return json({
          referenceSets: rows.map((row) => ({
            setKey: row.set_key,
            count: row.count,
          })),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/reference-sets\/([^/]+)$/,
      auth: 'dashboard',
      async handle(ctx) {
        const setKey = validate(zIdentifier, ctx.params[0]);
        const [row] = await sql.$queryRawUnsafe<{ values: unknown }[]>(
          'SELECT values FROM marketing.reference_sets WHERE project_id = $1 AND set_key = $2',
          ctx.projectId,
          setKey
        );
        if (!row) {
          throw new HttpError(404, 'not_found');
        }
        return json({ setKey, values: row.values });
      },
    },
  ];
}
