/**
 * Message contract between the import UI and the parse worker.  Only
 * structured-cloneable data crosses the boundary: the raw file bytes go in
 * (transferred), parsed rows/images/plain JSON come back.  Dexie writes and
 * image materialisation stay on the main thread.
 */
import type { ParsedQuestionBundle } from "../question/question-bank-bundle";
import type { ImportedQuestionRow, WorkbookImage } from "./xlsx-import";

export type ImportWorkerMessage =
  | { kind: "parse-xlsx"; requestId: number; buffer: ArrayBuffer; collapseVisualLineBreaks: boolean }
  | { kind: "parse-zip"; requestId: number; buffer: ArrayBuffer }
  | { kind: "parse-json"; requestId: number; buffer: ArrayBuffer };

export type ImportWorkerResponse =
  | { kind: "parsed-xlsx"; requestId: number; rows: ImportedQuestionRow[]; images: Map<string, WorkbookImage> }
  | { kind: "parsed-zip"; requestId: number; bundle: ParsedQuestionBundle }
  | { kind: "parsed-json"; requestId: number; raw: unknown }
  | {
      kind: "parse-error";
      requestId: number;
      message: string;
      /** Populated when the worker rethrew an XlsxImportError carrying issues. */
      issues: Array<{ row: number; message: string }>;
    };

/** The parse outcome the main thread consumes, with errors rehydrated. */
export type ImportParseResult =
  | { kind: "xlsx"; rows: ImportedQuestionRow[]; images: Map<string, WorkbookImage> }
  | { kind: "zip"; bundle: ParsedQuestionBundle }
  | { kind: "json"; raw: unknown };
