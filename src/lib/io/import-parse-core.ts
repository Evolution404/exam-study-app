/**
 * Shared parse dispatcher for the question-bank import pipeline.  The worker
 * entry and the main-thread fallback both call it, so an environment without
 * module workers parses with byte-for-byte identical logic.
 */
import { parseQuestionBankZip } from "../question/question-bank-bundle";
import { parseQuestionBankWorkbook, XlsxImportError } from "./xlsx-import";
import type { ImportParseResult } from "./import-worker-protocol";

export interface ImportParseRequest {
  kind: "xlsx" | "zip" | "json";
  buffer: ArrayBuffer;
  collapseVisualLineBreaks?: boolean;
}

/** Parse one file buffer; rethrows the readers' domain errors as-is. */
export async function parseImportBuffer(request: ImportParseRequest): Promise<ImportParseResult> {
  if (request.kind === "xlsx") {
    const { rows, images } = await parseQuestionBankWorkbook(request.buffer, {
      collapseVisualLineBreaks: Boolean(request.collapseVisualLineBreaks),
    });
    return { kind: "xlsx", rows, images };
  }
  if (request.kind === "zip") {
    return { kind: "zip", bundle: await parseQuestionBankZip(request.buffer) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(request.buffer));
  } catch {
    throw new Error("JSON 文件内容无法解析，请检查文件格式。");
  }
  return { kind: "json", raw };
}

/** Structured-clone-safe error projection for the worker boundary. */
export function serializeParseError(error: unknown): { message: string; issues: Array<{ row: number; message: string }> } {
  const issues = error instanceof XlsxImportError ? error.issues : [];
  return {
    message: error instanceof Error ? error.message : String(error),
    issues: issues.map((issue) => ({ row: issue.row, message: issue.message })),
  };
}

/** Rehydrate a serialized parse error into the original domain error shape. */
export function deserializeParseError(payload: { message: string; issues: Array<{ row: number; message: string }> }): Error {
  return payload.issues.length ? new XlsxImportError(payload.message, payload.issues) : new Error(payload.message);
}
