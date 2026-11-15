import { z } from 'zod';
import type { Sql } from '../engine/engine';
import { readCsv } from '../journeys/csv-reader';
import { planImport } from '../journeys/import-plan';
import { applyImport } from '../journeys/import-store';
import {
  ImportFileError,
  MAX_IMPORT_BYTES,
  readXlsx,
  type SheetRows,
} from '../journeys/xlsx-reader';
import {
  MAX_VARIANT_KEY_LENGTH,
  MAX_VARIANTS,
  zRuleDefinition,
} from '../rules/rule.schema';
import { pinOrThrow } from '../templates/pin';
import type { createTemplateRegistry } from '../templates/registry';
import { HttpError, json, parseJsonBody, type Route } from './http';
import {
  RULE_COLUMNS,
  type RuleRow,
  ruleIdParam,
  toRule,
} from './routes-dashboard';

const CONFLICT = 409;

const zStart = z.strictObject({ expectedVersion: z.number().int() });

const MAX_IMPORT_BASE64_LENGTH = Math.ceil(MAX_IMPORT_BYTES / 3) * 4;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_JOURNEY_OPTIONS = 200;
const MAX_EVENT_NAME_LENGTH = 200;

const zEventName = z.string().trim().min(1).max(MAX_EVENT_NAME_LENGTH);
const zImport = z.strictObject({
  format: z.enum(['xlsx', 'csv']),
  contentBase64: z.string(),
  dryRun: z.boolean(),
  options: z.strictObject({
    states: z
      .record(z.string(), z.string().trim().min(1).max(MAX_VARIANT_KEY_LENGTH))
      .refine((states) => Object.keys(states).length <= MAX_VARIANTS),
    journeys: z
      .record(
        z.string(),
        z.strictObject({
          triggerEvent: zEventName.optional(),
          goalEvent: zEventName.optional(),
        })
      )
      .refine((journeys) => Object.keys(journeys).length <= MAX_JOURNEY_OPTIONS)
      .optional(),
    overwriteEdited: z.boolean().optional(),
  }),
});

function readUpload(
  format: 'xlsx' | 'csv',
  contentBase64: string
): SheetRows[] {
  // The length check comes first so an oversized upload is never decoded.
  if (contentBase64.length > MAX_IMPORT_BASE64_LENGTH) {
    throw new ImportFileError('file_too_large');
  }
  if (!BASE64_PATTERN.test(contentBase64)) {
    throw new HttpError(400, 'invalid_body');
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  if (format === 'xlsx') {
    return readXlsx(new Uint8Array(bytes));
  }
  try {
    return readCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw error instanceof ImportFileError
      ? error
      : new ImportFileError('malformed_csv');
  }
}

const SKIPS_SQL = `
  SELECT COALESCE(s.outcome->>'reason', 'unknown') AS reason, count(*)::int AS count
  FROM marketing.steps s
  JOIN marketing.enrollments e ON e.id = s.enrollment_id
  WHERE e.project_id = $1 AND e.rule_id = $2::uuid AND s.status = 'skipped'
  GROUP BY 1 ORDER BY count DESC, reason`;

export interface JourneyDeps {
  sql: Sql;
  registry: ReturnType<typeof createTemplateRegistry>;
  rulesChanged: () => Promise<void>;
}

export function routesJourneys(deps: JourneyDeps): Route[] {
  const { sql, registry } = deps;

  return [
    {
      method: 'POST',
      pattern: /^\/marketing\/rules\/import$/,
      auth: 'dashboard',
      async handle(ctx) {
        const body = await parseJsonBody(ctx.req, zImport);
        let sheets: SheetRows[];
        try {
          sheets = readUpload(body.format, body.contentBase64);
        } catch (error) {
          if (error instanceof ImportFileError) {
            throw new HttpError(400, error.code);
          }
          throw error;
        }
        const { journeys, problems } = planImport(sheets, body.options);
        const results = await applyImport(sql, ctx.projectId, journeys, {
          overwriteEdited: body.options.overwriteEdited,
          dryRun: body.dryRun,
        });
        const variants = Object.values(body.options.states);
        return json({
          sheets: sheets.map((sheet) => sheet.sheet).filter(Boolean),
          journeys: journeys.map((journey) => {
            const result = results.find((r) => r.key === journey.key);
            return {
              key: journey.key,
              name: journey.name,
              action: result?.action,
              ruleId: result?.ruleId ?? null,
              steps: journey.definition.steps.length,
              variants,
              unconfirmed: journey.unconfirmed,
            };
          }),
          problems,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/marketing\/rules\/([^/]+)\/start$/,
      auth: 'dashboard',
      async handle(ctx) {
        const ruleId = ruleIdParam(ctx.params);
        const { expectedVersion } = await parseJsonBody(ctx.req, zStart);
        // The row lock makes a concurrent start or edit wait, then fail the version check.
        const started = await sql.$transaction(async (tx) => {
          const [current] = await tx.$queryRawUnsafe<RuleRow[]>(
            `SELECT ${RULE_COLUMNS} FROM marketing.rules
             WHERE id = $1::uuid AND project_id = $2 FOR UPDATE`,
            ruleId,
            ctx.projectId
          );
          if (!current) {
            throw new HttpError(404, 'not_found');
          }
          if (current.version !== expectedVersion) {
            throw new HttpError(CONFLICT, 'version_conflict');
          }
          if (current.status === 'active') {
            throw new HttpError(CONFLICT, 'invalid_transition');
          }
          if (current.unconfirmed.length > 0) {
            throw new HttpError(CONFLICT, 'journey_unconfirmed', undefined, {
              fields: current.unconfirmed,
            });
          }
          const { definition, pinned } = await pinOrThrow(
            registry,
            ctx.projectId,
            zRuleDefinition.parse(current.definition)
          );
          const [row] = await tx.$queryRawUnsafe<RuleRow[]>(
            `UPDATE marketing.rules SET definition = $3::jsonb, status = 'active',
               version = version + 1, updated_at = now()
             WHERE id = $1::uuid AND project_id = $2 RETURNING ${RULE_COLUMNS}`,
            ruleId,
            ctx.projectId,
            JSON.stringify(definition)
          );
          return { row, pinned };
        });
        await deps.rulesChanged();
        return json({
          rule: started.row ? toRule(started.row) : null,
          pinned: started.pinned,
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/marketing\/rules\/([^/]+)\/skips$/,
      auth: 'dashboard',
      async handle(ctx) {
        const reasons = await sql.$queryRawUnsafe<
          { reason: string; count: number }[]
        >(SKIPS_SQL, ctx.projectId, ruleIdParam(ctx.params));
        return json({ reasons });
      },
    },
  ];
}
