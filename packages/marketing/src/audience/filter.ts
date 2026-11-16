import {
  type Condition,
  type Dimension,
  type FilterTree,
  MAX_FILTER_DEPTH,
  MAX_ID_CONDITION_VALUES,
  MAX_RESOLVE_INPUTS,
  RESERVED_ID_DIMENSION,
  type Schema,
  zFilterTree,
} from './contract';

// Error strings never contain user-supplied values. A declared dimension key is
// schema data, so it may appear; an undeclared one is user input and may not.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

const valueChecks: Record<Dimension['type'], (value: unknown) => boolean> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  date: isIsoDate,
};

const EXACT_VALUE_COUNT = {
  eq: 1,
  gt: 1,
  lt: 1,
  between: 2,
  exists: 0,
} as const;

function checkIdCondition({ op, values }: Condition): string[] {
  if (op !== 'in' && op !== 'not_in') {
    return ['the id dimension supports only in and not_in'];
  }
  if (values.length < 1) {
    return [`${op} needs at least one value`];
  }
  if (values.length > MAX_ID_CONDITION_VALUES) {
    return [`id condition exceeds ${MAX_ID_CONDITION_VALUES} values`];
  }
  return values.every((value) => typeof value === 'string')
    ? []
    : ['id values must be strings'];
}

function checkCondition(condition: Condition, schema: Schema | null): string[] {
  const { dimension, op, values } = condition;

  if (dimension === RESERVED_ID_DIMENSION) {
    return checkIdCondition(condition);
  }

  const declared = schema?.dimensions.find((d) => d.key === dimension);
  if (schema && !declared) {
    return ['unknown dimension'];
  }
  const label = declared ? `dimension ${declared.key}` : 'a dimension';

  const isOrdered =
    !declared || declared.type === 'number' || declared.type === 'date';
  if ((op === 'gt' || op === 'lt' || op === 'between') && !isOrdered) {
    return [`${op} is not allowed on ${label}`];
  }

  if (op === 'in' || op === 'not_in') {
    if (values.length < 1) {
      return [`${op} needs at least one value on ${label}`];
    }
  } else if (values.length !== EXACT_VALUE_COUNT[op]) {
    return [
      `${op} needs exactly ${EXACT_VALUE_COUNT[op]} value(s) on ${label}`,
    ];
  }

  if (!declared) {
    return [];
  }
  return values.every(valueChecks[declared.type])
    ? []
    : [`values for ${label} must be of type ${declared.type}`];
}

// depth counts groups: a lone condition is 1, a group of conditions is 2.
function walk(
  node: FilterTree,
  schema: Schema | null,
  depth: number,
  errors: string[]
): void {
  const nodeDepth = depth + 1;
  if (nodeDepth > MAX_FILTER_DEPTH) {
    errors.push(`filter nesting exceeds ${MAX_FILTER_DEPTH} levels`);
    return;
  }
  if ('children' in node) {
    for (const child of node.children) {
      walk(child, schema, nodeDepth, errors);
    }
    return;
  }
  errors.push(...checkCondition(node, schema));
}

const MAX_FILTER_STRING_LENGTH = 512;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUL = '\u0000';

// Runs before zod so hostile input cannot recurse the parser's stack.
function isHostile(node: unknown, depth: number): boolean {
  if (depth > MAX_FILTER_DEPTH * 2 + 2) {
    return true;
  }
  if (typeof node === 'string') {
    return node.length > MAX_FILTER_STRING_LENGTH || node.includes(NUL);
  }
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  if (Object.keys(node).some((key) => FORBIDDEN_KEYS.has(key))) {
    return true;
  }
  return Object.values(node).some((child) => isHostile(child, depth + 1));
}

function check(
  filter: unknown,
  schema: Schema | null
): { ok: true; filter: FilterTree } | { ok: false; errors: string[] } {
  const parsed = isHostile(filter, 0) ? null : zFilterTree.safeParse(filter);
  if (!parsed?.success) {
    return { ok: false, errors: ['filter is not a valid filter tree'] };
  }
  const errors: string[] = [];
  walk(parsed.data, schema, 0, errors);
  const unique = [...new Set(errors)];
  return unique.length > 0
    ? { ok: false, errors: unique }
    : { ok: true, filter: parsed.data };
}

export function validateFilter(
  filter: unknown,
  schema: Schema
): { ok: true; filter: FilterTree } | { ok: false; errors: string[] } {
  return check(filter, schema);
}

export function validateFilterStructure(
  filter: unknown
): { ok: true; filter: FilterTree } | { ok: false; errors: string[] } {
  return check(filter, null);
}

export function normalizeResolveInputs(raw: string[]): {
  inputs: string[];
  errors: string[];
} {
  const inputs = [
    ...new Set(
      raw.map((input) => input.trim()).filter((input) => input !== '')
    ),
  ];
  if (inputs.length > MAX_RESOLVE_INPUTS) {
    return {
      inputs: [],
      errors: [`too many inputs: at most ${MAX_RESOLVE_INPUTS} per call`],
    };
  }
  return { inputs, errors: [] };
}
