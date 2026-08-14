/**
 * Minimal xlsx (Office Open XML spreadsheet) writer.
 *
 * Symmetric with the hand-rolled reader in `lib/xlsx-import.ts`: no `xlsx`
 * runtime dependency, entries are stored uncompressed (ZIP method 0) and text
 * cells use `t="inlineStr"`.  Only the small subset of the format the reader
 * understands is emitted, so the output round-trips through `parseQuestionBankWorkbook`.
 */

const encoder = new TextEncoder();

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

interface ZipFile {
  name: string;
  data: Uint8Array;
}

function xmlEscape(value: string): string {
  return value
    // Strip characters that are illegal in XML 1.0 regardless of escaping.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function cellReference(column: number, row: number): string {
  return `${columnLetter(column)}${row}`;
}

function worksheetXml(rows: string[][]): string {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      if (value === undefined || value === null || value === "") return "";
      return `<c r="${cellReference(columnIndex, rowIndex + 1)}" t="inlineStr"><is><t>${xmlEscape(String(value))}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function workbookXml(sheets: XlsxSheet[]): string {
  const entries = sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${entries}</sheets></workbook>`;
}

function workbookRels(sheets: XlsxSheet[]): string {
  const entries = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

function contentTypes(sheets: XlsxSheet[]): string {
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`;
}

function rootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function buildZip(files: ZipFile[]): Uint8Array {
  const nameBytes = files.map((file) => encoder.encode(file.name));
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (let index = 0; index < files.length; index += 1) {
    const { data } = files[index];
    const nameData = nameBytes[index];
    const checksum = crc32(data);

    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true); // STORED
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameData.length, true);
    localView.setUint16(28, 0, true);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true); // STORED
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameData.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);

    localParts.push(local, nameData, data);
    centralParts.push(central, nameData);
    offset += 30 + nameData.length + data.length;
  }

  const localPart = concat(localParts);
  const centralPart = concat(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralPart.length, true);
  eocdView.setUint32(16, localPart.length, true);
  eocdView.setUint16(20, 0, true);

  return concat([localPart, centralPart, eocd]);
}

/** Build a complete .xlsx workbook from one or more sheets. */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const files: ZipFile[] = [
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes(sheets)) },
    { name: "_rels/.rels", data: encoder.encode(rootRels()) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(sheets)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels(sheets)) },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: encoder.encode(worksheetXml(sheet.rows)) })),
  ];
  return buildZip(files);
}
