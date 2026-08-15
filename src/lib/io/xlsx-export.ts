/**
 * Minimal xlsx (Office Open XML spreadsheet) writer.
 *
 * Symmetric with the hand-rolled reader in `lib/xlsx-import.ts`: no `xlsx`
 * runtime dependency, entries are stored uncompressed (ZIP method 0) and text
 * cells use `t="inlineStr"`.  Only the small subset of the format the reader
 * understands is emitted, so the output round-trips through `parseQuestionBankWorkbook`.
 *
 * Images are embedded the WPS way: `xl/cellimages.xml` maps a DISPIMG id to a
 * media file and the cell value is a `=DISPIMG("ID_…",1)` formula (see the
 * 图片嵌入测试.xlsx reference).  Microsoft Excel shows `#NAME?` for those
 * cells but keeps every text column intact.
 */

const encoder = new TextEncoder();

/** Cell values starting with this marker are emitted as DISPIMG formula cells. */
export const DISPIMG_FORMULA_PREFIX = "=DISPIMG(";

export interface XlsxSheet {
  name: string;
  rows: string[][];
  /** Row heights in points, index 0 = row 1.  Omitted rows use the default. */
  rowHeights?: number[];
  /** Column widths in character units, index 0 = column A.  0 keeps the default. */
  columnWidths?: number[];
}

export interface XlsxEmbeddedImage {
  /** DISPIMG identifier — the string inside =DISPIMG("…",1). */
  id: string;
  bytes: Uint8Array;
  extension: "png" | "jpg";
  /** Native pixel size, written as the cellImage shape extent (EMU). */
  width: number;
  height: number;
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

function cellXml(value: string, columnIndex: number, rowIndex: number): string {
  const reference = cellReference(columnIndex, rowIndex + 1);
  if (value.startsWith(DISPIMG_FORMULA_PREFIX)) {
    // Mirror the WPS reference layout: prefixed <f> plus a cached <v> that
    // holds the literal formula text.
    const formula = value.slice(1);
    return `<c r="${reference}" t="str"><f>_xlfn.${formula}</f><v>${xmlEscape(value)}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function worksheetXml(sheet: XlsxSheet): string {
  const widths = sheet.columnWidths ?? [];
  const cols = widths
    .map((width, index) => (width > 0 ? `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>` : ""))
    .join("");
  const colsXml = cols ? `<cols>${cols}</cols>` : "";
  const body = sheet.rows.map((row, rowIndex) => {
    const height = sheet.rowHeights?.[rowIndex] ?? 0;
    const heightXml = height > 0 ? ` ht="${height}" customHeight="1"` : "";
    const cells = row.map((value, columnIndex) => {
      if (value === undefined || value === null || value === "") return "";
      return cellXml(String(value), columnIndex, rowIndex);
    }).join("");
    return `<row r="${rowIndex + 1}"${heightXml}>${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${body}</sheetData></worksheet>`;
}

function workbookXml(sheets: XlsxSheet[]): string {
  const entries = sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${entries}</sheets></workbook>`;
}

function workbookRels(sheets: XlsxSheet[], hasImages: boolean): string {
  const entries = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const cellImages = hasImages ? `<Relationship Id="rId${sheets.length + 1}" Type="http://www.wps.cn/officeDocument/2020/cellImage" Target="cellimages.xml"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}${cellImages}</Relationships>`;
}

function cellImagesXml(images: readonly XlsxEmbeddedImage[]): string {
  const body = images.map((image, index) => {
    const relationship = `rId${index + 1}`;
    const extent = { cx: Math.max(1, Math.round(image.width * 9525)), cy: Math.max(1, Math.round(image.height * 9525)) };
    return `<etc:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 2}" name="${xmlEscape(image.id)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${relationship}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${extent.cx}" cy="${extent.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="9525"><a:noFill/></a:ln></xdr:spPr></xdr:pic></etc:cellImage>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><etc:cellImages xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData">${body}</etc:cellImages>`;
}

function cellImagesRels(images: readonly XlsxEmbeddedImage[]): string {
  const entries = images.map((image, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index + 1}.${image.extension}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

function contentTypes(sheets: XlsxSheet[], images: readonly XlsxEmbeddedImage[]): string {
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const defaults = images.length
    ? `<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/xl/cellimages.xml" ContentType="vnd.wps-officedocument.cellimage+xml"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}${defaults}</Types>`;
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

/** Build an uncompressed (STORED) zip archive from named entries. */
export function buildStoredZip(files: ZipFile[]): Uint8Array {
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

/** Build a complete .xlsx workbook from one or more sheets, optionally embedding DISPIMG cell images. */
export function buildXlsx(sheets: XlsxSheet[], images: readonly XlsxEmbeddedImage[] = []): Uint8Array {
  const files: ZipFile[] = [
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes(sheets, images)) },
    { name: "_rels/.rels", data: encoder.encode(rootRels()) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(sheets)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels(sheets, images.length > 0)) },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: encoder.encode(worksheetXml(sheet)) })),
  ];
  if (images.length) {
    files.push(
      { name: "xl/cellimages.xml", data: encoder.encode(cellImagesXml(images)) },
      { name: "xl/_rels/cellimages.xml.rels", data: encoder.encode(cellImagesRels(images)) },
      ...images.map((image, index) => ({ name: `xl/media/image${index + 1}.${image.extension}`, data: image.bytes })),
    );
  }
  return buildStoredZip(files);
}
