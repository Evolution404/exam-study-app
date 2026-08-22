/**
 * Export a question bank as an Excel workbook, a JSON file, or — when the bank
 * contains images — a zip bundle (bank.json + images/).
 *
 * Both formats round-trip through the v7 import path: Excel uses the app's own
 * template columns (题干 / 题型 / 标签 / 解析 / 答案1… / 选项A… / 图片1…), embedding
 * images as WPS DISPIMG cell images, and the zip bundle carries structured
 * content blocks plus content-addressed image files.
 */
import type { ContentBlock, QuestionSolution } from "../db/v7-types";
import type { QuestionType } from "../../types/types";
import type { ImageMimeType } from "../io/image-assets";
import { IMAGE_EXTENSION_BY_MIME } from "../io/image-assets";
import { buildStoredZip, buildXlsx, type XlsxEmbeddedImage, type XlsxSheet } from "../io/xlsx-export";
import { mapWithConcurrency } from "../async/bounded-concurrency";
import { calculationAnswers, legacyAnswerForSolution, questionSolution, stableQuestionOptionIds } from "./question-utils";

export interface ExportQuestionInput {
  id: string;
  type: QuestionType;
  stem: string;
  options: string[];
  answer: string;
  optionIds?: string[];
  solution?: QuestionSolution;
  tags: string[];
  /** Canonical stem blocks; image blocks become 【图N】 placeholders. */
  content?: ContentBlock[];
  /** Canonical option blocks; image blocks become 【图N】 placeholders too. */
  optionBlocks?: ContentBlock[][];
  /** UI view models keep rich blocks nested under `canonical`; exporters must
   *  accept that shape directly instead of silently degrading to plain text. */
  canonical?: { content: ContentBlock[]; options: ContentBlock[][] };
}

export interface ExportImageData {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

/** Marker written into stem/option text where an image belongs; N is 1-based
 *  and maps the Nth image of the question to the 图片N column. */
export function imagePlaceholder(index: number): string {
  return `【图${index}】`;
}

export const IMAGE_PLACEHOLDER_PATTERN = /【图([0-9]+)】/g;

const HEADER = ["题干", "题型", "标签", "解析"];
/** Display sizing for exported cell images: fit within 200×280 px. */
const IMAGE_DISPLAY_WIDTH_PX = 200;
const IMAGE_DISPLAY_MAX_HEIGHT_PX = 280;
const POINTS_PER_PX = 0.75;
const COLUMN_CHARS_PER_PX = 1 / 7;
export const EXPORT_IMAGE_COLLECTION_CONCURRENCY = 6;

function columnLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function canonicalContent(question: ExportQuestionInput): ContentBlock[] | undefined {
  return question.content ?? question.canonical?.content;
}

function canonicalOptions(question: ExportQuestionInput): ContentBlock[][] | undefined {
  return question.optionBlocks ?? question.canonical?.options;
}

function optionColumns(questions: readonly ExportQuestionInput[]): number {
  // The importer requires at least A、B two option columns, so an all-计算题
  // bank must still export those two empty columns to remain re-importable.
  return Math.max(2, questions.reduce((max, question) => Math.max(max, question.options.length), 0));
}

function answerColumns(questions: readonly ExportQuestionInput[]): number {
  return Math.max(1, questions.reduce((max, question) => {
    if (question.type === "计算") return Math.max(max, calculationAnswers(question.answer).length);
    if (question.type === "填空") {
      const solution = question.solution ?? questionSolution({ ...question, options: question.options.map((text) => [{ id: "text", type: "text", text }]) });
      return solution.kind === "fill" ? Math.max(max, solution.blanks.length) : max;
    }
    return max;
  }, 1));
}

function answerCells(question: ExportQuestionInput): string[] {
  const solution = question.solution ?? questionSolution({ ...question, options: question.options.map((text) => [{ id: "text", type: "text", text }]) });
  if (solution.kind === "calculation") return solution.blanks.map((blank) => String(blank.expected));
  if (solution.kind === "fill") return solution.blanks.map((blank) => blank.acceptedAnswers.join("||"));
  if (solution.kind === "short") return [solution.referenceText];
  return [legacyAnswerForSolution(solution, question.optionIds ?? stableQuestionOptionIds({ options: question.options.map((text) => [{ id: "text", type: "text", text }]), optionIds: undefined }))];
}

function imageDisplaySize(data: ExportImageData): { width: number; height: number } {
  const scale = Math.min(IMAGE_DISPLAY_WIDTH_PX / data.width, IMAGE_DISPLAY_MAX_HEIGHT_PX / data.height, 1);
  return { width: Math.max(1, Math.round(data.width * scale)), height: Math.max(1, Math.round(data.height * scale)) };
}

interface PlaceholderText {
  text: string;
  /** assetIds in placeholder order (only images present in the export data). */
  images: string[];
}

function blocksToPlaceholderText(blocks: readonly ContentBlock[], available: ReadonlyMap<string, ExportImageData>, startIndex = 0): PlaceholderText {
  const parts: string[] = [];
  const images: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (available.has(block.assetId)) {
      images.push(block.assetId);
      parts.push(imagePlaceholder(startIndex + images.length));
    } else if (block.caption?.trim() || block.alt?.trim()) {
      // The image bytes are unavailable; keep its caption/alt so the reader
      // knows something was here instead of silently joining the text.
      parts.push(`［${block.caption?.trim() || block.alt?.trim()}］`);
    }
  }
  return { text: parts.join("").trim(), images };
}

export interface QuestionExportSheetPlan {
  rows: string[][];
  rowHeights: number[];
  columnWidths: number[];
  imageColumnCount: number;
  /** assetIds actually placed into DISPIMG cells, in first-use order. */
  usedAssetIds: string[];
}

/** Build the 题库 sheet plan: header row, one row per question with 【图N】
 *  placeholders in the text and =DISPIMG() formulas in the trailing 图片N
 *  columns.  Images missing from `images` degrade to caption/alt text. */
export function questionExportSheetPlan(questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>, images: ReadonlyMap<string, ExportImageData>): QuestionExportSheetPlan {
  const answerCount = answerColumns(questions);
  const optionCount = optionColumns(questions);
  const perQuestionImages = questions.map((question) => {
    const content = canonicalContent(question);
    const stem = content ? blocksToPlaceholderText(content, images) : { text: question.stem, images: [] as string[] };
    const optionBlocks: ContentBlock[][] = canonicalOptions(question) ?? question.options.map((text, index) => [{ id: `option-${index}-0`, type: "text" as const, text }]);
    let runningCount = stem.images.length;
    const optionTexts = optionBlocks.map((blocks) => {
      const option = blocksToPlaceholderText(blocks, images, runningCount);
      runningCount += option.images.length;
      return option;
    });
    return {
      stemText: stem.text,
      optionTexts,
      images: [...stem.images, ...optionTexts.flatMap((option) => option.images)],
    };
  });
  const imageColumnCount = perQuestionImages.reduce((max, item) => Math.max(max, item.images.length), 0);
  const columns = answerCount + optionCount + imageColumnCount;
  const header = [...HEADER, ...Array.from({ length: answerCount }, (_, index) => `答案${index + 1}`), ...Array.from({ length: optionCount }, (_, index) => columnLabel(index)), ...Array.from({ length: imageColumnCount }, (_, index) => `图片${index + 1}`)];

  const rowHeights: number[] = [];
  const columnWidths = new Array<number>(HEADER.length + columns).fill(0);
  for (let index = 0; index < imageColumnCount; index += 1) columnWidths[HEADER.length + answerCount + optionCount + index] = 10;

  const rows = perQuestionImages.map((item, questionIndex) => {
    const question = questions[questionIndex];
    const base = [item.stemText || question.stem, question.type, question.tags.join("、"), notes.get(question.id) ?? ""];
    const sourceAnswers = answerCells(question);
    const answers = Array.from({ length: answerCount }, (_, index) => sourceAnswers[index] ?? "");
    const options = Array.from({ length: optionCount }, (_, index) => item.optionTexts[index]?.text ?? "");
    const imageCells = Array.from({ length: imageColumnCount }, (_, index) => {
      const assetId = item.images[index];
      return assetId ? `=DISPIMG("ID_${assetId}",1)` : "";
    });
    let rowHeight = 0;
    item.images.forEach((assetId, imageIndex) => {
      const data = images.get(assetId)!;
      const display = imageDisplaySize(data);
      rowHeight = Math.max(rowHeight, Math.ceil(display.height * POINTS_PER_PX) + 8);
      columnWidths[HEADER.length + answerCount + optionCount + imageIndex] = Math.max(columnWidths[HEADER.length + answerCount + optionCount + imageIndex], Math.round(display.width * COLUMN_CHARS_PER_PX * 10) / 10);
    });
    rowHeights.push(rowHeight);
    return [...base, ...answers, ...options, ...imageCells];
  });

  const usedAssetIds = [...new Set(perQuestionImages.flatMap((item) => item.images))];
  return { rows: [header, ...rows], rowHeights: [0, ...rowHeights], columnWidths, imageColumnCount, usedAssetIds };
}

/** Build the 题库 sheet rows without images (legacy text-only shape). */
export function questionExportRows(questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>): string[][] {
  const answerCount = answerColumns(questions);
  const columns = optionColumns(questions);
  const header = [...HEADER, ...Array.from({ length: answerCount }, (_, index) => `答案${index + 1}`), ...Array.from({ length: columns }, (_, index) => columnLabel(index))];
  const rows = questions.map((question) => {
    const base = [question.stem, question.type, question.tags.join("、"), notes.get(question.id) ?? ""];
    const sourceAnswers = answerCells(question);
    const answers = Array.from({ length: answerCount }, (_, index) => sourceAnswers[index] ?? "");
    const options = Array.from({ length: columns }, (_, index) => question.options[index] ?? "");
    return [...base, ...answers, ...options];
  });
  return [header, ...rows];
}

/** Unique asset ids referenced by a question set, in first-seen order. */
export function collectImageAssetIds(questions: readonly ExportQuestionInput[]): string[] {
  const seen: string[] = [];
  for (const question of questions) {
    for (const blocks of [canonicalContent(question) ?? [], ...(canonicalOptions(question) ?? [])]) {
      for (const block of blocks) {
        if (block.type === "image" && !seen.includes(block.assetId)) seen.push(block.assetId);
      }
    }
  }
  return seen;
}

/** Select the portable export container before reading any image bytes. */
export function questionPortableExportFormat(questions: readonly ExportQuestionInput[]): "json" | "zip" {
  return collectImageAssetIds(questions).length > 0 ? "zip" : "json";
}

const INSTRUCTIONS: string[][] = [
  ["拾卷 · 题库 Excel 导出说明"],
  ["适用项目", "拾卷（exam-study-app）本地优先刷题 PWA"],
  ["本文件由题库导出生成，可直接改回本 App 重新导入。"],
  ["题干", "必填。支持普通文字、公式、图片和计算题填空占位符。多空计算题必须依次写【空1】【空2】…。"],
  ["题型", "必填，只能填写：单选、多选、判断、计算、填空、简答。"],
  ["答案列", "所有题至少填写“答案1”。选择题只用答案1；计算题按填空顺序分别填写答案1、答案2…，不得断列。"],
  ["标签", "可选。多个标签使用中文逗号、英文逗号或顿号分隔。"],
  ["解析", "可选。该题的个人解析，导入时会写回为本机笔记。"],
  ["多空计算题", "例如题干“电流为【空1】A，功率为【空2】W”，就在答案1、答案2分别填写两个标准数值；每空独立应用误差比例，全部正确才算整题正确。"],
  ["填空题", "每个答案列对应一个空；同一空可填写多个标准文本答案，用 || 分隔；最多 12 个空。"],
  ["简答题", "答案1填写参考答案；练习时由用户自行标记正确、错误或跳过，不自动判定。"],
  ["选项", "单选、多选、判断题从 A 列开始连续填写，不得断列；判断题必须依次为“正确、错误”。计算、填空、简答题不要填写选项。"],
  ["图片", "题干或选项中的图片按出现顺序编号为【图1】【图2】…，对应“图片1、图片2…”列中嵌入的单元格图片。"],
  ["图片查看", "嵌入图片需用 WPS Office 打开查看；Microsoft Excel 不支持该格式，会显示公式文字但题目数据完整。"],
  ["便携导出", "选择“导出 JSON / ZIP”：无图题库生成 JSON；含图题库生成包含 bank.json 与全部原图的 ZIP 压缩包。"],
];

/** Assemble the full .xlsx bytes for a bank, embedding DISPIMG cell images. */
export function buildQuestionBankXlsx(questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>, images: ReadonlyMap<string, ExportImageData> = new Map()): Uint8Array {
  const plan = questionExportSheetPlan(questions, notes, images);
  const embedded: XlsxEmbeddedImage[] = [];
  for (const assetId of plan.usedAssetIds) {
    const data = images.get(assetId)!;
    const extension = IMAGE_EXTENSION_BY_MIME[data.mimeType];
    if (extension !== "png" && extension !== "jpg") throw new Error(`图片 ${assetId.slice(0, 8)} 是 ${data.mimeType}，需先转换为 PNG 再嵌入 Excel。`);
    embedded.push({ id: `ID_${assetId}`, bytes: data.bytes, extension, width: data.width, height: data.height });
  }
  const sheets: XlsxSheet[] = [
    { name: "题库", rows: plan.rows, rowHeights: plan.rowHeights, columnWidths: plan.columnWidths },
    { name: "使用说明", rows: INSTRUCTIONS },
  ];
  return buildXlsx(sheets, embedded);
}

// ---------------------------------------------------------------------------
// JSON / zip bundle export
// ---------------------------------------------------------------------------

export interface QuestionBundleImageMeta {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

/** Map content blocks into the bundle's serialisable shape: image blocks
 *  become `{ type: "image", src: "images/<assetId>.<ext>" }` references. */
function bundleBlocks(blocks: readonly ContentBlock[], images: ReadonlyMap<string, ExportImageData>): Array<{ type: "text"; text: string } | { type: "image"; src: string; alt?: string; caption?: string }> {
  const result: Array<{ type: "text"; text: string } | { type: "image"; src: string; alt?: string; caption?: string }> = [];
  for (const block of blocks) {
    if (block.type === "text") {
      result.push({ type: "text", text: block.text });
      continue;
    }
    const data = images.get(block.assetId);
    if (!data) continue;
    result.push({
      type: "image",
      src: `images/${block.assetId}.${IMAGE_EXTENSION_BY_MIME[data.mimeType]}`,
      ...(block.alt?.trim() ? { alt: block.alt } : {}),
      ...(block.caption?.trim() ? { caption: block.caption } : {}),
    });
  }
  return result;
}

/** Build the JSON export body for a bank (text-only legacy shape). */
export function questionExportJson(name: string, questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>): string {
  const body = {
    name,
    questions: questions.map((question) => {
      const note = notes.get(question.id)?.trim();
      return {
        type: question.type,
        stem: question.stem,
        options: question.options,
        answer: question.type === "计算" || question.type === "填空" ? answerCells(question) : question.type === "简答" ? answerCells(question)[0] ?? "" : question.answer,
        ...(question.optionIds ? { optionIds: question.optionIds } : {}),
        ...(question.solution ? { solution: question.solution } : {}),
        tags: question.tags,
        ...(note ? { note } : {}),
      };
    }),
  };
  return JSON.stringify(body, null, 2);
}

/** Build the zip bundle body: structured content blocks plus a manifest of the
 *  bundled image files.  Image files themselves are returned separately so the
 *  caller controls the archive layout. */
export function questionExportBundle(name: string, questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>, images: ReadonlyMap<string, ExportImageData>): { json: string; files: Array<{ name: string; data: Uint8Array }> } {
  const assetIds = collectImageAssetIds(questions);
  const missing = assetIds.filter((assetId) => !images.has(assetId));
  if (missing.length) {
    throw new Error(`题库压缩包缺少 ${missing.length} 张原图，已取消导出。`);
  }
  const imageMeta: Record<string, QuestionBundleImageMeta> = {};
  const files: Array<{ name: string; data: Uint8Array }> = [];
  for (const assetId of assetIds) {
    const data = images.get(assetId)!;
    const file = `images/${assetId}.${IMAGE_EXTENSION_BY_MIME[data.mimeType]}`;
    imageMeta[file] = { mimeType: data.mimeType, width: data.width, height: data.height };
    files.push({ name: file, data: data.bytes });
  }
  const body = {
    name,
    images: imageMeta,
    questions: questions.map((question) => {
      const note = notes.get(question.id)?.trim();
      const richContent = canonicalContent(question);
      const content = richContent ? bundleBlocks(richContent, images) : [{ type: "text" as const, text: question.stem }];
      const optionBlocks: ContentBlock[][] = canonicalOptions(question) ?? question.options.map((text, index) => [{ id: `option-${index}-0`, type: "text" as const, text }]);
      const options = optionBlocks.map((blocks) => bundleBlocks(blocks, images));
      return {
        type: question.type,
        content,
        options,
        answer: question.type === "计算" || question.type === "填空" ? answerCells(question) : question.type === "简答" ? answerCells(question)[0] ?? "" : question.answer,
        ...(question.optionIds ? { optionIds: question.optionIds } : {}),
        ...(question.solution ? { solution: question.solution } : {}),
        tags: question.tags,
        ...(note ? { note } : {}),
      };
    }),
  };
  return { json: JSON.stringify(body, null, 2), files };
}

/** Assemble the .zip bundle bytes (bank.json + images/) for an image-bearing bank. */
export function buildQuestionBankZip(name: string, questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>, images: ReadonlyMap<string, ExportImageData>): Uint8Array {
  const { json, files } = questionExportBundle(name, questions, notes, images);
  return buildStoredZip([{ name: "bank.json", data: new TextEncoder().encode(json) }, ...files]);
}

/** Strip characters that are invalid in a file name across platforms. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 ? "" : `/\\:*?"<>|`.includes(char) ? "_" : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "题库";
}

// ---------------------------------------------------------------------------
// Browser-side image collection
// ---------------------------------------------------------------------------

export interface CollectedExportImages {
  images: Map<string, ExportImageData>;
  /** assetIds whose bytes are no longer on this device (evicted cache). */
  missing: string[];
}

interface ExportImageSource {
  blob?: Blob;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

async function browserWebpToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const converted = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!converted) throw new Error("图片转换失败。");
    return converted;
  } finally {
    bitmap.close();
  }
}

/** Gather exportable image bytes through a bounded pool. Excel converts WebP
 *  to PNG for WPS cell-image compatibility; bundles preserve original bytes
 *  and MIME types so content-addressed asset ids remain valid. */
export async function collectExportImages(
  questions: readonly ExportQuestionInput[],
  options: {
    /** Excel/WPS only accepts PNG/JPEG cell images. Portable bundles must keep
     *  the original bytes so the content-addressed asset id remains valid. */
    target?: "excel" | "bundle";
    loadAsset?: (assetId: string) => Promise<ExportImageSource | undefined>;
    convertWebp?: (blob: Blob) => Promise<Blob>;
  } = {},
): Promise<CollectedExportImages> {
  const target = options.target ?? "excel";
  const loadAsset = options.loadAsset ?? (async (assetId: string) => {
    const { dbV7 } = await import("../db/db-v7");
    return dbV7.imageAssets.get(assetId);
  });
  const convertWebp = options.convertWebp ?? browserWebpToPng;
  const images = new Map<string, ExportImageData>();
  const missing: string[] = [];
  const assetIds = collectImageAssetIds(questions);
  const collected = await mapWithConcurrency(assetIds, EXPORT_IMAGE_COLLECTION_CONCURRENCY, async (assetId) => {
    const asset = await loadAsset(assetId);
    if (!asset?.blob) return { assetId };
    let blob = new Blob([asset.blob], { type: asset.mimeType });
    let mimeType = asset.mimeType;
    if (target === "excel" && mimeType === "image/webp") {
      blob = await convertWebp(blob);
      mimeType = "image/png";
    }
    return { assetId, data: { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType, width: asset.width, height: asset.height } satisfies ExportImageData };
  });
  for (const item of collected) {
    if (item.data) images.set(item.assetId, item.data);
    else missing.push(item.assetId);
  }
  return { images, missing };
}

/** Trigger a client-side download, preferring the Web Share API on mobile. */
export async function downloadExport(filename: string, blob: Blob): Promise<void> {
  const file = new File([blob], filename, { type: blob.type });
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  if (mobile && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share({ title: filename, files: [file] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!(error instanceof DOMException) || !["NotAllowedError", "SecurityError"].includes(error.name)) throw error;
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
