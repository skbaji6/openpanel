import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import dataset from './dataset.json';
import expected from './expected.json';
import { buildDataset, buildExpected, renderSeedSql } from './generate';

const read = (name: string) =>
  readFileSync(new URL(name, import.meta.url), 'utf8');

function insertedRows(sql: string, table: string): number {
  const start = sql.indexOf(`INSERT INTO conformance_demo.${table} (`);
  const block = sql.slice(start, sql.indexOf(';\n', start));
  return block.split('\n').filter((line) => line.startsWith('  (')).length;
}

describe('seed contract', () => {
  it('dataset.json, seed.sql and expected.json are what generate.ts produces', () => {
    const data = buildDataset();
    expect(data).toEqual(dataset as typeof data);
    expect(read('seed.sql')).toBe(renderSeedSql(data));
    expect(expected).toEqual(JSON.parse(JSON.stringify(buildExpected(data))));
  });

  it('seed.sql inserts as many rows as dataset.json holds', () => {
    const sql = read('seed.sql');
    for (const table of [
      'universities',
      'courses',
      'semesters',
      'students',
      'enrollments',
      'devices',
      'purchases',
    ] as const) {
      expect(insertedRows(sql, table)).toBe(dataset[table].length);
    }
  });

  it('covers the cases the suite relies on', () => {
    const live = dataset.students.filter((s) => !s.suppressed);
    expect(dataset.students).toHaveLength(120);
    expect(live.length).toBeLessThan(dataset.students.length);
    expect(live.some((s) => s.phone === null)).toBe(true);
    expect(live.some((s) => s.email === null)).toBe(true);
    expect(live.some((s) => s.semesterId === null)).toBe(true);
    expect(dataset.enrollments.length).toBeGreaterThan(2);
    const all = expected.counts.find((c) => c.name === 'all');
    expect(all?.count).toBe(live.length);
    const statuses = new Set(
      expected.lookups.flatMap((l) => l.entries.map((e) => e.status))
    );
    expect([...statuses].sort()).toEqual([
      'not_found',
      'ok',
      'suppressed',
      'unreachable',
    ]);
    for (const run of expected.pages) {
      const count = expected.counts.find((c) => c.name === run.name)?.count;
      expect(run.pages.flat()).toHaveLength(count ?? -1);
    }
  });
});
