import { describe, expect, test } from 'vitest';
import {
  canNest,
  chunkIds,
  coerceValue,
  depthOf,
  describeCount,
  emptyCondition,
  emptyGroup,
  filterProblems,
  nameProblems,
  normalizeFilter,
  OP_LABELS,
  opsFor,
  parseIdInput,
  removeNode,
  updateNode,
} from './audience-filter';
import {
  type Dimension,
  FILTER_OPS,
  type FilterGroup,
  type FilterTree,
} from './campaign-contract';

const dimension = (
  key: string,
  type: Dimension['type'],
  valuesListable = false
): Dimension => ({
  key,
  label: key,
  type,
  multiValued: false,
  valuesListable,
});

const dimensions = [
  dimension('city', 'string', true),
  dimension('semester', 'number'),
  dimension('signup', 'date'),
  dimension('active', 'boolean'),
];

const city = (values: string[]) => ({
  dimension: 'city',
  op: 'in' as const,
  values,
});

describe('emptyGroup and depthOf', () => {
  test('an empty group is an and group with no children', () => {
    expect(emptyGroup()).toEqual({ op: 'and', children: [] });
  });

  test('a condition is depth 1, an empty group 1, a group of conditions 2', () => {
    expect(depthOf(city(['Pune']))).toBe(1);
    expect(depthOf(emptyGroup())).toBe(1);
    expect(depthOf({ op: 'and', children: [city(['Pune'])] })).toBe(2);
    expect(
      depthOf({
        op: 'and',
        children: [{ op: 'or', children: [city(['Pune'])] }],
      })
    ).toBe(3);
  });
});

describe('canNest', () => {
  const tree: FilterGroup = {
    op: 'and',
    children: [city(['Pune']), { op: 'or', children: [city(['Goa'])] }],
  };

  test('the root may hold a sub-group', () => {
    expect(canNest(tree, [])).toBe(true);
  });

  test('a sub-group may not: its conditions would be past the depth limit', () => {
    expect(canNest(tree, [1])).toBe(false);
  });

  test('a condition path cannot hold a group', () => {
    expect(canNest(tree, [0])).toBe(false);
  });
});

describe('updateNode and removeNode', () => {
  const tree: FilterGroup = {
    op: 'and',
    children: [city(['Pune']), { op: 'or', children: [city(['Goa'])] }],
  };

  test('updates the node at a path without touching the original', () => {
    const next = updateNode(tree, [1, 0], () => city(['Delhi']));
    expect(next).toEqual({
      op: 'and',
      children: [city(['Pune']), { op: 'or', children: [city(['Delhi'])] }],
    });
    expect(tree.children[1]).toEqual({ op: 'or', children: [city(['Goa'])] });
  });

  test('removes the node at a path', () => {
    expect(removeNode(tree, [0])).toEqual({
      op: 'and',
      children: [{ op: 'or', children: [city(['Goa'])] }],
    });
  });
});

describe('opsFor and OP_LABELS', () => {
  test('per dimension type', () => {
    expect(opsFor(dimension('a', 'string'))).toEqual([
      'in',
      'not_in',
      'exists',
    ]);
    expect(opsFor(dimension('a', 'number'))).toEqual([
      'eq',
      'gt',
      'lt',
      'between',
      'exists',
    ]);
    expect(opsFor(dimension('a', 'date'))).toEqual([
      'eq',
      'gt',
      'lt',
      'between',
      'exists',
    ]);
    expect(opsFor(dimension('a', 'boolean'))).toEqual(['eq', 'exists']);
  });

  test('the reserved id dimension takes only in and not_in', () => {
    expect(opsFor(dimension('id', 'string'))).toEqual(['in', 'not_in']);
  });

  test('every operator has a label', () => {
    for (const op of FILTER_OPS) {
      expect(OP_LABELS[op]).toBeTruthy();
    }
    expect(OP_LABELS.in).toBe('is any of');
    expect(OP_LABELS.not_in).toBe('is not any of');
  });

  test('emptyCondition starts with the first allowed operator and no values', () => {
    expect(emptyCondition(dimension('semester', 'number'))).toEqual({
      dimension: 'semester',
      op: 'eq',
      values: [],
    });
  });
});

describe('coerceValue', () => {
  test('numbers become numbers, unparsable text stays text', () => {
    expect(coerceValue(dimension('a', 'number'), '7')).toBe(7);
    expect(coerceValue(dimension('a', 'number'), 'x')).toBe('x');
    expect(coerceValue(dimension('a', 'number'), ' ')).toBe(' ');
  });

  test('booleans become booleans', () => {
    expect(coerceValue(dimension('a', 'boolean'), 'true')).toBe(true);
    expect(coerceValue(dimension('a', 'boolean'), 'false')).toBe(false);
  });

  test('strings and dates stay as typed', () => {
    expect(coerceValue(dimension('a', 'string'), '7')).toBe('7');
    expect(coerceValue(dimension('a', 'date'), '2026-01-01')).toBe(
      '2026-01-01'
    );
  });
});

describe('filterProblems', () => {
  const problemsOf = (tree: FilterTree) => filterProblems(tree, dimensions);

  test('a valid tree has no problems', () => {
    expect(
      problemsOf({
        op: 'and',
        children: [
          city(['Pune']),
          { dimension: 'semester', op: 'between', values: [1, 4] },
          { dimension: 'signup', op: 'gt', values: ['2026-01-01'] },
          { dimension: 'active', op: 'eq', values: [true] },
          { dimension: 'city', op: 'exists', values: [] },
        ],
      })
    ).toEqual([]);
  });

  test('an unknown dimension', () => {
    expect(problemsOf({ dimension: 'gone', op: 'in', values: ['a'] })).toEqual([
      'A condition uses a field the audience API no longer offers',
    ]);
  });

  test('empty values', () => {
    expect(problemsOf(city([]))).toEqual(['city: pick at least one value']);
  });

  test('between without two values', () => {
    expect(
      problemsOf({ dimension: 'semester', op: 'between', values: [1] })
    ).toEqual(['semester: enter both ends of the range']);
  });

  test('exists with leftover values and a single-value operator with none', () => {
    expect(
      problemsOf({ dimension: 'city', op: 'exists', values: ['a'] })
    ).toEqual(['city: has a value takes no values']);
    expect(problemsOf({ dimension: 'semester', op: 'eq', values: [] })).toEqual(
      ['semester: enter one value']
    );
  });

  test('an operator the type does not allow', () => {
    expect(problemsOf({ dimension: 'city', op: 'gt', values: ['a'] })).toEqual([
      'city: "is more than" does not apply to this field',
    ]);
  });

  test('values of the wrong type', () => {
    expect(
      problemsOf({ dimension: 'semester', op: 'eq', values: ['x'] })
    ).toEqual(['semester: values must be numbers']);
    expect(
      problemsOf({ dimension: 'signup', op: 'eq', values: ['2026-13-40'] })
    ).toEqual(['signup: values must be dates']);
  });

  test('nesting past the depth limit', () => {
    const deep: FilterTree = {
      op: 'and',
      children: [
        { op: 'or', children: [{ op: 'and', children: [city(['a'])] }] },
      ],
    };
    expect(problemsOf(deep)).toContain('Groups are nested too deeply');
  });
});

describe('normalizeFilter', () => {
  test('nested empty groups become null', () => {
    expect(
      normalizeFilter({
        op: 'and',
        children: [
          { op: 'or', children: [] },
          { op: 'and', children: [] },
        ],
      })
    ).toBeNull();
  });

  test('empty groups are dropped, conditions kept', () => {
    expect(
      normalizeFilter({
        op: 'and',
        children: [city(['Pune']), { op: 'or', children: [] }],
      })
    ).toEqual({ op: 'and', children: [city(['Pune'])] });
  });

  test('null stays null', () => {
    expect(normalizeFilter(null)).toBeNull();
  });
});

describe('parseIdInput', () => {
  test('splits on newlines, commas and spaces, trims and de-duplicates in order', () => {
    expect(parseIdInput('a, b\n\na  c')).toEqual(['a', 'b', 'c']);
    expect(parseIdInput('b\na,b\t c')).toEqual(['b', 'a', 'c']);
    expect(parseIdInput('  \n ')).toEqual([]);
  });
});

describe('chunkIds', () => {
  test('4,500 ids become 2000, 2000 and 500', () => {
    const ids = Array.from({ length: 4500 }, (_, index) => `id${index}`);
    expect(chunkIds(ids, 2000).map((chunk) => chunk.length)).toEqual([
      2000, 2000, 500,
    ]);
  });

  test('no ids, no chunks', () => {
    expect(chunkIds([], 2000)).toEqual([]);
  });
});

describe('describeCount', () => {
  const count = {
    count: 12_345,
    approximate: false,
    countedAt: '2026-11-14T10:00:00.000Z',
    filterCount: 12_000,
    includeCount: 345,
    excludeCount: 0,
  };

  test('exact', () => {
    expect(describeCount(count)).toBe('12,345 students');
  });

  test('approximate', () => {
    expect(describeCount({ ...count, approximate: true })).toBe(
      'About 12,345 students'
    );
  });

  test('one student', () => {
    expect(describeCount({ ...count, count: 1 })).toBe('1 student');
  });
});

describe('fix round 1 edge cases', () => {
  test('removeNode with an empty path leaves the tree alone', () => {
    const tree: FilterGroup = { op: 'and', children: [city(['Pune'])] };
    expect(removeNode(tree, [])).toEqual(tree);
  });

  test('an impossible calendar date is not a date', () => {
    expect(
      filterProblems(
        { dimension: 'signup', op: 'eq', values: ['2024-02-30'] },
        dimensions
      )
    ).toEqual(['signup: values must be dates']);
  });

  test('a text value longer than 512 characters', () => {
    expect(filterProblems(city(['x'.repeat(513)]), dimensions)).toEqual([
      'city: a value is longer than 512 characters',
    ]);
  });

  test('the id dimension takes at most 1000 values and always strings', () => {
    const idDimension = dimension('id', 'number');
    const ids = Array.from({ length: 1001 }, (_, index) => `s${index}`);
    expect(
      filterProblems({ dimension: 'id', op: 'in', values: ids }, [idDimension])
    ).toEqual(['id: at most 1,000 values']);
    expect(coerceValue(idDimension, '42')).toBe('42');
  });

  test('audience names are required and at most 200 characters', () => {
    expect(nameProblems('  ')).toEqual(['Give the audience a name']);
    expect(nameProblems('x'.repeat(201))).toEqual([
      'The name is longer than 200 characters',
    ]);
    expect(nameProblems('Final year')).toEqual([]);
  });

  test('parseIdInput handles CRLF and input made only of separators', () => {
    expect(parseIdInput('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(parseIdInput(' ,\r\n, ')).toEqual([]);
  });
});
