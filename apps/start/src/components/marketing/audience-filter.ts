import {
  type AudienceCount,
  type Condition,
  type Dimension,
  type ExplanationReason,
  type FilterGroup,
  type FilterOp,
  type FilterTree,
  MAX_AUDIENCE_NAME,
  MAX_FILTER_DEPTH,
  MAX_FILTER_STRING_LENGTH,
  MAX_ID_CONDITION_VALUES,
  RESERVED_ID_DIMENSION,
} from './campaign-contract';

export type FilterPath = number[];
type FilterValue = Condition['values'][number];

const ORDERED_OPS: FilterOp[] = ['eq', 'gt', 'lt', 'between', 'exists'];
const OPS_BY_TYPE: Record<Dimension['type'], FilterOp[]> = {
  string: ['in', 'not_in', 'exists'],
  number: ORDERED_OPS,
  date: ORDERED_OPS,
  boolean: ['eq', 'exists'],
};
const ID_OPS: FilterOp[] = ['in', 'not_in'];
const MULTI_VALUE_OPS = new Set<FilterOp>(['in', 'not_in']);
const EXACT_VALUE_COUNT: Partial<Record<FilterOp, number>> = {
  eq: 1,
  gt: 1,
  lt: 1,
  between: 2,
  exists: 0,
};
// A new group holds conditions one level below itself.
const LEVELS_ADDED_BY_GROUP = 2;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID_SEPARATORS = /[\s,]+/;
const COUNT_FORMAT = new Intl.NumberFormat('en-US');

export const OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  in: 'is any of',
  not_in: 'is not any of',
  gt: 'is more than',
  lt: 'is less than',
  between: 'is between',
  exists: 'has a value',
};

export const EXPLANATION_LABELS: Record<ExplanationReason, string> = {
  matched_filter: 'Matches the "Who is in" filter',
  not_matched: 'Does not match the "Who is in" filter',
  included: 'Is on the "Add specific students" list',
  excluded_by_list: 'Is on the "Always leave out" list',
  excluded_by_filter: 'Matches the "Leave out by filter" filter',
};

const isGroup = (node: FilterTree): node is FilterGroup => 'children' in node;
const isIdDimension = (dimension: Dimension) =>
  dimension.key === RESERVED_ID_DIMENSION;

// The service compares ids as strings whatever type the schema declares.
const valueTypeOf = (dimension: Dimension): Dimension['type'] =>
  isIdDimension(dimension) ? 'string' : dimension.type;

export function emptyGroup(): FilterGroup {
  return { op: 'and', children: [] };
}

export function opsFor(dimension: Dimension): FilterOp[] {
  return isIdDimension(dimension) ? ID_OPS : OPS_BY_TYPE[dimension.type];
}

export function emptyCondition(dimension: Dimension): Condition {
  return {
    dimension: dimension.key,
    op: opsFor(dimension)[0] ?? 'exists',
    values: [],
  };
}

export function isMultiValue(op: FilterOp): boolean {
  return MULTI_VALUE_OPS.has(op);
}

export function depthOf(tree: FilterTree): number {
  if (!isGroup(tree)) {
    return 1;
  }
  return 1 + Math.max(0, ...tree.children.map(depthOf));
}

function nodeAt(tree: FilterTree, path: FilterPath): FilterTree | undefined {
  let node: FilterTree | undefined = tree;
  for (const index of path) {
    node = node && isGroup(node) ? node.children[index] : undefined;
  }
  return node;
}

export function canNest(tree: FilterTree, path: FilterPath): boolean {
  const node = nodeAt(tree, path);
  const groupDepth = path.length + 1;
  return (
    node !== undefined &&
    isGroup(node) &&
    groupDepth + LEVELS_ADDED_BY_GROUP <= MAX_FILTER_DEPTH
  );
}

export function updateNode(
  tree: FilterTree,
  path: FilterPath,
  update: (node: FilterTree) => FilterTree
): FilterTree {
  const [index, ...rest] = path;
  if (index === undefined) {
    return update(tree);
  }
  if (!isGroup(tree)) {
    return tree;
  }
  return {
    ...tree,
    children: tree.children.map((child, position) =>
      position === index ? updateNode(child, rest, update) : child
    ),
  };
}

export function removeNode(tree: FilterTree, path: FilterPath): FilterTree {
  const parentPath = path.slice(0, -1);
  const index = path.at(-1);
  return updateNode(tree, parentPath, (parent) =>
    isGroup(parent)
      ? {
          ...parent,
          children: parent.children.filter((_, position) => position !== index),
        }
      : parent
  );
}

export function coerceValue(dimension: Dimension, raw: string): FilterValue {
  const type = valueTypeOf(dimension);
  if (type === 'number') {
    const parsed = Number(raw);
    return raw.trim() !== '' && Number.isFinite(parsed) ? parsed : raw;
  }
  if (type === 'boolean' && (raw === 'true' || raw === 'false')) {
    return raw === 'true';
  }
  return raw;
}

function isIsoDate(value: FilterValue): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

const VALUE_CHECKS: Record<
  Dimension['type'],
  { check: (value: FilterValue) => boolean; noun: string }
> = {
  string: { check: (value) => typeof value === 'string', noun: 'text' },
  number: {
    check: (value) => typeof value === 'number' && Number.isFinite(value),
    noun: 'numbers',
  },
  date: { check: isIsoDate, noun: 'dates' },
  boolean: { check: (value) => typeof value === 'boolean', noun: 'yes or no' },
};

function valueCountProblem(condition: Condition): string | null {
  const { op, values } = condition;
  if (isMultiValue(op)) {
    return values.length > 0 ? null : 'pick at least one value';
  }
  const expected = EXACT_VALUE_COUNT[op];
  if (values.length === expected) {
    return null;
  }
  if (op === 'between') {
    return 'enter both ends of the range';
  }
  return expected === 0
    ? `${OP_LABELS[op]} takes no values`
    : 'enter one value';
}

function conditionProblem(
  condition: Condition,
  dimensions: Dimension[]
): string | null {
  const dimension = dimensions.find((d) => d.key === condition.dimension);
  if (!dimension) {
    return 'A condition uses a field the audience API no longer offers';
  }
  const name = dimension.label;
  if (!opsFor(dimension).includes(condition.op)) {
    return `${name}: "${OP_LABELS[condition.op]}" does not apply to this field`;
  }
  const countProblem = valueCountProblem(condition);
  if (countProblem) {
    return `${name}: ${countProblem}`;
  }
  const limitProblem = valueLimitProblem(condition, dimension);
  if (limitProblem) {
    return `${name}: ${limitProblem}`;
  }
  const { check, noun } = VALUE_CHECKS[valueTypeOf(dimension)];
  return condition.values.every(check)
    ? null
    : `${name}: values must be ${noun}`;
}

function valueLimitProblem(
  condition: Condition,
  dimension: Dimension
): string | null {
  if (
    isIdDimension(dimension) &&
    condition.values.length > MAX_ID_CONDITION_VALUES
  ) {
    return `at most ${formatCount(MAX_ID_CONDITION_VALUES)} values`;
  }
  const tooLong = condition.values.some(
    (value) =>
      typeof value === 'string' && value.length > MAX_FILTER_STRING_LENGTH
  );
  return tooLong
    ? `a value is longer than ${MAX_FILTER_STRING_LENGTH} characters`
    : null;
}

export function nameProblems(name: string): string[] {
  const trimmed = name.trim();
  if (trimmed === '') {
    return ['Give the audience a name'];
  }
  return trimmed.length > MAX_AUDIENCE_NAME
    ? [`The name is longer than ${MAX_AUDIENCE_NAME} characters`]
    : [];
}

// Messages name schema labels only, never a value someone typed.
export function filterProblems(
  tree: FilterTree,
  dimensions: Dimension[]
): string[] {
  const problems = new Set<string>();
  if (depthOf(tree) > MAX_FILTER_DEPTH) {
    problems.add('Groups are nested too deeply');
  }
  const walk = (node: FilterTree) => {
    if (isGroup(node)) {
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    const problem = conditionProblem(node, dimensions);
    if (problem) {
      problems.add(problem);
    }
  };
  walk(tree);
  return [...problems];
}

export function normalizeFilter(tree: FilterTree | null): FilterTree | null {
  if (tree === null || !isGroup(tree)) {
    return tree;
  }
  const children = tree.children
    .map(normalizeFilter)
    .filter((child): child is FilterTree => child !== null);
  return children.length > 0 ? { ...tree, children } : null;
}

export function parseIdInput(text: string): string[] {
  return [
    ...new Set(
      text
        .split(ID_SEPARATORS)
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ];
}

export function chunkIds<T>(ids: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}

export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

export function describeCount(count: AudienceCount): string {
  const noun = count.count === 1 ? 'student' : 'students';
  const prefix = count.approximate ? 'About ' : '';
  return `${prefix}${formatCount(count.count)} ${noun}`;
}
