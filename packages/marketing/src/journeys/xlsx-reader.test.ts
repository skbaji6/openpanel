import { describe, expect, it } from 'bun:test';
import { buildXlsx, buildZip } from './xlsx-fixture';
import { MAX_IMPORT_ROWS, readXlsx } from './xlsx-reader';

const HEADER = ['Name', 'Note'];

function codeOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('readXlsx', () => {
  it('reads sheets in workbook order with headers as keys', () => {
    const bytes = buildXlsx([
      {
        name: 'Second',
        rows: [
          [' Name ', 'Note'],
          ['a', 'b'],
        ],
      },
      { name: 'First', rows: [HEADER, ['c', 'd'], ['e', 'f']] },
    ]);
    const sheets = readXlsx(bytes);
    expect(sheets.map((s) => s.sheet)).toEqual(['Second', 'First']);
    expect(sheets[0]?.rows).toEqual([
      { rowNumber: 2, cells: { Name: 'a', Note: 'b' } },
    ]);
    expect(sheets[1]?.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it('reads inline and shared strings', () => {
    const sheets = readXlsx(
      buildXlsx([
        { name: 'Inline', rows: [HEADER, ['x', 'y']] },
        { name: 'Shared', rows: [HEADER, ['p', 'q']], shared: true },
      ])
    );
    expect(sheets[0]?.rows[0]?.cells).toEqual({ Name: 'x', Note: 'y' });
    expect(sheets[1]?.rows[0]?.cells).toEqual({ Name: 'p', Note: 'q' });
  });

  it('decodes &amp; and &#x0C30;', () => {
    const sheets = readXlsx(
      buildXlsx(
        [{ name: 'S', rows: [HEADER, ['a &amp; b', '&#x0C30;&#65;&amp;lt;']] }],
        { rawXml: true }
      )
    );
    expect(sheets[0]?.rows[0]?.cells).toEqual({
      Name: 'a & b',
      Note: 'రA&lt;',
    });
  });

  it('skips empty trailing rows', () => {
    const sheets = readXlsx(
      buildXlsx([{ name: 'S', rows: [HEADER, ['a', 'b'], ['', ''], ['', '']] }])
    );
    expect(sheets[0]?.rows).toHaveLength(1);
  });

  it('reads deflated entries', () => {
    const sheets = readXlsx(
      buildXlsx([{ name: 'S', rows: [HEADER, ['a', 'b']] }], { deflate: true })
    );
    expect(sheets[0]?.rows[0]?.cells.Name).toBe('a');
  });

  it('rejects a non-zip as not_xlsx', () => {
    expect(codeOf(() => readXlsx(new TextEncoder().encode('hello')))).toBe(
      'not_xlsx'
    );
    expect(codeOf(() => readXlsx(new Uint8Array(0)))).toBe('not_xlsx');
  });

  it('rejects a truncated or corrupt archive as not_xlsx', () => {
    const bytes = buildXlsx([{ name: 'S', rows: [HEADER, ['a', 'b']] }]);
    expect(codeOf(() => readXlsx(bytes.slice(0, bytes.length - 30)))).toBe(
      'not_xlsx'
    );
    const corrupt = bytes.slice();
    corrupt.fill(0xff, corrupt.length - 60, corrupt.length - 22);
    expect(codeOf(() => readXlsx(corrupt))).toBe('not_xlsx');
    expect(codeOf(() => readXlsx(buildZip([])))).toBe('not_xlsx');
  });

  it('rejects an entry that inflates past the limit', () => {
    const bomb = new Uint8Array(9 * 1024 * 1024);
    const honest = buildXlsx([{ name: 'S', rows: [HEADER] }], {
      deflate: true,
      sheetXml: bomb,
    });
    expect(codeOf(() => readXlsx(honest))).toBe('file_too_large');
    const lying = buildXlsx([{ name: 'S', rows: [HEADER] }], {
      deflate: true,
      sheetXml: bomb,
      declaredSheetSize: 10,
    });
    expect(codeOf(() => readXlsx(lying))).toBe('file_too_large');
  });

  it('rejects a file over the compressed limit', () => {
    expect(codeOf(() => readXlsx(new Uint8Array(512 * 1024 + 1)))).toBe(
      'file_too_large'
    );
  });

  it('rejects more than 2000 rows', () => {
    const rows = [
      ['Name'],
      ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ['x']),
    ];
    expect(codeOf(() => readXlsx(buildXlsx([{ name: 'S', rows }])))).toBe(
      'too_many_rows'
    );
  });

  it('refuses encrypted entries as not_xlsx', () => {
    const bytes = buildXlsx([{ name: 'S', rows: [HEADER, ['a', 'b']] }]);
    const view = new DataView(bytes.buffer);
    const centralStart = view.getUint32(bytes.length - 22 + 16, true);
    view.setUint16(centralStart + 8, 1, true);
    expect(codeOf(() => readXlsx(bytes))).toBe('not_xlsx');
  });
});
