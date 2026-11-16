import {
  type Condition,
  type FilterTree,
  RESERVED_ID_DIMENSION,
} from '../../src/audience/contract';
import type { DimensionMapping, Mapping } from './mapping';

export const STUDENT_ALIAS = 's';
const CHILD_ALIAS = 'x';

const CAST = {
  string: '',
  number: '::numeric',
  date: '::date',
  boolean: '::boolean',
} as const;

export function quote(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
}

// A dotted name is already qualified; a bare one belongs to the students alias.
export function studentColumn(name: string): string {
  return name.includes('.') ? quote(name) : `${STUDENT_ALIAS}.${quote(name)}`;
}

// Ids travel as text whatever the column type, so numeric keys work unchanged.
export function idExpression(mapping: Mapping): string {
  return `${studentColumn(mapping.idColumn)}::text`;
}

export function studentsFrom(mapping: Mapping): string {
  return `${quote(mapping.studentsTable)} ${STUDENT_ALIAS}`;
}

export type Params = unknown[];

export function bind(params: Params, value: unknown, cast = ''): string {
  params.push(value);
  return `$${params.length}${cast}`;
}

export function bindList(params: Params, values: unknown[]): string {
  return values.map((value) => bind(params, value)).join(', ');
}

function bindTyped(params: Params, values: unknown[], cast: string): string {
  return values.map((value) => bind(params, value, cast)).join(', ');
}

function predicate(
  left: string,
  op: Condition['op'],
  values: unknown[],
  type: DimensionMapping['type'],
  params: Params
): string {
  const cast = CAST[type];
  const needs = (count: number) => {
    if (values.length < count) {
      throw new Error('condition has too few values');
    }
  };
  switch (op) {
    case 'eq':
      needs(1);
      return `${left} = ${bind(params, values[0], cast)}`;
    case 'in':
      needs(1);
      return `${left} IN (${bindTyped(params, values, cast)})`;
    case 'not_in':
      needs(1);
      return `(${left} IS NULL OR ${left} NOT IN (${bindTyped(params, values, cast)}))`;
    case 'gt':
      needs(1);
      return `${left} > ${bind(params, values[0], cast)}`;
    case 'lt':
      needs(1);
      return `${left} < ${bind(params, values[0], cast)}`;
    case 'between':
      needs(2);
      return `${left} BETWEEN ${bind(params, values[0], cast)} AND ${bind(params, values[1], cast)}`;
    case 'exists':
      return `${left} IS NOT NULL`;
    default:
      throw new Error('unsupported operator');
  }
}

function compileIdCondition(
  { op, values }: Condition,
  mapping: Mapping,
  params: Params
): string {
  if (op !== 'in' && op !== 'not_in') {
    throw new Error('the id dimension supports only in and not_in');
  }
  if (values.length < 1) {
    throw new Error('condition has too few values');
  }
  const keyword = op === 'in' ? 'IN' : 'NOT IN';
  return `${idExpression(mapping)} ${keyword} (${bindList(params, values)})`;
}

// EXISTS rather than a join keeps one row per student for count, paging and explain.
function compileMultiValued(
  dimension: DimensionMapping,
  { op, values }: Condition,
  mapping: Mapping,
  params: Params
): string {
  const exists = dimension.exists;
  if (!exists) {
    throw new Error('multi-valued dimension without exists');
  }
  const child = `${quote(exists.table)} ${CHILD_ALIAS}`;
  const link = `${CHILD_ALIAS}.${quote(exists.studentColumn)}::text = ${idExpression(mapping)}`;
  const valueColumn = `${CHILD_ALIAS}.${quote(exists.valueColumn)}`;
  const select = (extra?: string) =>
    `SELECT 1 FROM ${child} WHERE ${link}${extra ? ` AND ${extra}` : ''}`;

  if (op === 'exists') {
    return `EXISTS (${select()})`;
  }
  if (op === 'not_in') {
    const inside = predicate(valueColumn, 'in', values, dimension.type, params);
    return `NOT EXISTS (${select(inside)})`;
  }
  const inside = predicate(valueColumn, op, values, dimension.type, params);
  return `EXISTS (${select(inside)})`;
}

export function compileCondition(
  condition: Condition,
  mapping: Mapping,
  params: Params
): string {
  if (condition.dimension === RESERVED_ID_DIMENSION) {
    return compileIdCondition(condition, mapping, params);
  }
  const dimension = mapping.dimensions.find(
    (d) => d.key === condition.dimension
  );
  if (!dimension) {
    throw new Error('unknown dimension');
  }
  if (dimension.exists) {
    return compileMultiValued(dimension, condition, mapping, params);
  }
  const left = dimension.column
    ? studentColumn(dimension.column)
    : `(${dimension.expression})`;
  return predicate(
    left,
    condition.op,
    condition.values,
    dimension.type,
    params
  );
}

function compileNode(
  node: FilterTree,
  mapping: Mapping,
  params: Params
): string {
  if ('children' in node) {
    const joiner = node.op === 'and' ? ' AND ' : ' OR ';
    const parts = node.children.map((child) =>
      compileNode(child, mapping, params)
    );
    return `(${parts.join(joiner)})`;
  }
  return `(${compileCondition(node, mapping, params)})`;
}

export function compileFilter(
  filter: FilterTree,
  mapping: Mapping
): { sql: string; params: unknown[] } {
  const params: Params = [];
  const sql = compileNode(filter, mapping, params);
  return { sql, params };
}

export function collectConditions(filter: FilterTree): Condition[] {
  return 'children' in filter
    ? filter.children.flatMap(collectConditions)
    : [filter];
}
