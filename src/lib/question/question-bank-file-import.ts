import { importQuestionBankV7, putImageAssetV7 } from "../db/db-v7";
import { importFileName, type WorkbookImage } from "../io/xlsx-import";
import { questionBankIoWorker } from "../io/io-worker-client";
import { sniffImageDimensions } from "../io/image-dimensions";
import { sha256Bytes, type ImageMimeType } from "../io/image-assets";
import type { BankV7, ImageAsset } from "../db/v7-types";
import { isVisualWrapExtractionSource } from "./imported-text-cleanup";
import { mapWithConcurrency } from "../async/bounded-concurrency";
import { IMPORT_LIMITS } from "../io/import-limits";

export const QUESTION_BANK_FILE_ACCEPT = ".json,.xlsx,.zip,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip";

export type QuestionBankFileType = "json" | "xlsx" | "zip";
export const QUESTION_BANK_IMAGE_IMPORT_CONCURRENCY = 6;

export function detectQuestionBankFileType(file: Pick<File, "name" | "type">): QuestionBankFileType {
  const name = file.name.trim().toLowerCase();
  const mime = file.type.trim().toLowerCase();
  if (name.endsWith(".xlsx") || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (name.endsWith(".zip") || mime === "application/zip" || mime === "application/x-zip-compressed") return "zip";
  if (name.endsWith(".json") || mime === "application/json" || mime === "text/json") return "json";
  throw new Error("不支持这种文件，请选择 JSON、XLSX 或 zip 题库文件。");
}

/** Store raw image bytes as a content-addressed asset and return its id. */
async function storeImageAsset(bytes: Uint8Array, mimeType: ImageMimeType, width: number, height: number): Promise<ImageAsset> {
  const assetId = await sha256Bytes(bytes);
  const blob = new Blob([bytes.slice()], { type: mimeType });
  return putImageAssetV7({ id: assetId, blob, mimeType, size: bytes.byteLength, width, height });
}

/** Materialise only workbook images referenced by imported rows. Some WPS
 *  workbooks retain unrelated media from their source workbook, which should
 *  neither consume local storage nor enter the upload queue. */
async function materializeWorkbookImages(images: ReadonlyMap<string, WorkbookImage>, referencedIds: ReadonlySet<string>): Promise<{ mapping: Map<string, string>; assets: Array<Omit<ImageAsset, "blob">> }> {
  const selected = [...referencedIds].map((dispimgId) => {
    const image = images.get(dispimgId);
    if (!image) throw new Error(`图片 ${dispimgId.slice(0, 12)}… 在 Excel 媒体包中不存在。`);
    return [dispimgId, image] as const;
  });
  const materialized = await mapWithConcurrency(selected, QUESTION_BANK_IMAGE_IMPORT_CONCURRENCY, async ([dispimgId, image]) => {
    const dimensions = sniffImageDimensions(image.bytes);
    if (!dimensions) throw new Error(`嵌入图片 ${dispimgId.slice(0, 12)}… 无法识别尺寸，Excel 文件可能已损坏。`);
    const stored = await storeImageAsset(image.bytes, image.mimeType, dimensions.width, dimensions.height);
    const { blob: _blob, ...descriptor } = stored;
    void _blob;
    return { dispimgId, descriptor };
  });
  return {
    mapping: new Map(materialized.map(({ dispimgId, descriptor }) => [dispimgId, descriptor.id])),
    assets: materialized.map(({ descriptor }) => descriptor),
  };
}

export async function importQuestionBankFile(file: File, options?: { targetBankId?: string }): Promise<{ bank: BankV7; importedCount: number; type: QuestionBankFileType }> {
  const type = detectQuestionBankFileType(file);
  if (type === "xlsx" || type === "zip") {
    // Parsing runs in the shared module worker; only image materialisation
    // and the Dexie import remain on the main thread.
    const parsed = await questionBankIoWorker.parse(file, type === "xlsx"
      ? { kind: "xlsx", collapseVisualLineBreaks: isVisualWrapExtractionSource(file.name) }
      : { kind: "zip" });
    if (parsed.kind === "xlsx") {
      const { rows, images } = parsed;
      const referencedIds = new Set(rows.flatMap((row) => row.images ?? []));
      const { mapping: assetByDispimg, assets } = await materializeWorkbookImages(images, referencedIds);
      for (const row of rows) {
        if (row.images?.length) row.images = row.images.map((id) => assetByDispimg.get(id) ?? id);
      }
      const bank = await importQuestionBankV7(importFileName(file.name), rows, { ...options, imageAssets: assets });
      return { bank, importedCount: bank.importedCount, type };
    }
    if (parsed.kind !== "zip") throw new Error("导入解析结果类型不匹配，请重试。");
    const bundle = parsed.bundle;
    const assets = await mapWithConcurrency(bundle.images, QUESTION_BANK_IMAGE_IMPORT_CONCURRENCY, async (image) => {
      const stored = await storeImageAsset(image.bytes, image.mimeType, image.width, image.height);
      const { blob: _blob, ...descriptor } = stored;
      void _blob;
      return descriptor;
    });
    const bank = await importQuestionBankV7(file.name, { name: bundle.name ?? file.name.replace(/\.zip$/i, ""), questions: bundle.questions }, { ...options, imageAssets: assets });
    return { bank, importedCount: bank.importedCount, type };
  }
  if (file.size > IMPORT_LIMITS.json.maxBytes) throw new Error("JSON 文件超过 128 MB 上限。");
  const parsedJson = await questionBankIoWorker.parse(file, { kind: "json" });
  if (parsedJson.kind !== "json") throw new Error("导入解析结果类型不匹配，请重试。");
  const raw: unknown = parsedJson.raw;
  const questionRows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).questions)
      ? (raw as { questions: unknown[] }).questions
      : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).items)
        ? (raw as { items: unknown[] }).items
        : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).data)
          ? (raw as { data: unknown[] }).data
          : undefined;
  if (questionRows && questionRows.length > IMPORT_LIMITS.json.maxQuestions) throw new Error(`JSON 题库最多包含 ${IMPORT_LIMITS.json.maxQuestions} 道题。`);
  const bank = await importQuestionBankV7(file.name, raw, options);
  return { bank, importedCount: bank.importedCount, type };
}
