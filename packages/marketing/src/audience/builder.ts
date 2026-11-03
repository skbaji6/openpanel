import { HttpError } from '../api/http';
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
  const excludeListInconsistent =
    def.excludeIds !== null && def.excludeIds.length !== def.excludeCount;
  return {
    // Overlap and unsubtracted excludes only ever over-count, so when they are the sole cause the
    // count is an upper bound; when the API itself reports approximate it is an estimate.
    count: (filterCount ?? 0) + def.includeCount,
    approximate:
      approximate ||
      overlapUnknown ||
      unsubtractedExcludes ||
      excludeListInconsistent,
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
): Promise<{
  members: Member[];
  nextCursor: string | null;
  // False when an exclude filter exists: it cannot be pushed, so the page may include excluded people.
  exclusionsApplied: boolean;
}> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PREVIEW_LIMIT) {
    throw new Error(`preview limit must be 1 to ${MAX_PREVIEW_LIMIT}`);
  }
  const exclusionsApplied = def.excludeFilter === null;
  if (!def.filter) {
    return { members: [], nextCursor: null, exclusionsApplied };
  }
  const { filter, pushedExcludes } = buildSourceFilter(
    def.filter,
    def.excludeIds
  );
  const page = await source.members({
    filter,
    cursor,
    limit,
    fields: 'preview',
  });
  // A page may come back short; the cursor still advances past the dropped ids.
  const dropped = pushedExcludes ? null : new Set(def.excludeIds ?? []);
  return {
    members: dropped
      ? page.members.filter((member) => !dropped.has(member.id))
      : page.members,
    nextCursor: page.nextCursor,
    exclusionsApplied,
  };
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
  const [filter, excludeFilter] = await Promise.all([
    def.filter ? source.explain(def.filter, id) : undefined,
    def.excludeFilter ? source.explain(def.excludeFilter, id) : undefined,
  ]);
  const reasons: Reason[] = [];
  if (filter) {
    reasons.push(filter.matches ? 'matched_filter' : 'not_matched');
  } else if (!def.included) {
    reasons.push('not_matched');
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
    throw new HttpError(400, 'too_many_inputs');
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
