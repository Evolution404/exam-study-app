import { importQuestionBankV6, putImageAssetV6 } from "./db-v6";
import { importFileName, parseQuestionBankWorkbook, type WorkbookImage } from "./xlsx-import";
import { parseQuestionBankZip } from "./question-bank-bundle";
import { sniffImageDimensions } from "./image-dimensions";
import { sha256Bytes, type ImageMimeType } from "./image-assets";
import type { BankV6 } from "./v6-types";

export const QUESTION_BANK_FILE_ACCEPT = ".json,.xlsx,.zip,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip";

export type QuestionBankFileType = "json" | "xlsx" | "zip";

export function detectQuestionBankFileType(file: Pick<File, "name" | "type">): QuestionBankFileType {
  const name = file.name.trim().toLowerCase();
  const mime = file.type.trim().toLowerCase();
  if (name.endsWith(".xlsx") || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (name.endsWith(".zip") || mime === "application/zip" || mime === "application/x-zip-compressed") return "zip";
  if (name.endsWith(".json") || mime === "application/json" || mime === "text/json") return "json";
  throw new Error("不支持这种文件，请选择 JSON、XLSX 或 zip 题库文件。");
}

/** Store raw image bytes as a content-addressed asset and return its id. */
async function storeImageAsset(bytes: Uint8Array, mimeType: ImageMimeType, width: number, height: number): Promise<string> {
  const assetId = await sha256Bytes(bytes);
  const blob = new Blob([bytes.slice()], { type: mimeType });
  await putImageAssetV6({ id: assetId, blob, mimeType, size: bytes.byteLength, width, height });
  return assetId;
}

/** Materialise every workbook cell image (DISPIMG id → media bytes) as a v6
 *  asset and return the DISPIMG id → asset id mapping for row remapping. */
async function materializeWorkbookImages(images: ReadonlyMap<string, WorkbookImage>): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  for (const [dispimgId, image] of images) {
    const dimensions = sniffImageDimensions(image.bytes);
    if (!dimensions) throw new Error(`嵌入图片 ${dispimgId.slice(0, 12)}… 无法识别尺寸，Excel 文件可能已损坏。`);
    mapping.set(dispimgId, await storeImageAsset(image.bytes, image.mimeType, dimensions.width, dimensions.height));
  }
  return mapping;
}

export async function importQuestionBankFile(file: File): Promise<{ bank: BankV6; type: QuestionBankFileType }> {
  const type = detectQuestionBankFileType(file);
  if (type === "xlsx") {
    const { rows, images } = await parseQuestionBankWorkbook(await file.arrayBuffer());
    const assetByDispimg = await materializeWorkbookImages(images);
    for (const row of rows) {
      if (row.images?.length) row.images = row.images.map((id) => assetByDispimg.get(id) ?? id);
    }
    const bank = await importQuestionBankV6(importFileName(file.name), rows);
    return { bank, type };
  }
  if (type === "zip") {
    const bundle = await parseQuestionBankZip(await file.arrayBuffer());
    for (const image of bundle.images) await storeImageAsset(image.bytes, image.mimeType, image.width, image.height);
    const bank = await importQuestionBankV6(file.name, { name: bundle.name ?? file.name.replace(/\.zip$/i, ""), questions: bundle.questions });
    return { bank, type };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error("JSON 文件内容无法解析，请检查文件格式。");
  }
  return { bank: await importQuestionBankV6(file.name, raw), type };
}
