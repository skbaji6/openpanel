import { z } from 'zod';
import type { Sql } from '../engine/engine';
import { zRuleDefinition } from '../rules/rule.schema';
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
