import { inflateRawSync } from 'node:zlib';

export const MAX_IMPORT_BYTES = 512 * 1024;
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;

export type ImportFileErrorCode =
  | 'not_xlsx'
  | 'file_too_large'
  | 'too_many_rows'
  | 'missing_column';

// The message is the code only: uploaded cell text must never reach logs.
export class ImportFileError extends Error {
  readonly code: ImportFileErrorCode;
  constructor(code: ImportFileErrorCode) {
    super(code);
    this.name = 'ImportFileError';
    this.code = code;
  }
}

export type SheetRows = {
  sheet: string;
  rows: { rowNumber: number; cells: Record<string, string> }[];
};

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
const EOCD_SIZE = 22;
const MAX_COMMENT_BYTES = 0xff_ff;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const ZIP64_MARKER_16 = 0xff_ff;
const ZIP64_MARKER_32 = 0xff_ff_ff_ff;
const ENCRYPTED_FLAG = 0x1;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const MAX_CODE_POINT = 0x10_ff_ff;
const REPLACEMENT_CHARACTER = '�';
const LETTERS_IN_ALPHABET = 26;
const FIRST_LETTER_CODE = 64;

type ZipEntry = {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

type ZipArchive = {
  bytes: Uint8Array;
  view: DataView;
  entries: Map<string, ZipEntry>;
  inflatedTotal: number;
};

const decoder = new TextDecoder('utf-8');

function findEndOfDirectory(view: DataView) {
  const lowest = Math.max(0, view.byteLength - EOCD_SIZE - MAX_COMMENT_BYTES);
  for (let at = view.byteLength - EOCD_SIZE; at >= lowest; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      return at;
    }
  }
  throw new ImportFileError('not_xlsx');
}

function openArchive(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfDirectory(view);
  const diskNumber = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const isMultiDisk = diskNumber !== 0 || directoryDisk !== 0;
  const isZip64 =
    entryCount === ZIP64_MARKER_16 || directoryOffset === ZIP64_MARKER_32;
  if (isMultiDisk || isZip64 || entryCount === 0) {
    throw new ImportFileError('not_xlsx');
  }
  const entries = new Map<string, ZipEntry>();
  let at = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (
      at + CENTRAL_HEADER_SIZE > view.byteLength ||
      view.getUint32(at, true) !== CENTRAL_SIGNATURE
    ) {
      throw new ImportFileError('not_xlsx');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const nameStart = at + CENTRAL_HEADER_SIZE;
    const isUnsupported =
      flags % 2 === ENCRYPTED_FLAG ||
      compressedSize === ZIP64_MARKER_32 ||
      uncompressedSize === ZIP64_MARKER_32 ||
      localOffset === ZIP64_MARKER_32;
    if (isUnsupported || nameStart + nameLength > view.byteLength) {
      throw new ImportFileError('not_xlsx');
    }
    const name = decoder.decode(
      bytes.subarray(nameStart, nameStart + nameLength)
    );
    // First entry wins so a duplicate cannot shadow the one a reader saw first.
    if (!entries.has(name)) {
      entries.set(name, {
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      });
    }
    at = nameStart + nameLength + extraLength + commentLength;
  }
  return { bytes, view, entries, inflatedTotal: 0 };
}

function readEntry(archive: ZipArchive, name: string): string | undefined {
  const entry = archive.entries.get(name);
  if (!entry) {
    return undefined;
  }
  const remaining = MAX_INFLATED_BYTES - archive.inflatedTotal;
  if (entry.uncompressedSize > remaining) {
    throw new ImportFileError('file_too_large');
  }
  const { view, bytes } = archive;
  const local = entry.localOffset;
  if (
    local + LOCAL_HEADER_SIZE > view.byteLength ||
    view.getUint32(local, true) !== LOCAL_SIGNATURE
  ) {
    throw new ImportFileError('not_xlsx');
  }
  const dataStart =
    local +
    LOCAL_HEADER_SIZE +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > view.byteLength) {
    throw new ImportFileError('not_xlsx');
  }
  const raw = bytes.subarray(dataStart, dataEnd);
  let data: Uint8Array;
  if (entry.method === METHOD_STORED) {
    data = raw;
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(remaining, 1) });
    } catch (error) {
      const isOverflow =
        (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
      throw new ImportFileError(isOverflow ? 'file_too_large' : 'not_xlsx');
    }
  } else {
    throw new ImportFileError('not_xlsx');
  }
  if (data.length !== entry.uncompressedSize) {
    throw new ImportFileError('not_xlsx');
  }
  archive.inflatedTotal += data.length;
  return decoder.decode(data);
}

// Single pass over the five entities and numeric references, so output is never rescanned.
function decodeXml(text: string) {
  return text.replace(
    /&(#x[0-9a-fA-F]{1,8}|#[0-9]{1,8}|amp|lt|gt|quot|apos);/g,
    (_, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default: {
          const isHex = entity[1] === 'x' || entity[1] === 'X';
          const codePoint = Number.parseInt(
            entity.slice(isHex ? 2 : 1),
            isHex ? 16 : 10
          );
          const isValid =
            codePoint > 0 &&
            codePoint <= MAX_CODE_POINT &&
            !(codePoint >= 0xd8_00 && codePoint <= 0xdf_ff);
          return isValid
            ? String.fromCodePoint(codePoint)
            : REPLACEMENT_CHARACTER;
        }
      }
    }
  );
}

function attributes(source: string) {
  const found = new Map<string, string>();
  for (const match of source.matchAll(
    /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  )) {
    const key = match[1];
    if (key !== undefined && !found.has(key)) {
      found.set(key, decodeXml(match[2] ?? match[3] ?? ''));
    }
  }
  return found;
}

function textRuns(xml: string) {
  let out = '';
  for (const match of xml.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    out += decodeXml(match[1] ?? '');
  }
  return out;
}

function readSharedStrings(xml: string | undefined) {
  if (xml === undefined) {
    return [];
  }
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  return [
    ...withoutPhonetic.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g),
  ].map((match) => textRuns(match[1] ?? ''));
}

function resolveTarget(target: string) {
  const parts = (target.startsWith('/') ? target.slice(1) : `xl/${target}`)
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

function columnIndex(reference: string | undefined) {
  const letters = /^[A-Za-z]+/.exec(reference ?? '')?.[0];
  if (!letters) {
    return undefined;
  }
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index =
      index * LETTERS_IN_ALPHABET + (letter.charCodeAt(0) - FIRST_LETTER_CODE);
  }
  return index;
}

function cellText(
  attrs: Map<string, string>,
  inner: string,
  sharedStrings: string[]
) {
  const type = attrs.get('t');
  if (type === 'inlineStr') {
    return textRuns(inner);
  }
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (value === undefined) {
    return '';
  }
  if (type === 's') {
    return sharedStrings[Number.parseInt(value, 10)] ?? '';
  }
  return decodeXml(value);
}

// defineProperty keeps a header named __proto__ an ordinary own key.
export function setCell(
  cells: Record<string, string>,
  header: string,
  value: string
) {
  Object.defineProperty(cells, header, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function parseSheet(xml: string, sharedStrings: string[]): SheetRows['rows'] {
  const parsed: { rowNumber: number; columns: Map<number, string> }[] = [];
  let previousRow = 0;
  for (const rowMatch of xml.matchAll(
    /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
  )) {
    const rowAttrs = attributes(rowMatch[1] ?? '');
    const declared = Number.parseInt(rowAttrs.get('r') ?? '', 10);
    const rowNumber = Number.isFinite(declared) ? declared : previousRow + 1;
    previousRow = rowNumber;
    const columns = new Map<number, string>();
    let nextColumn = 1;
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    )) {
      const cellAttrs = attributes(cellMatch[1] ?? '');
      const column = columnIndex(cellAttrs.get('r')) ?? nextColumn;
      nextColumn = column + 1;
      columns.set(
        column,
        cellText(cellAttrs, cellMatch[2] ?? '', sharedStrings)
      );
    }
    const isEmpty = [...columns.values()].every((value) => value.trim() === '');
    if (isEmpty) {
      continue;
    }
    // Header row is not counted against the data-row limit.
    if (parsed.length > MAX_IMPORT_ROWS) {
      throw new ImportFileError('too_many_rows');
    }
    parsed.push({ rowNumber, columns });
  }
  const [headerRow, ...dataRows] = parsed;
  if (!headerRow) {
    return [];
  }
  const headers = new Map<number, string>();
  for (const [column, value] of headerRow.columns) {
    const header = value.trim();
    if (header !== '' && ![...headers.values()].includes(header)) {
      headers.set(column, header);
    }
  }
  return dataRows.map(({ rowNumber, columns }) => {
    const cells: Record<string, string> = {};
    for (const [column, header] of headers) {
      setCell(cells, header, columns.get(column) ?? '');
    }
    return { rowNumber, cells };
  });
}

function readWorkbook(bytes: Uint8Array): SheetRows[] {
  if (bytes.length > MAX_IMPORT_BYTES) {
    throw new ImportFileError('file_too_large');
  }
  const archive = openArchive(bytes);
  const workbook = readEntry(archive, 'xl/workbook.xml');
  const rels = readEntry(archive, 'xl/_rels/workbook.xml.rels');
  if (workbook === undefined || rels === undefined) {
    throw new ImportFileError('not_xlsx');
  }
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = attributes(match[1] ?? '');
    const id = attrs.get('Id');
    const target = attrs.get('Target');
    if (id !== undefined && target !== undefined) {
      targets.set(id, resolveTarget(target));
    }
  }
  const sharedStrings = readSharedStrings(
    readEntry(archive, 'xl/sharedStrings.xml')
  );
  const sheets: SheetRows[] = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = attributes(match[1] ?? '');
    const name = attrs.get('name');
    const path = targets.get(attrs.get('r:id') ?? '');
    const xml = path === undefined ? undefined : readEntry(archive, path);
    if (name === undefined || xml === undefined) {
      throw new ImportFileError('not_xlsx');
    }
    sheets.push({ sheet: name, rows: parseSheet(xml, sharedStrings) });
  }
  if (sheets.length === 0) {
    throw new ImportFileError('not_xlsx');
  }
  return sheets;
}

export function readXlsx(bytes: Uint8Array): SheetRows[] {
  try {
    return readWorkbook(bytes);
  } catch (error) {
    if (error instanceof ImportFileError) {
      throw error;
    }
    throw new ImportFileError('not_xlsx');
  }
}
