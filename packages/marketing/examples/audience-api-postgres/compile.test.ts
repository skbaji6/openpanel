import { describe, expect, it } from 'bun:test';
import type { FilterTree } from '../../src/audience/contract';
import { compileFilter } from './compile';
import { parseMapping } from './mapping';
import example from './mapping.example.json';

const mapping = parseMapping(example);
const cond = (
  dimension: string,
  op: 'eq' | 'in' | 'not_in' | 'gt' | 'lt' | 'between' | 'exists',
  values: (string | number)[] = []
): FilterTree => ({ dimension, op, values });

describe('compileFilter', () => {
  it('eq becomes a bound parameter', () => {
    const { sql, params } = compileFilter(
      cond('university', 'eq', ['u1']),
      mapping
    );
    expect(sql).toBe('(s."university_id" = $1)');
    expect(params).toEqual(['u1']);
  });

  it('in with three values binds three params', () => {
    const { sql, params } = compileFilter(
      cond('university', 'in', ['a', 'b', 'c']),
      mapping
    );
    expect(sql).toContain('IN ($1, $2, $3)');
    expect(params).toEqual(['a', 'b', 'c']);
  });

  it('a value containing a quote or semicolon only appears in params', () => {
    const evil = "x'; DROP TABLE students; --";
    const { sql, params } = compileFilter(
      cond('university', 'eq', [evil]),
      mapping
    );
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain("'x");
    expect(params).toEqual([evil]);
  });

  it('not_in', () => {
    const { sql } = compileFilter(cond('university', 'not_in', ['a']), mapping);
    expect(sql).toContain('NOT IN ($1)');
  });

  it('between', () => {
    const { sql, params } = compileFilter(
      cond('semester', 'between', [2, 4]),
      mapping
    );
    expect(sql).toBe('(s."semester" BETWEEN $1::numeric AND $2::numeric)');
    expect(params).toEqual([2, 4]);
  });

  it('exists', () => {
    const { sql, params } = compileFilter(cond('joined', 'exists'), mapping);
    expect(sql).toBe('(s."joined_on" IS NOT NULL)');
    expect(params).toEqual([]);
  });

  it('nested AND/OR groups keep precedence with parentheses', () => {
    const { sql } = compileFilter(
      {
        op: 'or',
        children: [
          cond('university', 'eq', ['u1']),
          {
            op: 'and',
            children: [
              cond('semester', 'gt', [2]),
              cond('university', 'eq', ['u2']),
            ],
          },
        ],
      },
      mapping
    );
    expect(sql).toBe(
      '((s."university_id" = $1) OR ((s."semester" > $2::numeric) AND (s."university_id" = $3)))'
    );
  });

  it('an unknown dimension throws', () => {
    expect(() =>
      compileFilter(cond('password_hash', 'eq', ['x']), mapping)
    ).toThrow('unknown dimension');
  });

  it('a multi-valued course dimension uses EXISTS and yields one row per student', () => {
    const { sql, params } = compileFilter(
      cond('course', 'in', ['c1', 'c3']),
      mapping
    );
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM "reference_demo"."student_courses" x'
    );
    expect(sql).not.toContain('JOIN');
    expect(params).toEqual(['c1', 'c3']);
  });

  it('state dimension compiles to a bound eq on the state column', () => {
    const { sql, params } = compileFilter(cond('state', 'eq', ['TS']), mapping);
    expect(sql).toBe('(s."state" = $1)');
    expect(params).toEqual(['TS']);
  });

  it('rejects unsafe identifiers at startup', () => {
    expect(() =>
      parseMapping({ ...example, idColumn: 'id"; DROP TABLE x; --' })
    ).toThrow('invalid audience mapping');
  });

  it('rejects comment and statement markers in an expression', () => {
    for (const expression of ['1 -- x', '1 /* x */', '1; select 2']) {
      expect(() =>
        parseMapping({
          ...example,
          dimensions: [
            { key: 'bad', label: 'Bad', type: 'string', expression },
          ],
        })
      ).toThrow('invalid audience mapping');
    }
  });
});
