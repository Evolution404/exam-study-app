/**
 * Message contract for the question-bank io worker.  Only
 * structured-cloneable data crosses the boundary: raw file bytes go in
 * (transferred) and parsed rows/images/plain JSON come back; export inputs go
 * in and built workbook/zip bytes or JSON text come back.  Dexie access and
 * image materialisation stay on the main thread.
 */
import type { ExportImageData, ExportQuestionInput } from "../question/question-bank-export";
import type { ParsedQuestionBundle } from "../question/question-bank-bundle";
import type { ImportedQuestionRow, WorkbookImage } from "./xlsx-import";

export type IoWorkerMessage =
  | { kind: "parse-xlsx"; requestId: number; buffer: ArrayBuffer; collapseVisualLineBreaks: boolean }
  | { kind: "parse-zip"; requestId: number; buffer: ArrayBuffer }
  | { kind: "parse-json"; requestId: number; buffer: ArrayBuffer }
  | { kind: "build-xlsx"; requestId: number; questions: ExportQuestionInput[]; noteEntries: Array<[string, string]>; imageEntries: Array<[string, ExportImageData]> }
  | { kind: "build-zip"; requestId: number; name: string; questions: ExportQuestionInput[]; noteEntries: Array<[string, string]>; imageEntries: Array<[string, ExportImageData]> }
  | { kind: "build-json"; requestId: number; name: string; questions: ExportQuestionInput[]; noteEntries: Array<[string, string]> };

export type IoWorkerResponse =
  | { kind: "parsed-xlsx"; requestId: number; rows: ImportedQuestionRow[]; images: Map<string, WorkbookImage> }
  | { kind: "parsed-zip"; requestId: number; bundle: ParsedQuestionBundle }
  | { kind: "parsed-json"; requestId: number; raw: unknown }
  | { kind: "built-xlsx"; requestId: number; bytes: Uint8Array }
  | { kind: "built-zip"; requestId: number; bytes: Uint8Array }
  | { kind: "built-json"; requestId: number; text: string }
  | {
      kind: "io-error";
      requestId: number;
      message: string;
      /** Populated when the worker rethrew an XlsxImportError carrying issues. */
      issues: Array<{ row: number; message: string }>;
    };

/** A parse outcome consumed by the import flow. */
export type ImportParseResult =
  | { kind: "xlsx"; rows: ImportedQuestionRow[]; images: Map<string, WorkbookImage> }
  | { kind: "zip"; bundle: ParsedQuestionBundle }
  | { kind: "json"; raw: unknown };

/** A build outcome consumed by the export flow. */
export type ExportBuildResult =
  | { kind: "xlsx" | "zip"; bytes: Uint8Array }
  | { kind: "json"; text: string };
