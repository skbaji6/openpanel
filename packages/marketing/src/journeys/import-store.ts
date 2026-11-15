import { createHash, randomUUID } from 'node:crypto';
import type { Queryable, Sql } from '../engine/engine';
import type { RuleDefinition } from '../rules/rule.schema';
import type { PlannedJourney } from './import-plan';

const TRANSACTION = { timeout: 60_000, maxWait: 30_000 };
const LIVE_STATUSES = new Set(['active', 'paused']);

export type ImportAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped_live'
  | 'skipped_edited';

export type ImportResult = {
  key: string;
  action: ImportAction;
  ruleId: string | null;
};

type ExistingRule = {
  id: string;
  status: string;
  definition: RuleDefinition;
  unconfirmed: string[];
  imported_steps_hash: string | null;
};

// Thrown to roll a dry run back; carries the results out of the transaction.
class DryRunRollback extends Error {
  readonly results: ImportResult[];
  constructor(results: ImportResult[]) {
    super('dry_run');
    this.results = results;
  }
}

// jsonb does not keep key order, so hashes and comparisons go through sorted keys.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stepsHash(steps: unknown): string {
  return createHash('sha256').update(canonical(steps)).digest('hex');
}

const SELECT_EXISTING = `SELECT id::text, status, definition, unconfirmed, imported_steps_hash
  FROM marketing.rules WHERE project_id = $1 AND journey_key = $2 FOR UPDATE`;

async function lockExisting(
  tx: Queryable,
  projectId: string,
  key: string
): Promise<ExistingRule | undefined> {
  const [row] = await tx.$queryRawUnsafe<ExistingRule[]>(
    SELECT_EXISTING,
    projectId,
    key
  );
  return row;
}

// The unique index decides a race: the loser's insert waits for the winner, does nothing, and then sees its row.
async function insertDraft(
  tx: Queryable,
  projectId: string,
  planned: PlannedJourney
): Promise<string | undefined> {
  const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.rules
       (id, project_id, name, status, definition, journey_key, unconfirmed, imported_steps_hash)
     VALUES ($1::uuid, $2, $3, 'draft', $4::jsonb, $5, $6::text[], $7)
     ON CONFLICT (project_id, journey_key) WHERE journey_key IS NOT NULL DO NOTHING
     RETURNING id::text`,
    randomUUID(),
    projectId,
    planned.name,
    JSON.stringify(planned.definition),
    planned.key,
    planned.unconfirmed,
    stepsHash(planned.definition.steps)
  );
  return row?.id;
}

// Only entries the request supplied replace the stored trigger and goal.
function mergeIntoExisting(existing: ExistingRule, planned: PlannedJourney) {
  const supplied = (field: 'trigger' | 'goal') =>
    !planned.unconfirmed.includes(field);
  const definition: RuleDefinition = {
    ...existing.definition,
    steps: planned.definition.steps,
    trigger: supplied('trigger')
      ? planned.definition.trigger
      : existing.definition.trigger,
    goal: supplied('goal') ? planned.definition.goal : existing.definition.goal,
  };
  const unconfirmed = existing.unconfirmed.filter(
    (field) => !((field === 'trigger' || field === 'goal') && supplied(field))
  );
  return { definition, unconfirmed };
}

async function updateExisting(
  tx: Queryable,
  projectId: string,
  existing: ExistingRule,
  planned: PlannedJourney,
  overwriteEdited: boolean
): Promise<ImportResult> {
  const result = (action: ImportAction): ImportResult => ({
    key: planned.key,
    action,
    ruleId: existing.id,
  });
  if (LIVE_STATUSES.has(existing.status)) {
    return result('skipped_live');
  }
  const { definition, unconfirmed } = mergeIntoExisting(existing, planned);
  const isSame =
    canonical(definition) === canonical(existing.definition) &&
    canonical(unconfirmed) === canonical(existing.unconfirmed);
  if (isSame) {
    return result('unchanged');
  }
  const wasEdited =
    stepsHash(existing.definition.steps) !== existing.imported_steps_hash;
  const stepsDiffer =
    canonical(definition.steps) !== canonical(existing.definition.steps);
  if (wasEdited && stepsDiffer && !overwriteEdited) {
    return result('skipped_edited');
  }
  await tx.$executeRawUnsafe(
    `UPDATE marketing.rules SET definition = $3::jsonb, unconfirmed = $4::text[],
       imported_steps_hash = $5, version = version + 1, updated_at = now()
     WHERE id = $1::uuid AND project_id = $2`,
    existing.id,
    projectId,
    JSON.stringify(definition),
    unconfirmed,
    stepsHash(definition.steps)
  );
  return result('updated');
}

async function importOne(
  tx: Queryable,
  projectId: string,
  planned: PlannedJourney,
  overwriteEdited: boolean
): Promise<ImportResult> {
  let existing = await lockExisting(tx, projectId, planned.key);
  if (!existing) {
    const id = await insertDraft(tx, projectId, planned);
    if (id) {
      return { key: planned.key, action: 'created', ruleId: id };
    }
    existing = await lockExisting(tx, projectId, planned.key);
  }
  if (!existing) {
    throw new Error('import_conflict');
  }
  return await updateExisting(
    tx,
    projectId,
    existing,
    planned,
    overwriteEdited
  );
}

export async function applyImport(
  sql: Sql,
  projectId: string,
  planned: PlannedJourney[],
  options: { overwriteEdited?: boolean; dryRun: boolean }
): Promise<ImportResult[]> {
  if (planned.length === 0) {
    return [];
  }
  // A fixed key order means two concurrent imports lock rows in the same order and cannot deadlock.
  const ordered = [...planned].sort((a, b) => (a.key < b.key ? -1 : 1));
  try {
    return await sql.$transaction(async (tx) => {
      const results: ImportResult[] = [];
      for (const journey of ordered) {
        results.push(
          await importOne(tx, projectId, journey, !!options.overwriteEdited)
        );
      }
      if (options.dryRun) {
        throw new DryRunRollback(results);
      }
      return results;
    }, TRANSACTION);
  } catch (error) {
    if (error instanceof DryRunRollback) {
      return error.results.map((result) =>
        result.action === 'created' ? { ...result, ruleId: null } : result
      );
    }
    throw error;
  }
}
