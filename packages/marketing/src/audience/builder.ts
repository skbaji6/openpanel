import type { Explanation, Member } from './contract';
import { type AudienceDefinition, buildSourceFilter } from './definition';
import { normalizeResolveInputs } from './filter';
import type { AudienceSource } from './source';

export const MAX_PREVIEW_LIMIT = 50;

export interface AudienceCount {
  count: number;
  approximate: boolean;
  countedAt: string;
  filterCount: number | null;
  includeCount: number;
  excludeCount: number;
}

export async function countAudience(
  source: AudienceSource,
  def: AudienceDefinition & { excludeCount: number },
  now: () => Date
): Promise<AudienceCount> {
  let filterCount: number | null = null;
  let approximate = false;
  let pushedExcludes = false;
  if (def.filter) {
    const built = buildSourceFilter(def.filter, def.excludeIds);
    pushedExcludes = built.pushedExcludes;
    const result = await source.count(built.filter);
    filterCount = result.count;
    approximate = result.approximate === true;
  }
  const overlapUnknown = def.filter !== null && def.includeCount > 0;
  const unsubtractedExcludes =
    def.excludeFilter !== null || (def.excludeCount > 0 && !pushedExcludes);
  return {
    // Overlap and unpushed excludes are never subtracted, so an approximate count is an upper bound.
    count: (filterCount ?? 0) + def.includeCount,
    approximate: approximate || overlapUnknown || unsubtractedExcludes,
    countedAt: now().toISOString(),
    filterCount,
    includeCount: def.includeCount,
    excludeCount: def.excludeCount,
  };
}

export async function previewAudience(
  source: AudienceSource,
  def: AudienceDefinition,
  cursor: string | undefined,
  limit: number
): Promise<{ members: Member[]; nextCursor: string | null }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PREVIEW_LIMIT) {
    throw new Error(`preview limit must be 1 to ${MAX_PREVIEW_LIMIT}`);
  }
  if (!def.filter) {
    return { members: [], nextCursor: null };
  }
  const { filter } = buildSourceFilter(def.filter, def.excludeIds);
  return source.members({ filter, cursor, limit, fields: 'preview' });
}

type Reason =
  | 'matched_filter'
  | 'not_matched'
  | 'included'
  | 'excluded_by_list'
  | 'excluded_by_filter';

export async function explainAudience(
  source: AudienceSource,
  def: {
    filter: AudienceDefinition['filter'];
    excludeFilter: AudienceDefinition['excludeFilter'];
    included: boolean;
    excludedByList: boolean;
  },
  id: string
): Promise<{
  id: string;
  verdict: 'in' | 'out';
  reasons: Reason[];
  filter?: Explanation;
  excludeFilter?: Explanation;
}> {
  const filter = def.filter ? await source.explain(def.filter, id) : undefined;
  const excludeFilter = def.excludeFilter
    ? await source.explain(def.excludeFilter, id)
    : undefined;
  const reasons: Reason[] = [];
  if (filter) {
    reasons.push(filter.matches ? 'matched_filter' : 'not_matched');
  }
  if (def.included) {
    reasons.push('included');
  }
  if (def.excludedByList) {
    reasons.push('excluded_by_list');
  }
  if (excludeFilter?.matches) {
    reasons.push('excluded_by_filter');
  }
  const wanted = filter?.matches === true || def.included;
  const excluded = def.excludedByList || excludeFilter?.matches === true;
  return {
    id,
    verdict: wanted && !excluded ? 'in' : 'out',
    reasons,
    ...(filter && { filter }),
    ...(excludeFilter && { excludeFilter }),
  };
}

export async function resolveInputs(
  source: AudienceSource,
  raw: string[]
): Promise<{ ids: string[]; unmatchedPositions: number[] }> {
  const { inputs, errors } = normalizeResolveInputs(raw);
  if (errors.length > 0) {
    // Echoes nothing: the raw values are contact details.
    throw new Error('too many inputs');
  }
  const idByInput = new Map<string, string>();
  if (inputs.length > 0) {
    const { matches } = await source.resolve(inputs);
    for (const match of matches) {
      idByInput.set(match.input, match.id);
    }
  }
  const unmatchedPositions: number[] = [];
  for (const [position, value] of raw.entries()) {
    if (!idByInput.has(value.trim())) {
      unmatchedPositions.push(position);
    }
  }
  return { ids: [...new Set(idByInput.values())], unmatchedPositions };
}
