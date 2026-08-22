const MAX_XLSX_BYTES = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_QUESTIONS = 20_000;
const MAX_OPTIONS = 24;
const MAX_IMAGES_PER_QUESTION = 12;
const MAX_ANSWER_COLUMNS = 12;

/** A cell image recovered from `xl/cellimages.xml`, keyed by its DISPIMG id. */
export interface WorkbookImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

export interface ImportedQuestionRow {
  q: string;
  ans: string;
  a: string[];
  type: QuestionType;
  tags: string[];
  note?: string;
  /** DISPIMG ids placed in the 图片N columns, index 0 = 【图1】. */
  images?: string[];
}

/** Parser output: text rows plus the workbook's embedded cell images. */
export interface QuestionWorkbook {
  rows: string[][];
  images: Map<string, WorkbookImage>;
}

const DISPIMG_PATTERN = /^=DISPIMG\("([^"]+)",1\)$/;
const IMAGE_HEADER_PATTERN = /^图片([1-9][0-9]*)$/;
const ANSWER_HEADER_PATTERN = /^答案([1-9][0-9]*)$/;

export interface XlsxValidationIssue {
  row: number;
  message: string;
}

export class XlsxImportError extends Error {
  readonly issues: XlsxValidationIssue[];

  constructor(message: string, issues: XlsxValidationIssue[] = []) {
    super(message);
    this.name = "XlsxImportError";
    this.issues = issues;
  }
}

interface ZipEntry {
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function fail(message: string): never {
  throw new XlsxImportError(message);
}

function xmlText(value: string) {
  return value.replace(/&#x([0-9a-f]+);|&#([0-9]+);|&(amp|lt|gt|quot|apos);/gi, (match, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[String(named).toLowerCase()] ?? match;
  });
}

function xmlAttribute(attributes: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? xmlText(match[1] ?? match[2] ?? "") : undefined;
}

function columnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return -1;
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function normalizeArchivePath(value: string) {
  const parts: string[] = [];
  for (const part of value.replace(/^\//, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function findEndOfCentralDirectory(view: DataView) {
  const lowerBound = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntries(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) fail("文件不是有效的 .xlsx 工作簿。");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  if (!entryCount || entryCount > MAX_ARCHIVE_ENTRIES) fail("Excel 文件包含异常数量的内部文件。");
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let offset = centralDirectoryOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== 0x02014b50) fail("Excel 文件目录损坏。");
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (uncompressedSize > MAX_ENTRY_BYTES) fail("Excel 文件中的单个内容过大。");
    totalSize += uncompressedSize;
    if (totalSize > MAX_TOTAL_UNCOMPRESSED_BYTES) fail("Excel 文件解压后的内容过大。");
    const fileNameEnd = offset + 46 + fileNameLength;
    if (fileNameEnd > view.byteLength) fail("Excel 文件目录损坏。");
    const name = normalizeArchivePath(decoder.decode(new Uint8Array(buffer, offset + 46, fileNameLength)));
    entries.set(name, { compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset = fileNameEnd + extraLength + commentLength;
  }
  return entries;
}

async function unzipBytes(buffer: ArrayBuffer, entries: Map<string, ZipEntry>, path: string, required = true): Promise<Uint8Array> {
  const entry = entries.get(normalizeArchivePath(path));
  if (!entry) {
    if (required) fail(`Excel 文件缺少必要内容：${path}`);
    return new Uint8Array(0);
  }
  const view = new DataView(buffer);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > view.byteLength || view.getUint32(offset, true) !== 0x04034b50) fail("Excel 文件内容索引损坏。");
  const fileNameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  if (dataOffset + entry.compressedSize > view.byteLength) fail("Excel 文件内容不完整。");
  const compressed = new Uint8Array(buffer, dataOffset, entry.compressedSize);
  let bytes: Uint8Array;
  if (entry.compression === 0) bytes = compressed;
  else if (entry.compression === 8) {
    if (typeof DecompressionStream === "undefined") fail("当前浏览器不支持读取 Excel 压缩内容，请升级浏览器。");
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else fail(`Excel 使用了不支持的压缩方式（${entry.compression}）。`);
  if (bytes.byteLength !== entry.uncompressedSize) fail("Excel 文件解压长度不一致，文件可能已损坏。");
  return bytes;
}

async function unzipText(buffer: ArrayBuffer, entries: Map<string, ZipEntry>, path: string, required = true) {
  const bytes = await unzipBytes(buffer, entries, path, required);
  if (!bytes.byteLength && !entries.has(normalizeArchivePath(path))) return "";
  return new TextDecoder().decode(bytes);
}

function relationshipTarget(workbookXml: string, relationshipsXml: string, sheetName: string) {
  let relationshipId = "";
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    if (xmlAttribute(match[1], "name") === sheetName) {
      relationshipId = xmlAttribute(match[1], "r:id") ?? "";
      break;
    }
  }
  if (!relationshipId) fail(`Excel 中缺少“${sheetName}”工作表。`);
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    if (xmlAttribute(match[1], "Id") === relationshipId) {
      const target = xmlAttribute(match[1], "Target");
      if (!target) break;
      return normalizeArchivePath(target.startsWith("/") ? target : `xl/${target}`);
    }
  }
  fail(`无法定位“${sheetName}”工作表。`);
}

function sharedStringsFromXml(xml: string) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((item) =>
    [...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((text) => xmlText(text[1])).join(""),
  );
}

function cellText(attributes: string, body: string, sharedStrings: string[]) {
  const type = xmlAttribute(attributes, "t");
  if (type === "inlineStr") {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((text) => xmlText(text[1])).join("");
  }
  const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? "";
  if (type === "s") {
    const index = Number(raw);
    if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) fail("Excel 的共享文本索引无效。");
    return sharedStrings[index];
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return xmlText(raw);
}

function rowsFromSheetXml(xml: string, sharedStrings: string[]) {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = Number(xmlAttribute(rowMatch[1], "r")) || rows.length + 1;
    if (rowNumber > MAX_QUESTIONS + 100) fail("Excel 行数超过允许上限。");
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/gi)) {
      const reference = xmlAttribute(cellMatch[1], "r") ?? "";
      const index = columnIndex(reference);
      if (index < 0) continue;
      if (index > 3 + MAX_ANSWER_COLUMNS + MAX_OPTIONS + MAX_IMAGES_PER_QUESTION) fail(`第 ${rowNumber} 行包含过多列，最多支持 ${MAX_ANSWER_COLUMNS} 个答案、${MAX_OPTIONS} 个选项和 ${MAX_IMAGES_PER_QUESTION} 张图片。`);
      cells[index] = cellText(cellMatch[1], cellMatch[2] ?? "", sharedStrings).trim();
    }
    rows[rowNumber - 1] = cells;
  }
  return rows;
}

/** Locate and decode the WPS cell-image table: xl/cellimages.xml maps a
 *  DISPIMG id to an rId, and its .rels maps the rId to a media file. */
async function readCellImages(buffer: ArrayBuffer, entries: Map<string, ZipEntry>, relationshipsXml: string): Promise<Map<string, WorkbookImage>> {
  const images = new Map<string, WorkbookImage>();
  let cellImagesTarget = "";
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    if ((xmlAttribute(match[1], "Type") ?? "").includes("/cellImage")) {
      const target = xmlAttribute(match[1], "Target");
      if (target) cellImagesTarget = normalizeArchivePath(target.startsWith("/") ? target : `xl/${target}`);
    }
  }
  if (!cellImagesTarget) return images;
  const cellImagesXml = await unzipText(buffer, entries, cellImagesTarget, false);
  if (!cellImagesXml) return images;
  const imageRelsXml = await unzipText(buffer, entries, `xl/_rels/${cellImagesTarget.split("/").pop()}.rels`, false);
  const mediaByRelationship = new Map<string, string>();
  for (const match of (imageRelsXml || "").matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const id = xmlAttribute(match[1], "Id");
    const target = xmlAttribute(match[1], "Target");
    if (id && target) mediaByRelationship.set(id, normalizeArchivePath(target.startsWith("/") ? target : `xl/${target.replace(/^\.\.\//, "")}`));
  }
  for (const match of cellImagesXml.matchAll(/<etc:cellImage\b[^>]*>([\s\S]*?)<\/etc:cellImage>/gi)) {
    const body = match[1];
    const id = body.match(/<xdr:cNvPr\b[^>]*\bname\s*=\s*"([^"]*)"/i)?.[1];
    const embed = body.match(/r:embed\s*=\s*"([^"]*)"/i)?.[1];
    if (!id || !embed) continue;
    const mediaPath = mediaByRelationship.get(embed);
    if (!mediaPath) continue;
    const bytes = await unzipBytes(buffer, entries, mediaPath, false);
    if (!bytes.byteLength) continue;
    const signature = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : undefined;
    if (!signature) continue;
    images.set(id, { bytes, mimeType: signature });
  }
  return images;
}

export async function readQuestionWorkbook(buffer: ArrayBuffer): Promise<QuestionWorkbook> {
  if (!buffer.byteLength) fail("Excel 文件为空。");
  if (buffer.byteLength > MAX_XLSX_BYTES) fail("Excel 文件超过 12 MB 上限。");
  const entries = readZipEntries(buffer);
  const workbook = await unzipText(buffer, entries, "xl/workbook.xml");
  const relationships = await unzipText(buffer, entries, "xl/_rels/workbook.xml.rels");
  const sharedStrings = sharedStringsFromXml(await unzipText(buffer, entries, "xl/sharedStrings.xml", false));
  const sheetPath = relationshipTarget(workbook, relationships, "题库");
  const sheet = await unzipText(buffer, entries, sheetPath);
  const images = await readCellImages(buffer, entries, relationships);
  return { rows: rowsFromSheetXml(sheet, sharedStrings), images };
}

function normalizedAnswer(value: string, options: string[]) {
  const compact = value.trim().toUpperCase();
  if (compact === "正确" && options[0] === "正确" && options[1] === "错误") return "A";
  if (compact === "错误" && options[0] === "正确" && options[1] === "错误") return "B";
  return [...compact.replace(/[\s,，、;；/]+/g, "")].sort().join("");
}

function duplicateKey(stem: string, options: string[], imageIds: string[]) {
  return `${stem.replace(/\s+/g, "").replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))}\u0000${options.join("\u0000")}\u0000${imageIds.join("\u0000")}`;
}

export function parseQuestionBankTable(rows: string[][], images: ReadonlyMap<string, WorkbookImage> = new Map()): ImportedQuestionRow[] {
  const header = rows[0]?.map((value) => value?.trim() ?? "") ?? [];
  const issues: XlsxValidationIssue[] = [];
  const requiredHeaders = ["题干", "题型", "标签", "解析"];
  if (requiredHeaders.some((value, index) => header[index] !== value)) {
    throw new XlsxImportError("题库表头无效，请使用本项目下载的最新模板且不要修改第一行。", [{ row: 1, message: "A–D 列必须依次为“题干、题型、标签、解析”。" }]);
  }
  let headerCursor = 4;
  let declaredAnswerColumns = 0;
  for (; headerCursor < header.length && header[headerCursor]; headerCursor += 1) {
    const match = header[headerCursor].match(ANSWER_HEADER_PATTERN);
    if (!match) break;
    if (Number(match[1]) !== declaredAnswerColumns + 1) issues.push({ row: 1, message: "答案列必须从“答案1”开始连续编号。" });
    declaredAnswerColumns += 1;
  }
  if (!declaredAnswerColumns) issues.push({ row: 1, message: "模板至少需要“答案1”列。" });
  if (declaredAnswerColumns > MAX_ANSWER_COLUMNS) issues.push({ row: 1, message: `计算题最多支持 ${MAX_ANSWER_COLUMNS} 个答案列。` });
  let declaredOptionColumns = 0;
  // Option headers run A、B、C… after all 答案N columns, followed by 图片N.
  for (; headerCursor < header.length && header[headerCursor] && !IMAGE_HEADER_PATTERN.test(header[headerCursor]); headerCursor += 1) {
    const expected = String.fromCharCode(65 + declaredOptionColumns);
    if (header[headerCursor].toUpperCase() !== expected) issues.push({ row: 1, message: `${expected} 选项列的表头必须是“${expected}”。` });
    declaredOptionColumns += 1;
  }
  if (declaredOptionColumns < 2) issues.push({ row: 1, message: "模板至少需要 A、B 两个选项列。" });
  let declaredImageColumns = 0;
  for (; headerCursor < header.length && header[headerCursor]; headerCursor += 1) {
    const match = header[headerCursor].match(IMAGE_HEADER_PATTERN);
    if (!match || Number(match[1]) !== declaredImageColumns + 1) {
      issues.push({ row: 1, message: "选项列之后的表头必须依次为“图片1、图片2…”。" });
      break;
    }
    declaredImageColumns += 1;
  }
  if (declaredImageColumns > MAX_IMAGES_PER_QUESTION) issues.push({ row: 1, message: `每题最多支持 ${MAX_IMAGES_PER_QUESTION} 张图片。` });
  if (header.slice(headerCursor).some(Boolean)) issues.push({ row: 1, message: "选项表头必须从 A 开始连续填写。" });
  const optionColumns = declaredOptionColumns;
  if (optionColumns > MAX_OPTIONS) issues.push({ row: 1, message: `每题最多支持 ${MAX_OPTIONS} 个选项。` });
  const questions: ImportedQuestionRow[] = [];
  const seen = new Map<string, number>();
  for (let index = 1; index < rows.length; index += 1) {
    const source = rows[index] ?? [];
    if (!source.some((value) => value?.trim())) continue;
    const row = index + 1;
    const stem = source[0]?.trim() ?? "";
    const typeText = source[1]?.trim() ?? "";
    const tags = (source[2] ?? "").split(/[，,、\n]+/).map((tag) => tag.trim()).filter(Boolean);
    const note = source[3]?.trim() ?? "";
    const answerCells = source.slice(4, 4 + declaredAnswerColumns).map((value) => value?.trim() ?? "");
    if (!stem) issues.push({ row, message: "题干不能为空。" });
    if (stem.startsWith("示例·") || stem.includes("（填好后删）")) issues.push({ row, message: "请删除模板自带的示例题。" });
    const type = (["单选", "多选", "判断", "计算"] as const).find((item) => item === typeText);
    if (!type) issues.push({ row, message: "题型必须填写单选、多选、判断或计算。" });
    if (!answerCells[0]) issues.push({ row, message: "答案1不能为空。" });
    const optionStart = 4 + declaredAnswerColumns;
    const optionCells = source.slice(optionStart, optionStart + optionColumns).map((value) => value?.trim() ?? "");
    const lastOption = optionCells.findLastIndex(Boolean);
    const options = lastOption >= 0 ? optionCells.slice(0, lastOption + 1) : [];
    let answer = answerCells[0] ?? "";
    if (type === "计算") {
      if (options.some(Boolean)) issues.push({ row, message: "计算题不需要填写选项列。" });
      const lastAnswer = answerCells.findLastIndex(Boolean);
      const calculationAnswerCells = lastAnswer >= 0 ? answerCells.slice(0, lastAnswer + 1) : [];
      if (calculationAnswerCells.some((value) => !value)) issues.push({ row, message: "计算题的答案列之间不能留空。" });
      try {
        answer = normalizeCalculationAnswer(calculationAnswerCells);
        validateCalculationBlankLayout(stem, answer);
      }
      catch (error) { issues.push({ row, message: error instanceof Error ? error.message : "计算题答案无效。" }); }
    } else {
      if (answerCells.slice(1).some(Boolean)) issues.push({ row, message: "选择题和判断题只填写“答案1”，其余答案列必须留空。" });
      if (options.length < 2) issues.push({ row, message: "选择题和判断题至少需要两个选项。" });
      const gap = options.findIndex((value) => !value);
      if (gap >= 0) issues.push({ row, message: `${String.fromCharCode(65 + gap)} 选项为空，选项之间不能断列。` });
      if (new Set(options).size !== options.length) issues.push({ row, message: "同一道题不能包含内容完全相同的选项。" });
      answer = normalizedAnswer(answerCells[0] ?? "", options);
      if (!/^[A-Z]+$/.test(answer)) issues.push({ row, message: `无法识别答案“${answerCells[0] ?? ""}”，请填写选项字母。` });
      else {
        const letters = [...answer];
        if (new Set(letters).size !== letters.length) issues.push({ row, message: "答案中包含重复字母。" });
        if (letters.some((letter) => letter.charCodeAt(0) - 65 >= options.length)) issues.push({ row, message: "答案字母超出了本题的选项范围。" });
        if (type !== "多选" && letters.length !== 1) issues.push({ row, message: "单选题和判断题只能有一个正确答案。" });
      }
      if (type === "判断" && (options.length !== 2 || options[0] !== "正确" || options[1] !== "错误")) issues.push({ row, message: "判断题选项必须依次为“正确、错误”。" });
    }
    // Trailing image columns hold =DISPIMG("ID_…",1) formulas; map each cell
    // to its workbook image and keep the ids in placeholder order.
    const imageIds: string[] = [];
    const imageCells = source.slice(optionStart + optionColumns, optionStart + optionColumns + Math.max(declaredImageColumns, MAX_IMAGES_PER_QUESTION));
    for (const cell of imageCells) {
      const value = cell?.trim() ?? "";
      if (!value) continue;
      const id = value.match(DISPIMG_PATTERN)?.[1];
      if (!id) {
        issues.push({ row, message: "图片列只能包含嵌入图片，请使用 WPS 在单元格中插入图片。" });
        continue;
      }
      if (!images.has(id)) {
        issues.push({ row, message: `图片 ${id.slice(0, 10)}… 缺失，文件可能已损坏。` });
        continue;
      }
      imageIds.push(id);
    }
    if (imageIds.length > MAX_IMAGES_PER_QUESTION) issues.push({ row, message: `每题最多支持 ${MAX_IMAGES_PER_QUESTION} 张图片。` });
    if (stem && (type === "计算" || options.length >= 2)) {
      const key = duplicateKey(stem, options, imageIds);
      const previous = seen.get(key);
      if (previous) issues.push({ row, message: `与第 ${previous} 行题目重复。` });
      else seen.set(key, row);
    }
    questions.push({ q: stem, ans: answer, a: type === "计算" ? [] : options, type: type ?? "单选", tags, ...(note ? { note } : {}), ...(imageIds.length ? { images: imageIds } : {}) });
  }
  if (!questions.length) issues.push({ row: 2, message: "题库中没有可导入的题目。" });
  if (questions.length > MAX_QUESTIONS) issues.push({ row: MAX_QUESTIONS + 2, message: `单次最多导入 ${MAX_QUESTIONS} 道题。` });
  if (issues.length) {
    const preview = issues.slice(0, 3).map((issue) => `第 ${issue.row} 行：${issue.message}`).join("；");
    const remaining = issues.length > 3 ? `；另有 ${issues.length - 3} 处错误` : "";
    throw new XlsxImportError(`Excel 校验失败：${preview}${remaining}`, issues);
  }
  return questions;
}

export async function parseQuestionBankWorkbook(buffer: ArrayBuffer): Promise<{ rows: ImportedQuestionRow[]; images: Map<string, WorkbookImage> }> {
  const workbook = await readQuestionWorkbook(buffer);
  return { images: workbook.images, rows: parseQuestionBankTable(workbook.rows, workbook.images) };
}

export function importFileName(fileName: string) {
  const name = fileName.replace(/\.xlsx$/i, "").trim();
  if (!name) fail("Excel 文件名不能为空，请先为题库文件命名。");
  return `${name}.json`;
}
import type { QuestionType } from "../../types/types";
import { normalizeCalculationAnswer, validateCalculationBlankLayout } from "../question/question-utils";
