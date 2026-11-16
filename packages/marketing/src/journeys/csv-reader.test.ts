import { describe, expect, it } from 'bun:test';
import { readCsv } from './csv-reader';

function codeOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('readCsv', () => {
  it('quoted commas and newlines survive', () => {
    const text = 'State,Text\r\nTS,"a, ""b""\nc"\r\n';
    const [sheet] = readCsv(text);
    expect(sheet?.rows).toEqual([
      { rowNumber: 2, cells: { State: 'TS', Text: 'a, "b"\nc' } },
    ]);
  });

  it('rows group by State into pseudo-sheets', () => {
    const sheets = readCsv('State,Text\nTS,1\nAP,2\nTS,3\n');
    expect(sheets.map((s) => s.sheet)).toEqual(['TS', 'AP']);
    expect(sheets[0]?.rows.map((r) => r.cells.Text)).toEqual(['1', '3']);
    expect(sheets[0]?.rows.map((r) => r.rowNumber)).toEqual([2, 4]);
  });

  it('a missing State column is reported as missing_column', () => {
    expect(codeOf(() => readCsv('Name,Text\na,b\n'))).toBe('missing_column');
    expect(codeOf(() => readCsv(''))).toBe('missing_column');
  });

  it('rejects more than 2000 rows in one state', () => {
    const text = `State\n${'TS\n'.repeat(2001)}`;
    expect(codeOf(() => readCsv(text))).toBe('too_many_rows');
  });

  it('rejects more than the column limit', () => {
    const headers = [
      'State',
      ...Array.from({ length: 200 }, (_, i) => `h${i}`),
    ];
    expect(codeOf(() => readCsv(`${headers.join(',')}\nTS\n`))).toBe(
      'file_too_large'
    );
  });

  it('rows with an empty State come back as the sheet named empty string', () => {
    const sheets = readCsv('State,Text\nTS,1\n,2\n  ,3\n');
    expect(sheets.map((s) => s.sheet)).toEqual(['TS', '']);
    expect(sheets[1]?.rows.map((r) => r.rowNumber)).toEqual([3, 4]);
  });

  it('an unterminated quote is malformed_csv', () => {
    expect(codeOf(() => readCsv('State,Text\nTS,"oops\nAP,2\n'))).toBe(
      'malformed_csv'
    );
  });

  it('rejects oversized text', () => {
    expect(codeOf(() => readCsv(`State\n${'x'.repeat(512 * 1024)}`))).toBe(
      'file_too_large'
    );
  });
});
