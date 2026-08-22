/**
 * Parse a question-bank zip bundle (bank.json + images/) produced by the
 * export side of `lib/question-bank-export.ts`.
 *
 * The reader mirrors the hand-rolled xlsx zip reader (central directory scan +
 * optional deflate through DecompressionStream) so imports need no runtime
 * dependency.  Images are content-addressed: each archive file name must equal
 * the sha256 of its bytes, which is what makes the bundle tamper-evident and
 * naturally deduplicated.
 */
import { sniffImageDimensions } from "../io/image-dimensions";
import { IMAGE_MIME_BY_EXTENSION, sha256Bytes, IMAGE_MIME_TYPES, type ImageMimeType } from "../io/image-assets";
import { IMPORT_LIMITS } from "../io/import-limits";

export const QUESTION_BANK_ZIP_IMPORT_LIMITS = IMPORT_LIMITS.zip;
const MAX_BUNDLE_BYTES = QUESTION_BANK_ZIP_IMPORT_LIMITS.maxBytes;
const MAX_ARCHIVE_ENTRIES = QUESTION_BANK_ZIP_IMPORT_LIMITS.maxArchiveEntries;
const MAX_ENTRY_BYTES = QUESTION_BANK_ZIP_IMPORT_LIMITS.maxEntryBytes;
const MAX_TOTAL_UNCOMPRESSED_BYTES = QUESTION_BANK_ZIP_IMPORT_LIMITS.maxTotalUncompressedBytes;
const MAX_QUESTIONS = QUESTION_BANK_ZIP_IMPORT_LIMITS.maxQuestions;
const MAX_OPTIONS = QUESTION_BANK_ZIP_IMPORT_LIMITS.maxOptionsPerQuestion;
const MAX_IMAGES_PER_QUESTION = QUESTION_BANK_ZIP_IMPORT_LIMITS.maxImagesPerQuestion;
const MAX_IMAGES = QUESTION_BANK_ZIP_IMPORT_LIMITS.maxImages;

export class QuestionBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionBundleError";
  }
}

function fail(message: string): never {
  throw new QuestionBundleError(message);
}

/** A bundled image resolved to its content-addressed asset identity. */
export interface ParsedBundleImage {
  /** Archive path, e.g. `images/<sha256>.png` — the src referenced by bank.json. */
  src: string;
  assetId: string;
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

/** Parse output: name + raw question rows (content blocks already resolved to
 *  asset ids) + the images that must be materialised before import. */
export interface ParsedQuestionBundle {
  name?: string;
  questions: Array<Record<string, unknown>>;
  images: ParsedBundleImage[];
}

function normalizeArchivePath(value: string) {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) fail("题库压缩包包含越界路径。");
      parts.pop();
    }
    else parts.push(part);
  }
  const normalized = parts.join("/");
  if (!normalized) fail("题库压缩包包含无效的空路径。");
  return normalized;
}

interface ZipEntry {
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(view: DataView) {
  const lowerBound = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntries(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) fail("文件不是有效的题库压缩包。");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  if (!entryCount || entryCount > MAX_ARCHIVE_ENTRIES) fail("题库压缩包包含异常数量的内部文件。");
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let offset = centralDirectoryOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== 0x02014b50) fail("题库压缩包目录损坏。");
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (uncompressedSize > MAX_ENTRY_BYTES) fail("题库压缩包中的单个文件过大。");
    totalSize += uncompressedSize;
    if (totalSize > MAX_TOTAL_UNCOMPRESSED_BYTES) fail("题库压缩包解压后的内容过大。");
    const fileNameEnd = offset + 46 + fileNameLength;
    if (fileNameEnd > view.byteLength) fail("题库压缩包目录损坏。");
    const name = normalizeArchivePath(decoder.decode(new Uint8Array(buffer, offset + 46, fileNameLength)));
    if (entries.has(name)) fail(`题库压缩包包含重复路径：${name}`);
    entries.set(name, { compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset = fileNameEnd + extraLength + commentLength;
  }
  return entries;
}

async function unzip(buffer: ArrayBuffer, entries: Map<string, ZipEntry>, path: string): Promise<Uint8Array> {
  const entry = entries.get(normalizeArchivePath(path));
  if (!entry) fail(`题库压缩包缺少 ${path}。`);
  const view = new DataView(buffer);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > view.byteLength || view.getUint32(offset, true) !== 0x04034b50) fail("题库压缩包内容索引损坏。");
  const fileNameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  if (dataOffset + entry.compressedSize > view.byteLength) fail("题库压缩包内容不完整。");
  const compressed = new Uint8Array(buffer, dataOffset, entry.compressedSize);
  let bytes: Uint8Array;
  if (entry.compression === 0) bytes = compressed;
  else if (entry.compression === 8) {
    if (typeof DecompressionStream === "undefined") fail("当前浏览器不支持读取压缩包内容，请升级浏览器。");
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_ENTRY_BYTES || total > entry.uncompressedSize) fail("题库压缩包解压后的单个文件超过安全上限。");
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let outputOffset = 0;
    for (const chunk of chunks) { bytes.set(chunk, outputOffset); outputOffset += chunk.byteLength; }
  } else fail(`题库压缩包使用了不支持的压缩方式（${entry.compression}）。`);
  if (bytes.byteLength !== entry.uncompressedSize) fail("题库压缩包解压长度不一致，文件可能已损坏。");
  return bytes;
}

function imageMimeFor(src: string, declared: unknown): ImageMimeType {
  if (typeof declared === "string" && (IMAGE_MIME_TYPES as readonly string[]).includes(declared)) return declared as ImageMimeType;
  const extension = src.split(".").pop() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? fail(`图片 ${src} 的格式不受支持。`);
}

/** Resolve `{type:"image", src}` references into asset ids on a block array. */
function resolveBlocks(value: unknown, imageBySrc: Map<string, ParsedBundleImage>): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") fail("题目内容块格式无效。");
    const block = item as Record<string, unknown>;
    if (block.type === "text") {
      if (typeof block.text !== "string") fail("文字内容块的 text 必须是字符串。");
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (typeof block.src !== "string") fail("图片内容块缺少 src 引用。");
      const image = imageBySrc.get(block.src);
      if (!image) fail(`题目引用了压缩包中不存在的图片：${block.src}`);
      blocks.push({
        type: "image",
        assetId: image.assetId,
        ...(typeof block.alt === "string" && block.alt.trim() ? { alt: block.alt } : {}),
        ...(typeof block.caption === "string" && block.caption.trim() ? { caption: block.caption } : {}),
      });
    } else fail("题目内容块格式无效。");
  }
  return blocks;
}

export async function parseQuestionBankZip(buffer: ArrayBuffer): Promise<ParsedQuestionBundle> {
  if (!buffer.byteLength) fail("题库压缩包为空。");
  if (buffer.byteLength > MAX_BUNDLE_BYTES) fail("题库压缩包超过 256 MB 上限。");
  const entries = readZipEntries(buffer);
  const manifestBytes = await unzip(buffer, entries, "bank.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
  } catch {
    fail("bank.json 内容无法解析，请检查文件格式。");
  }
  const rawQuestions = manifest.questions;
  if (!Array.isArray(rawQuestions) || !rawQuestions.length) fail("bank.json 中没有题目，请检查文件格式。");
  if (rawQuestions.length > MAX_QUESTIONS) fail(`题库压缩包最多包含 ${MAX_QUESTIONS} 道题。`);
  const imageManifest = (manifest.images && typeof manifest.images === "object" ? manifest.images : {}) as Record<string, unknown>;
  if (Object.keys(imageManifest).length > MAX_IMAGES) fail(`压缩包图片数量超过上限（${MAX_IMAGES}）。`);

  const images: ParsedBundleImage[] = [];
  const imageBySrc = new Map<string, ParsedBundleImage>();
  for (const [src, declared] of Object.entries(imageManifest)) {
    if (!src.startsWith("images/")) fail(`图片路径必须位于 images/ 目录下：${src}`);
    const bytes = await unzip(buffer, entries, src);
    const assetId = await sha256Bytes(bytes);
    const expectedName = `${assetId}.${(src.split(".").pop() ?? "").toLowerCase()}`;
    if (!src.endsWith(expectedName)) fail(`图片 ${src} 的内容与其文件名不一致，文件可能已损坏或被篡改。`);
    const dimensions = sniffImageDimensions(bytes);
    if (!dimensions) fail(`图片 ${src} 无法识别尺寸，文件可能已损坏。`);
    const mimeType = imageMimeFor(src, declared && typeof declared === "object" ? (declared as Record<string, unknown>).mimeType : undefined);
    const image: ParsedBundleImage = { src, assetId, bytes, mimeType, width: dimensions.width, height: dimensions.height };
    images.push(image);
    imageBySrc.set(src, image);
  }

  const questions = rawQuestions.map((row) => {
    if (!row || typeof row !== "object") fail("题目格式无效。");
    const record = row as Record<string, unknown>;
    const content = resolveBlocks(record.content, imageBySrc);
    if (content && content.filter((block) => block.type === "image").length > MAX_IMAGES_PER_QUESTION) fail(`每道题最多包含 ${MAX_IMAGES_PER_QUESTION} 张图片。`);
    if (Array.isArray(record.options) && record.options.length > MAX_OPTIONS) fail(`每道题最多包含 ${MAX_OPTIONS} 个选项。`);
    const options = Array.isArray(record.options)
      ? record.options.map((option, index) => resolveBlocks(option, imageBySrc) ?? fail(`第 ${index + 1} 个选项的格式无效。`))
      : record.options;
    if (Array.isArray(options)) {
      const optionImageCount = options.reduce((sum, option) => sum + (Array.isArray(option) ? option.filter((block) => block.type === "image").length : 0), 0);
      if (optionImageCount + (content?.filter((block) => block.type === "image").length ?? 0) > MAX_IMAGES_PER_QUESTION) fail(`每道题最多包含 ${MAX_IMAGES_PER_QUESTION} 张图片。`);
    }
    return { ...record, ...(content ? { content } : {}), options };
  });
  return {
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : undefined,
    questions,
    images,
  };
}
