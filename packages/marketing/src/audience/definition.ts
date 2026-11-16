import { z } from 'zod';
import { zIdentifier } from '../api/routes-sync';
import {
  type FilterTree,
  MAX_FILTER_DEPTH,
  MAX_ID_CONDITION_VALUES,
  RESERVED_ID_DIMENSION,
  type Schema,
} from './contract';
import { validateFilter, validateFilterStructure } from './filter';

export const MAX_LIST_IDS = 20_000;
export const MAX_IDS_PER_CHANGE = 2000;
export const MAX_SNAPSHOT_IDS = 100_000;
export const MAX_AUDIENCE_NAME = 200;

// A missing key must fail: null means "no filter" and has to be said.
const zExplicitFilter = z.custom<unknown>(
  (value) => value !== undefined,
  'filter is required, use null'
);

export const zAudienceInput = z.strictObject({
  name: z.string().trim().min(1).max(MAX_AUDIENCE_NAME),
  mode: z.enum(['dynamic', 'snapshot']),
  filter: zExplicitFilter,
  excludeFilter: zExplicitFilter,
});

const zIdChangeList = z.array(zIdentifier).max(MAX_IDS_PER_CHANGE);

export const zIdListChange = z
  .strictObject({
    list: z.enum(['include', 'exclude']),
    add: zIdChangeList.optional(),
    remove: zIdChangeList.optional(),
    clear: z.literal(true).optional(),
  })
  .refine(
    (change) => change.add?.length || change.remove?.length || change.clear,
    'add, remove or clear is required'
  );

export interface AudienceDefinition {
  filter: FilterTree | null;
  excludeFilter: FilterTree | null;
  includeCount: number;
  excludeIds: string[] | null;
}

export function checkAudienceInput(
  input: z.infer<typeof zAudienceInput>,
  schema: Schema | null
):
  | { ok: true; filter: FilterTree | null; excludeFilter: FilterTree | null }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const [filter, excludeFilter] = [input.filter, input.excludeFilter].map(
    (raw) => {
      if (raw === null) {
        return null;
      }
      const result = schema
        ? validateFilter(raw, schema)
        : validateFilterStructure(raw);
      if (!result.ok) {
        errors.push(...result.errors);
        return null;
      }
      return result.filter;
    }
  );
  return errors.length > 0
    ? { ok: false, errors: [...new Set(errors)] }
    : {
        ok: true,
        filter: filter ?? null,
        excludeFilter: excludeFilter ?? null,
      };
}

function depthOf(node: FilterTree): number {
  return 'children' in node ? 1 + Math.max(...node.children.map(depthOf)) : 1;
}

export function buildSourceFilter(
  filter: FilterTree,
  excludeIds: string[] | null
): { filter: FilterTree; pushedExcludes: boolean } {
  const unchanged = { filter, pushedExcludes: false };
  if (
    !excludeIds ||
    excludeIds.length === 0 ||
    excludeIds.length > MAX_ID_CONDITION_VALUES
  ) {
    return unchanged;
  }
  const condition: FilterTree = {
    dimension: RESERVED_ID_DIMENSION,
    op: 'not_in',
    values: excludeIds,
  };
  if ('children' in filter && filter.op === 'and') {
    return {
      filter: { op: 'and', children: [...filter.children, condition] },
      pushedExcludes: true,
    };
  }
  const wrapped: FilterTree = { op: 'and', children: [filter, condition] };
  return depthOf(wrapped) <= MAX_FILTER_DEPTH
    ? { filter: wrapped, pushedExcludes: true }
    : unchanged;
}
