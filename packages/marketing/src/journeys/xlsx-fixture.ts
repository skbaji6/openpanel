import { deflateRawSync } from 'node:zlib';

export type FixtureSheet = {
  name: string;
  rows: string[][];
  shared?: boolean;
};

type ZipEntry = {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
  declaredSize?: number;
};

type XlsxOptions = {
  deflate?: boolean;
  rawXml?: boolean;
  sheetXml?: Uint8Array;
  declaredSheetSize?: number;
  sharedStringsXml?: string;
};

const encoder = new TextEncoder();
const ZIP_VERSION = 20;
const DOS_DATE_1980 = 0x21;

function escapeXml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const method = entry.deflate ? 8 : 0;
    const stored = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const crc = Bun.hash.crc32(entry.data);
    const uncompressed = entry.declaredSize ?? entry.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04_03_4b_50, true);
    local.setUint16(4, ZIP_VERSION, true);
    local.setUint16(8, method, true);
    local.setUint16(12, DOS_DATE_1980, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, stored.length, true);
    local.setUint32(22, uncompressed, true);
    local.setUint16(26, name.length, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02_01_4b_50, true);
    header.setUint16(4, ZIP_VERSION, true);
    header.setUint16(6, ZIP_VERSION, true);
    header.setUint16(10, method, true);
    header.setUint16(14, DOS_DATE_1980, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, stored.length, true);
    header.setUint32(24, uncompressed, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, stored);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + stored.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06_05_4b_50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return concat([...chunks, ...central, new Uint8Array(end.buffer)]);
}

function columnLetter(index: number) {
  const letters = 26;
  let rest = index + 1;
  let name = '';
  while (rest > 0) {
    name = String.fromCharCode(65 + ((rest - 1) % letters)) + name;
    rest = Math.floor((rest - 1) / letters);
  }
  return name;
}

export function buildXlsx(
  sheets: FixtureSheet[],
  options: XlsxOptions = {}
): Uint8Array {
  const text = (value: string) => (options.rawXml ? value : escapeXml(value));
  const sharedStrings: string[] = [];
  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, col) => {
            const ref = `${columnLetter(col)}${rowIndex + 1}`;
            if (value === '') {
              return `<c r="${ref}"/>`;
            }
            if (sheet.shared) {
              sharedStrings.push(value);
              return `<c r="${ref}" t="s"><v>${sharedStrings.length - 1}</v></c>`;
            }
            return `<c r="${ref}" t="inlineStr"><is><t>${text(value)}</t></is></c>`;
          })
          .join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join('');
    return `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  const workbook = `<workbook><sheets>${sheets
    .map(
      (sheet, i) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join('')}</sheets></workbook>`;
  const rels = `<Relationships>${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join('')}</Relationships>`;
  const entries: ZipEntry[] = [
    { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(rels) },
    ...sheetXml.map((xml, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data:
        i === 0 && options.sheetXml ? options.sheetXml : encoder.encode(xml),
      deflate: options.deflate,
      declaredSize: i === 0 ? options.declaredSheetSize : undefined,
    })),
  ];
  if (options.sharedStringsXml !== undefined) {
    entries.push({
      name: 'xl/sharedStrings.xml',
      data: encoder.encode(options.sharedStringsXml),
      deflate: options.deflate,
    });
  } else if (sharedStrings.length > 0) {
    const items = sharedStrings
      .map((value) => `<si><t>${text(value)}</t></si>`)
      .join('');
    entries.push({
      name: 'xl/sharedStrings.xml',
      data: encoder.encode(`<sst>${items}</sst>`),
    });
  }
  return buildZip(entries);
}
