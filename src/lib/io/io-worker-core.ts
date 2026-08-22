/**
 * Shared dispatch for the question-bank io worker.  The worker entry and the
 * main-thread fallback both call it, so an environment without module workers
 * parses imports and builds exports with byte-for-byte identical logic.
 */
import { parseQuestionBankZip } from "../question/question-bank-bundle";
import { buildQuestionBankXlsx, buildQuestionBankZip, questionExportJson, type ExportImageData, type ExportQuestionInput } from "../question/question-bank-export";
import { parseQuestionBankWorkbook, XlsxImportError } from "./xlsx-import";
import type { ExportBuildResult, ImportParseResult } from "./io-worker-protocol";

export interface ImportParseRequest {
  kind: "xlsx" | "zip" | "json";
  buffer: ArrayBuffer;
  collapseVisualLineBreaks?: boolean;
}

export interface ExportBuildRequest {
  kind: "xlsx" | "zip" | "json";
  name: string;
  questions: ExportQuestionInput[];
  notes: Map<string, string>;
  images?: Map<string, ExportImageData>;
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

/** Build one export artifact; rethrows the builders' domain errors as-is. */
export function buildExportArtifact(request: ExportBuildRequest): ExportBuildResult {
  if (request.kind === "xlsx") {
    return { kind: "xlsx", bytes: buildQuestionBankXlsx(request.questions, request.notes, request.images ?? new Map()) };
  }
  if (request.kind === "zip") {
    return { kind: "zip", bytes: buildQuestionBankZip(request.name, request.questions, request.notes, request.images ?? new Map()) };
  }
  return { kind: "json", text: questionExportJson(request.name, request.questions, request.notes) };
}

/** Structured-clone-safe error projection for the worker boundary. */
export function serializeIoError(error: unknown): { message: string; issues: Array<{ row: number; message: string }> } {
  const issues = error instanceof XlsxImportError ? error.issues : [];
  return {
    message: error instanceof Error ? error.message : String(error),
    issues: issues.map((issue) => ({ row: issue.row, message: issue.message })),
  };
}

/** Rehydrate a serialized worker error into the original domain error shape. */
export function deserializeIoError(payload: { message: string; issues: Array<{ row: number; message: string }> }): Error {
  return payload.issues.length ? new XlsxImportError(payload.message, payload.issues) : new Error(payload.message);
}
