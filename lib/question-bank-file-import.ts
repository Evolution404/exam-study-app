import { importQuestionBankV6 } from "./db-v6";
import { importFileName, parseQuestionBankWorkbook } from "./xlsx-import";
import type { BankV6 } from "./v6-types";

export const QUESTION_BANK_FILE_ACCEPT = ".json,.xlsx,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type QuestionBankFileType = "json" | "xlsx";

export function detectQuestionBankFileType(file: Pick<File, "name" | "type">): QuestionBankFileType {
  const name = file.name.trim().toLowerCase();
  const mime = file.type.trim().toLowerCase();
  if (name.endsWith(".xlsx") || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (name.endsWith(".json") || mime === "application/json" || mime === "text/json") return "json";
  throw new Error("不支持这种文件，请选择 JSON 或 XLSX 题库文件。");
}

export async function importQuestionBankFile(file: File): Promise<{ bank: BankV6; type: QuestionBankFileType }> {
  const type = detectQuestionBankFileType(file);
  if (type === "xlsx") {
    const rows = await parseQuestionBankWorkbook(await file.arrayBuffer());
    const bank = await importQuestionBankV6(importFileName(file.name), rows);
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
