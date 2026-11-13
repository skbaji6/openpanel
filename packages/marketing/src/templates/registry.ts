import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, validate } from '../api/http';
import type { Queryable, Sql } from '../engine/engine';

const MAX_VARIABLES = 20;
const MAX_VALUE_LENGTH = 500;
const MAX_APPROVED_TEXT_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 200;

const SMS_SLOT = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const WHATSAPP_SLOT = /^(header|body|button)_[1-9][0-9]?$/;
const BODY_SLOT = /^body_([1-9][0-9]?)$/;
const NUMBERED_PLACEHOLDER = /\{\{(\d+)\}\}/g;
const CANONICAL_NUMBER = /^[1-9][0-9]?$/;
const MAX_INT32 = 2_147_483_647;
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PROFILE_PLACEHOLDER = /^profile\.[A-Za-z0-9_]+$/;

export const zSmsProviderRef = z.strictObject({
  flowId: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
  senderId: z
    .string()
    .regex(/^[A-Z]{6}$/)
    .optional(),
});

export const zWhatsAppProviderRef = z.strictObject({
  templateName: z.string().regex(/^[a-z0-9_]{1,512}$/),
  namespace: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  integratedNumber: z
    .string()
    .regex(/^[0-9]{8,15}$/)
    .optional(),
});

// Only profile traits may be mapped: event data is attacker-controlled and the provider payload is not escaped.
const onlyProfilePlaceholders = (value: string) =>
  [...value.matchAll(ANY_PLACEHOLDER)].every((match) =>
    PROFILE_PLACEHOLDER.test((match[1] ?? '').trim())
  );

export const zTemplateVariable = z.strictObject({
  slot: z.string(),
  value: z
    .string()
    .max(MAX_VALUE_LENGTH)
    .refine(onlyProfilePlaceholders, 'only {{profile.<trait>}} placeholders'),
});

export const zTemplateInput = z
  .strictObject({
    channel: z.enum(['sms', 'whatsapp']),
    displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
    category: z.enum(['promotional', 'service']),
    providerRef: z.union([zSmsProviderRef, zWhatsAppProviderRef]),
    approvedText: z.string().min(1).max(MAX_APPROVED_TEXT_LENGTH),
    variables: z.array(zTemplateVariable).max(MAX_VARIABLES),
  })
  .superRefine((input, ctx) => {
    const providerRef = (
      input.channel === 'sms' ? zSmsProviderRef : zWhatsAppProviderRef
    ).safeParse(input.providerRef);
    if (!providerRef.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerRef'],
        message: `not a valid ${input.channel} provider reference`,
      });
    }
    const slotPattern = input.channel === 'sms' ? SMS_SLOT : WHATSAPP_SLOT;
    const seen = new Set<string>();
    for (const [index, variable] of input.variables.entries()) {
      const path = ['variables', index, 'slot'];
      if (!slotPattern.test(variable.slot)) {
        ctx.addIssue({ code: 'custom', path, message: 'invalid slot' });
      } else if (seen.has(variable.slot)) {
        ctx.addIssue({ code: 'custom', path, message: 'duplicate slot' });
      }
      seen.add(variable.slot);
    }
  });
export type TemplateInput = z.infer<typeof zTemplateInput>;
export type TemplateChannel = TemplateInput['channel'];

export interface TemplateVersion {
  templateId: string;
  version: number;
  displayName: string;
  category: 'promotional' | 'service';
  providerRef: unknown;
  approvedText: string;
  variables: { slot: string; value: string }[];
  createdBy: string;
  createdAt: string;
}

export interface TemplateRow extends TemplateVersion {
  projectId: string;
  channel: TemplateChannel;
  enabled: boolean;
  currentVersion: number;
  updatedAt: string;
}

export type Readiness =
  | { ok: true; version: TemplateVersion; channel: TemplateChannel }
  | {
      ok: false;
      code:
        | 'template_not_found'
        | 'template_disabled'
        | 'template_mapping_missing';
    };

interface StoreContext {
  projectId: string;
  userId: string;
}

interface DbRow {
  template_id: string;
  project_id: string;
  channel: TemplateChannel;
  enabled: boolean;
  current_version: number;
  updated_at: Date;
  version: number;
  display_name: string;
  category: 'promotional' | 'service';
  provider_ref: unknown;
  approved_text: string;
  variables: { slot: string; value: string }[];
  created_by: string;
  created_at: Date;
}

const SELECT_ROWS = `
  SELECT t.id AS template_id, t.project_id, t.channel, t.enabled, t.current_version, t.updated_at,
         v.version, v.display_name, v.category, v.provider_ref, v.approved_text, v.variables, v.created_by, v.created_at
  FROM marketing.message_templates t
  JOIN marketing.message_template_versions v ON v.template_id = t.id`;
const CURRENT_VERSION_ONLY = 'v.version = t.current_version';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

const toVersion = (row: DbRow): TemplateVersion => ({
  templateId: row.template_id,
  version: row.version,
  displayName: row.display_name,
  category: row.category,
  providerRef: row.provider_ref,
  approvedText: row.approved_text,
  variables: row.variables,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

const toRow = (row: DbRow): TemplateRow => ({
  ...toVersion(row),
  projectId: row.project_id,
  channel: row.channel,
  enabled: row.enabled,
  currentVersion: row.current_version,
  updatedAt: row.updated_at.toISOString(),
});

// Every {{n}} of the approved body needs a body_n slot and the other way round; header and button slots are not in the text.
function whatsAppMappingMatches(
  approvedText: string,
  variables: { slot: string }[]
): boolean {
  const numbers = [...approvedText.matchAll(NUMBERED_PLACEHOLDER)].map(
    (m) => m[1] ?? ''
  );
  // {{01}} looks numbered but is not a placeholder Meta fills, so it is rejected rather than ignored.
  if (!numbers.every((n) => CANONICAL_NUMBER.test(n))) {
    return false;
  }
  const placeholders = new Set(numbers.map(Number));
  const bodySlots = new Set(
    variables.flatMap((v) => {
      const n = BODY_SLOT.exec(v.slot)?.[1];
      return n ? [Number(n)] : [];
    })
  );
  return (
    placeholders.size === bodySlots.size &&
    [...placeholders].every((n) => bodySlots.has(n))
  );
}

export function createTemplateRegistry(deps: { sql: Sql; now: () => Date }) {
  const { sql } = deps;

  function parseInput(input: unknown): TemplateInput {
    const parsed = validate(zTemplateInput, input);
    if (
      parsed.channel === 'whatsapp' &&
      !whatsAppMappingMatches(parsed.approvedText, parsed.variables)
    ) {
      throw new HttpError(400, 'mapping_mismatch');
    }
    return parsed;
  }

  async function insertVersion(
    tx: Queryable,
    id: string,
    version: number,
    input: TemplateInput,
    userId: string
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO marketing.message_template_versions
         (template_id, version, display_name, category, provider_ref, approved_text, variables, created_by, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)`,
      id,
      version,
      input.displayName,
      input.category,
      JSON.stringify(input.providerRef),
      input.approvedText,
      JSON.stringify(input.variables),
      userId,
      deps.now()
    );
  }

  async function get(projectId: string, id: string): Promise<TemplateRow> {
    if (!isUuid(id)) {
      throw new HttpError(404, 'not_found');
    }
    const [row] = await sql.$queryRawUnsafe<DbRow[]>(
      `${SELECT_ROWS} WHERE t.id = $1::uuid AND t.project_id = $2 AND ${CURRENT_VERSION_ONLY}`,
      id,
      projectId
    );
    if (!row) {
      throw new HttpError(404, 'not_found');
    }
    return toRow(row);
  }

  return {
    get,

    async list(
      projectId: string,
      channel?: TemplateChannel
    ): Promise<TemplateRow[]> {
      const rows = await sql.$queryRawUnsafe<DbRow[]>(
        `${SELECT_ROWS} WHERE t.project_id = $1 AND ($2::text IS NULL OR t.channel = $2) AND ${CURRENT_VERSION_ONLY} ORDER BY t.created_at DESC, t.id`,
        projectId,
        channel ?? null
      );
      return rows.map(toRow);
    },

    async getVersion(
      projectId: string,
      id: string,
      version: number
    ): Promise<TemplateVersion> {
      const validVersion =
        Number.isInteger(version) && version >= 1 && version <= MAX_INT32;
      if (!(isUuid(id) && validVersion)) {
        throw new HttpError(404, 'not_found');
      }
      const [row] = await sql.$queryRawUnsafe<DbRow[]>(
        `${SELECT_ROWS} WHERE t.id = $1::uuid AND t.project_id = $2 AND v.version = $3`,
        id,
        projectId,
        version
      );
      if (!row) {
        throw new HttpError(404, 'not_found');
      }
      return toVersion(row);
    },

    async create(ctx: StoreContext, input: unknown): Promise<TemplateRow> {
      const parsed = parseInput(input);
      const id = randomUUID();
      await sql.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO marketing.message_templates (id, project_id, channel, enabled, current_version, created_by, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, true, 1, $4, $5, $5)`,
          id,
          ctx.projectId,
          parsed.channel,
          ctx.userId,
          deps.now()
        );
        await insertVersion(tx, id, 1, parsed, ctx.userId);
      });
      return get(ctx.projectId, id);
    },

    async update(
      ctx: StoreContext,
      id: string,
      input: unknown,
      expectedVersion: number
    ): Promise<TemplateRow> {
      if (!isUuid(id)) {
        throw new HttpError(404, 'not_found');
      }
      const parsed = parseInput(input);
      await sql.$transaction(async (tx) => {
        const [current] = await tx.$queryRawUnsafe<
          { channel: TemplateChannel; current_version: number }[]
        >(
          'SELECT channel, current_version FROM marketing.message_templates WHERE id = $1::uuid AND project_id = $2 FOR UPDATE',
          id,
          ctx.projectId
        );
        if (!current) {
          throw new HttpError(404, 'not_found');
        }
        if (current.channel !== parsed.channel) {
          throw new HttpError(400, 'channel_immutable');
        }
        if (current.current_version !== expectedVersion) {
          throw new HttpError(409, 'version_conflict');
        }
        const next = current.current_version + 1;
        await insertVersion(tx, id, next, parsed, ctx.userId);
        await tx.$executeRawUnsafe(
          'UPDATE marketing.message_templates SET current_version = $2, updated_at = $3 WHERE id = $1::uuid',
          id,
          next,
          deps.now()
        );
      });
      return get(ctx.projectId, id);
    },

    async setEnabled(
      ctx: StoreContext,
      id: string,
      enabled: boolean
    ): Promise<TemplateRow> {
      if (!isUuid(id)) {
        throw new HttpError(404, 'not_found');
      }
      const updated = await sql.$executeRawUnsafe(
        'UPDATE marketing.message_templates SET enabled = $3, updated_at = $4 WHERE id = $1::uuid AND project_id = $2',
        id,
        ctx.projectId,
        enabled,
        deps.now()
      );
      if (updated === 0) {
        throw new HttpError(404, 'not_found');
      }
      return get(ctx.projectId, id);
    },

    async readiness(projectId: string, id: string): Promise<Readiness> {
      if (!isUuid(id)) {
        return { ok: false, code: 'template_not_found' };
      }
      const [row] = await sql.$queryRawUnsafe<DbRow[]>(
        `${SELECT_ROWS} WHERE t.id = $1::uuid AND t.project_id = $2 AND ${CURRENT_VERSION_ONLY}`,
        id,
        projectId
      );
      if (!row) {
        return { ok: false, code: 'template_not_found' };
      }
      if (!row.enabled) {
        return { ok: false, code: 'template_disabled' };
      }
      if (
        row.channel === 'whatsapp' &&
        !whatsAppMappingMatches(row.approved_text, row.variables)
      ) {
        return { ok: false, code: 'template_mapping_missing' };
      }
      return { ok: true, version: toVersion(row), channel: row.channel };
    },
  };
}
