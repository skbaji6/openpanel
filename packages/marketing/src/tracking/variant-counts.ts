import type { Queryable } from '../engine/engine';

export type VariantOutcome = 'sent' | 'skipped' | 'failed';

export interface VariantCountRow {
  projectId: string;
  ruleId: string;
  stepIndex: number;
  variantKey: string;
  status: VariantOutcome;
  at: Date;
}

// The counter holds ids and counts only: the key is an operator's configured key, never a student's state.
// One statement per column keeps the column name out of bound values.
function upsertSql(column: VariantOutcome): string {
  return `
    INSERT INTO marketing.journey_variant_counts (project_id, rule_id, step_index, variant_key, day, ${column})
    VALUES ($1, $2::uuid, $3, $4, ($5::timestamptz AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (rule_id, step_index, variant_key, day)
    DO UPDATE SET ${column} = marketing.journey_variant_counts.${column} + 1`;
}

export const COUNT_SQL: Record<VariantOutcome, string> = {
  sent: upsertSql('sent'),
  skipped: upsertSql('skipped'),
  failed: upsertSql('failed'),
};

export async function countVariantOutcome(
  sql: Queryable,
  row: VariantCountRow
): Promise<void> {
  await sql.$executeRawUnsafe(
    COUNT_SQL[row.status],
    row.projectId,
    row.ruleId,
    row.stepIndex,
    row.variantKey,
    row.at.toISOString()
  );
}
