import {
  ImportFileError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  readHeaders,
  type SheetRows,
} from './xlsx-reader';

const STATE_HEADER = 'state';
const BYTE_ORDER_MARK = '﻿';

function parseRecords(text: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  const endRecord = () => {
    record.push(field);
    field = '';
    records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') {
        i++;
      }
      endRecord();
    } else {
      field += char;
    }
  }
  if (inQuotes) {
    throw new ImportFileError('malformed_csv');
  }
  if (field !== '' || record.length > 0) {
    endRecord();
  }
  return records;
}

/**
 * One pseudo-sheet per distinct State value, in order of first appearance.
 * Rows whose State is empty come back as the sheet named '' with their true
 * rowNumbers, so the caller can report each one. `cells` has a null
 * prototype: read it with Object.hasOwn or Object.entries.
 */
export function readCsv(text: string): SheetRows[] {
  if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) {
    throw new ImportFileError('file_too_large');
  }
  const records = parseRecords(
    text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text
  );
  const [headerRecord, ...dataRecords] = records;
  const rawHeaders = (headerRecord ?? []).map((header) => header.trim());
  const stateColumn = rawHeaders.findIndex(
    (header) => header.toLowerCase() === STATE_HEADER
  );
  if (stateColumn === -1) {
    throw new ImportFileError('missing_column');
  }
  const headers = readHeaders(rawHeaders.entries());
  const sheets = new Map<string, SheetRows>();
  for (const [index, record] of dataRecords.entries()) {
    if (record.every((value) => value.trim() === '')) {
      continue;
    }
    const state = (record[stateColumn] ?? '').trim();
    let sheet = sheets.get(state);
    if (!sheet) {
      sheet = { sheet: state, rows: [] };
      sheets.set(state, sheet);
    }
    if (sheet.rows.length >= MAX_IMPORT_ROWS) {
      throw new ImportFileError('too_many_rows');
    }
    const cells: Record<string, string> = Object.create(null);
    for (const [column, header] of headers) {
      cells[header] = record[column] ?? '';
    }
    sheet.rows.push({ rowNumber: index + 2, cells });
  }
  return [...sheets.values()];
}
