import { describe, expect, test } from 'bun:test';
import type { FilterTree, Schema } from './contract';
import {
  buildSourceFilter,
  checkAudienceInput,
  zIdListChange,
} from './definition';
import { validateFilterStructure } from './filter';

const schema: Schema = {
  dimensions: [
    {
      key: 'city',
      label: 'City',
      type: 'string',
      multiValued: false,
      valuesListable: true,
    },
  ],
};
const city: FilterTree = { dimension: 'city', op: 'eq', values: ['a'] };
const and = (...children: FilterTree[]): FilterTree => ({
  op: 'and',
  children,
});
const or = (...children: FilterTree[]): FilterTree => ({ op: 'or', children });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
const input = (filter: unknown) => ({
  name: 'x',
  mode: 'dynamic' as const,
  filter,
  excludeFilter: null,
});

describe('validateFilterStructure', () => {
  test('accepts depth 3 and rejects depth 4', () => {
    expect(validateFilterStructure(and(or(city))).ok).toBe(true);
    expect(validateFilterStructure(and(or(and(city)))).ok).toBe(false);
  });

  test('rejects __proto__ keys, NUL in a value, a 100,000-character value and a 10,000-deep JSON nesting without throwing', () => {
    const deep = `${'['.repeat(10_000)}${']'.repeat(10_000)}`;
    const cases = [
      JSON.parse(
        '{"__proto__":{"x":1},"dimension":"c","op":"eq","values":[1]}'
      ),
      { dimension: 'c', op: 'eq', values: ['a\u0000b'] },
      { dimension: 'c', op: 'eq', values: ['a'.repeat(100_000)] },
      JSON.parse(deep),
    ];
    for (const hostile of cases) {
      expect(validateFilterStructure(hostile).ok).toBe(false);
    }
  });
});

describe('checkAudienceInput', () => {
  test('with schema null accepts an undeclared dimension but rejects a malformed tree', () => {
    expect(checkAudienceInput(input(city), null).ok).toBe(true);
    expect(checkAudienceInput(input({ op: 'and' }), null).ok).toBe(false);
  });

  test('with a schema rejects an undeclared dimension and the error text contains no input value', () => {
    const bad = { dimension: 'secret-dim', op: 'eq', values: ['v'] };
    const result = checkAudienceInput(input(bad), schema);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-dim');
  });
});

describe('zIdListChange', () => {
  test('rejects 2,001 ids, an empty id, a 257-character id and a non-string id', () => {
    for (const add of [ids(2001), [''], ['a'.repeat(257)], [1]]) {
      expect(zIdListChange.safeParse({ list: 'include', add }).success).toBe(
        false
      );
    }
    expect(
      zIdListChange.safeParse({ list: 'include', add: ids(2000) }).success
    ).toBe(true);
    expect(zIdListChange.safeParse({ list: 'include' }).success).toBe(false);
  });
});

describe('buildSourceFilter', () => {
  const notIn = (values: string[]): FilterTree => ({
    dimension: 'id',
    op: 'not_in',
    values,
  });

  test('appends not_in to a top-level and group (depth unchanged)', () => {
    expect(buildSourceFilter(and(city, or(city)), ['x'])).toEqual({
      filter: and(city, or(city), notIn(['x'])),
      pushedExcludes: true,
    });
  });

  test('wraps a lone condition into and (depth 2)', () => {
    expect(buildSourceFilter(city, ['x'])).toEqual({
      filter: and(city, notIn(['x'])),
      pushedExcludes: true,
    });
  });

  test('leaves a depth-3 or-rooted filter unchanged with pushedExcludes false', () => {
    const deep = or(and(city));
    expect(buildSourceFilter(deep, ['x'])).toEqual({
      filter: deep,
      pushedExcludes: false,
    });
  });

  test('with 1,001 excludes (given null) pushes nothing', () => {
    expect(buildSourceFilter(city, null).pushedExcludes).toBe(false);
    expect(buildSourceFilter(city, ids(1001)).pushedExcludes).toBe(false);
  });

  test('a filter already containing an id condition keeps it', () => {
    const own: FilterTree = { dimension: 'id', op: 'in', values: ['a'] };
    expect(buildSourceFilter(and(own), ['x']).filter).toEqual(
      and(own, notIn(['x']))
    );
  });
});
