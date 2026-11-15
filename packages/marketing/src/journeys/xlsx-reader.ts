import { inflateRawSync } from 'node:zlib';

export const MAX_IMPORT_BYTES = 512 * 1024;
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_COLUMNS = 200;

export type ImportFileErrorCode =
  | 'not_xlsx'
  | 'file_too_large'
  | 'too_many_rows'
  | 'missing_column'
  | 'malformed_csv';

// The message is the code only: uploaded cell text must never reach logs.
export class ImportFileError extends Error {
  readonly code: ImportFileErrorCode;
  constructor(code: ImportFileErrorCode) {
    super(code);
    this.name = 'ImportFileError';
    this.code = code;
  }
}

// cells has a null prototype: read it with Object.hasOwn or Object.entries.
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

const WHITESPACE_AFTER_TAG = new Set([' ', '\t', '\n', '\r']);

type XmlElement = { attrs: string; inner: string | undefined };

function isTagAt(xml: string, start: number, tag: string) {
  if (!xml.startsWith(tag, start + 1)) {
    return false;
  }
  const next = xml[start + 1 + tag.length];
  return (
    next === '>' ||
    next === '/' ||
    (next !== undefined && WHITESPACE_AFTER_TAG.has(next))
  );
}

function skipPast(xml: string, from: number, closeTag: string) {
  const close = xml.indexOf(closeTag, from);
  if (close === -1) {
    throw new ImportFileError('not_xlsx');
  }
  return close + closeTag.length;
}

// One forward pass over untrusted XML: a missing close tag or an unterminated
// tag is malformed input and is never rescanned, so cost stays linear.
function* elements(
  xml: string,
  tag: string,
  skipTag?: string
): Generator<XmlElement> {
  const closeTag = `</${tag}>`;
  let position = 0;
  while (position < xml.length) {
    const start = xml.indexOf('<', position);
    if (start === -1) {
      return;
    }
    if (skipTag !== undefined && isTagAt(xml, start, skipTag)) {
      position = skipPast(xml, start, `</${skipTag}>`);
      continue;
    }
    if (!isTagAt(xml, start, tag)) {
      position = start + 1;
      continue;
    }
    const end = xml.indexOf('>', start);
    if (end === -1) {
      throw new ImportFileError('not_xlsx');
    }
    const isSelfClosing = xml[end - 1] === '/';
    const attrs = xml.slice(
      start + 1 + tag.length,
      isSelfClosing ? end - 1 : end
    );
    if (isSelfClosing) {
      yield { attrs, inner: undefined };
      position = end + 1;
      continue;
    }
    const close = skipPast(xml, end + 1, closeTag);
    yield { attrs, inner: xml.slice(end + 1, close - closeTag.length) };
    position = close;
  }
}

function textRuns(xml: string) {
  let out = '';
  for (const run of elements(xml, 't', 'rPh')) {
    out += decodeXml(run.inner ?? '');
  }
  return out;
}

function readSharedStrings(xml: string | undefined) {
  if (xml === undefined) {
    return [];
  }
  const strings: string[] = [];
  for (const item of elements(xml, 'si')) {
    strings.push(textRuns(item.inner ?? ''));
  }
  return strings;
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
  let value: string | undefined;
  for (const element of elements(inner, 'v')) {
    value = element.inner ?? '';
    break;
  }
  if (value === undefined) {
    return '';
  }
  if (type === 's') {
    return sharedStrings[Number.parseInt(value, 10)] ?? '';
  }
  return decodeXml(value);
}

// Header text (trimmed) by column. Checked before any row object is built.
export function readHeaders(raw: Iterable<[number, string]>) {
  const headers = new Map<number, string>();
  const seen = new Set<string>();
  let nonEmpty = 0;
  for (const [column, value] of raw) {
    const header = value.trim();
    if (header === '') {
      continue;
    }
    nonEmpty++;
    if (nonEmpty > MAX_IMPORT_COLUMNS) {
      throw new ImportFileError('file_too_large');
    }
    if (!seen.has(header)) {
      seen.add(header);
      headers.set(column, header);
    }
  }
  return headers;
}

function parseSheet(xml: string, sharedStrings: string[]): SheetRows['rows'] {
  const rows: SheetRows['rows'] = [];
  let headers: Map<number, string> | undefined;
  let previousRow = 0;
  for (const row of elements(xml, 'row')) {
    const declared = Number.parseInt(attributes(row.attrs).get('r') ?? '', 10);
    const rowNumber = Number.isFinite(declared) ? declared : previousRow + 1;
    previousRow = rowNumber;
    const columns = new Map<number, string>();
    let nextColumn = 1;
    for (const cell of elements(row.inner ?? '', 'c')) {
      const cellAttrs = attributes(cell.attrs);
      const column = columnIndex(cellAttrs.get('r')) ?? nextColumn;
      nextColumn = column + 1;
      columns.set(column, cellText(cellAttrs, cell.inner ?? '', sharedStrings));
    }
    if ([...columns.values()].every((value) => value.trim() === '')) {
      continue;
    }
    if (!headers) {
      headers = readHeaders(columns);
      continue;
    }
    if (rows.length >= MAX_IMPORT_ROWS) {
      throw new ImportFileError('too_many_rows');
    }
    const cells: Record<string, string> = Object.create(null);
    for (const [column, header] of headers) {
      cells[header] = columns.get(column) ?? '';
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
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
  for (const element of elements(rels, 'Relationship')) {
    const attrs = attributes(element.attrs);
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
  for (const element of elements(workbook, 'sheet')) {
    const attrs = attributes(element.attrs);
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
