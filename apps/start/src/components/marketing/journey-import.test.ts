import { describe, expect, test } from 'vitest';
import type { ImportReport } from './contract';
import {
  defaultStateMapping,
  fileToBase64,
  formatOf,
  labelImportProblem,
  summarizeImport,
} from './journey-import';

const PROBLEM_CODES = [
  'unknown_sheet',
  'sheet_ignored',
  'missing_column',
  'empty_message',
  'unknown_platform',
  'unparsed_timing',
  'conditional_timing',
  'duplicate_timing',
  'message_too_long',
  'too_many_steps',
  'definition_too_large',
];

const journey = (key: string, action: string) => ({
  key,
  name: key,
  action,
  ruleId: null,
  steps: 1,
  variants: [],
  unconfirmed: [],
});

describe('journey import helpers', () => {
  test('xlsx and csv names are recognised and others are null', () => {
    expect(formatOf('Journeys.XLSX')).toBe('xlsx');
    expect(formatOf('journeys.csv')).toBe('csv');
    expect(formatOf('journeys.xls')).toBeNull();
    expect(formatOf('xlsx')).toBeNull();
  });

  test('bytes become base64, including large inputs', () => {
    expect(fileToBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
    const big = new Uint8Array(512 * 1024).fill(255);
    expect(fileToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });

  test('Telangana maps to the state labelled Telangana', () => {
    const mapping = defaultStateMapping(
      ['telangana', 'Other'],
      [
        { value: 'TS', label: 'Telangana' },
        { value: 'AP', label: 'Andhra Pradesh' },
      ]
    );
    expect(mapping).toEqual({ telangana: 'TS' });
  });

  test('summary groups problems by sheet with labels', () => {
    const report: ImportReport = {
      sheets: ['A'],
      journeys: [
        journey('a', 'created'),
        journey('b', 'updated'),
        journey('c', 'unchanged'),
        journey('d', 'skipped_live'),
        journey('e', 'skipped_edited'),
      ],
      problems: [
        { sheet: 'A', row: 3, code: 'conditional_timing' },
        { sheet: 'A', row: null, code: 'sheet_ignored' },
        { sheet: 'B', row: 9, code: 'zzz_new' },
      ],
    };
    const summary = summarizeImport(report);
    expect(summary).toMatchObject({
      created: 1,
      updated: 1,
      unchanged: 1,
      skippedLive: ['d'],
      skippedEdited: ['e'],
    });
    expect(summary.problemsBySheet.A).toEqual([
      { row: 3, label: labelImportProblem('conditional_timing') },
      { row: null, label: labelImportProblem('sheet_ignored') },
    ]);
    expect(summary.problemsBySheet.B?.[0]?.label).toBe('zzz_new');
  });

  test('every ImportProblem code has a label', () => {
    for (const code of PROBLEM_CODES) {
      expect(labelImportProblem(code), code).not.toBe(code);
    }
    expect(labelImportProblem('conditional_timing')).toBe(
      'Depends on something the student does next; not a timed step. Add it by hand if needed.'
    );
  });
});
