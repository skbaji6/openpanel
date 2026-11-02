import { describe, expect, test } from 'bun:test';
import type { Schema } from './contract';
import { normalizeResolveInputs, validateFilter } from './filter';

const schema: Schema = {
  dimensions: [
    {
      key: 'grade',
      label: 'Grade',
      type: 'number',
      multiValued: false,
      valuesListable: false,
    },
    {
      key: 'city',
      label: 'City',
      type: 'string',
      multiValued: false,
      valuesListable: true,
    },
    {
      key: 'joined',
      label: 'Joined',
      type: 'date',
      multiValued: false,
      valuesListable: false,
    },
    {
      key: 'paid',
      label: 'Paid',
      type: 'boolean',
      multiValued: false,
      valuesListable: false,
    },
  ],
};

const cond = (dimension: string, op: string, values: unknown[]) => ({
  dimension,
  op,
  values,
});
const group = (op: 'and' | 'or', ...children: unknown[]) => ({ op, children });
const errorsOf = (filter: unknown) => {
  const result = validateFilter(filter, schema);
  return result.ok ? [] : result.errors;
};

describe('validateFilter', () => {
  test('accepts depth 3', () => {
    const filter = group('and', group('or', cond('city', 'eq', ['Pune'])));
    expect(validateFilter(filter, schema).ok).toBe(true);
  });

  test('rejects depth 4', () => {
    const filter = group(
      'and',
      group('or', group('and', cond('city', 'eq', ['Pune'])))
    );
    expect(errorsOf(filter).length).toBeGreaterThan(0);
  });

  test('accepts a lone condition', () => {
    expect(validateFilter(cond('grade', 'gt', [5]), schema).ok).toBe(true);
  });

  test('rejects an empty group', () => {
    expect(errorsOf(group('and')).length).toBeGreaterThan(0);
  });

  test('rejects a dimension the schema does not declare', () => {
    const errors = errorsOf(cond('secretdim', 'eq', ['x']));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).not.toContain('secretdim');
  });

  test('allows the reserved id dimension only with in and not_in', () => {
    expect(validateFilter(cond('id', 'in', ['a', 'b']), schema).ok).toBe(true);
    expect(validateFilter(cond('id', 'not_in', ['a']), schema).ok).toBe(true);
    expect(errorsOf(cond('id', 'eq', ['a'])).length).toBeGreaterThan(0);
    expect(errorsOf(cond('id', 'exists', [])).length).toBeGreaterThan(0);
  });

  test('rejects an id condition with 1001 values', () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id${i}`);
    expect(errorsOf(cond('id', 'in', ids)).length).toBeGreaterThan(0);
    expect(
      validateFilter(cond('id', 'in', ids.slice(0, 1000)), schema).ok
    ).toBe(true);
  });

  test('between needs exactly two values', () => {
    expect(validateFilter(cond('grade', 'between', [1, 5]), schema).ok).toBe(
      true
    );
    expect(errorsOf(cond('grade', 'between', [1])).length).toBeGreaterThan(0);
    expect(
      errorsOf(cond('grade', 'between', [1, 2, 3])).length
    ).toBeGreaterThan(0);
  });

  test('exists takes no values', () => {
    expect(validateFilter(cond('city', 'exists', []), schema).ok).toBe(true);
    expect(errorsOf(cond('city', 'exists', ['x'])).length).toBeGreaterThan(0);
  });

  test('rejects a string value for a number dimension', () => {
    expect(errorsOf(cond('grade', 'eq', ['5'])).length).toBeGreaterThan(0);
  });

  test('never echoes a user-supplied value', () => {
    const errors = errorsOf(cond('grade', 'eq', ['LEAKED-VALUE']));
    expect(errors.join(' ')).not.toContain('LEAKED-VALUE');
  });

  test('date dimension needs ISO dates', () => {
    expect(
      validateFilter(
        cond('joined', 'between', ['2026-01-01', '2026-02-01']),
        schema
      ).ok
    ).toBe(true);
    expect(
      errorsOf(cond('joined', 'gt', ['2026-13-45'])).length
    ).toBeGreaterThan(0);
    expect(
      errorsOf(cond('joined', 'gt', ['yesterday'])).length
    ).toBeGreaterThan(0);
  });

  test('boolean dimension needs booleans and rejects gt', () => {
    expect(validateFilter(cond('paid', 'eq', [true]), schema).ok).toBe(true);
    expect(errorsOf(cond('paid', 'eq', ['true'])).length).toBeGreaterThan(0);
    expect(errorsOf(cond('paid', 'gt', [true])).length).toBeGreaterThan(0);
  });

  test('gt and lt take exactly one value and not on strings', () => {
    expect(errorsOf(cond('grade', 'lt', [1, 2])).length).toBeGreaterThan(0);
    expect(errorsOf(cond('city', 'gt', ['a'])).length).toBeGreaterThan(0);
  });

  test('eq takes exactly one value, in at least one', () => {
    expect(errorsOf(cond('city', 'eq', ['a', 'b'])).length).toBeGreaterThan(0);
    expect(errorsOf(cond('city', 'in', [])).length).toBeGreaterThan(0);
  });

  test('rejects non-filter input', () => {
    expect(errorsOf('nope').length).toBeGreaterThan(0);
    expect(errorsOf(null).length).toBeGreaterThan(0);
  });
});

describe('normalizeResolveInputs', () => {
  test('removes blanks and duplicates', () => {
    expect(normalizeResolveInputs([' a ', '', 'b', 'a', '  '])).toEqual({
      inputs: ['a', 'b'],
      errors: [],
    });
  });

  test('rejects 201 inputs and the error text contains none of them', () => {
    const raw = Array.from({ length: 201 }, (_, i) => `secret-input-${i}`);
    const result = normalizeResolveInputs(raw);
    expect(result.inputs).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).not.toContain('secret-input');
  });

  test('accepts exactly 200', () => {
    const raw = Array.from({ length: 200 }, (_, i) => `i${i}`);
    expect(normalizeResolveInputs(raw).inputs).toHaveLength(200);
  });
});
