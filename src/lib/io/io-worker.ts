/// <reference lib="webworker" />
/**
 * Question-bank io worker: runs the hand-rolled xlsx/zip readers, the
 * JSON.parse of files up to the 128–256 MiB import ceiling and the export
 * builders off the main thread.  The dispatch logic lives in io-worker-core
 * so a failed worker can always be retried on the main thread with
 * byte-identical behavior.
 */
import { buildExportArtifact, parseImportBuffer, serializeIoError, type ExportBuildRequest, type ImportParseRequest } from "./io-worker-core";
import type { IoWorkerMessage, IoWorkerResponse } from "./io-worker-protocol";

function post(response: IoWorkerResponse): void {
  (self as unknown as Worker).postMessage(response);
}

function toParseRequest(message: Extract<IoWorkerMessage, { kind: "parse-xlsx" | "parse-zip" | "parse-json" }>): ImportParseRequest {
  if (message.kind === "parse-xlsx") return { kind: "xlsx", buffer: message.buffer, collapseVisualLineBreaks: message.collapseVisualLineBreaks };
  if (message.kind === "parse-zip") return { kind: "zip", buffer: message.buffer };
  return { kind: "json", buffer: message.buffer };
}

function toBuildRequest(message: Extract<IoWorkerMessage, { kind: "build-xlsx" | "build-zip" | "build-json" }>): ExportBuildRequest {
  if (message.kind === "build-xlsx") {
    return { kind: "xlsx", name: "", questions: message.questions, notes: new Map(message.noteEntries), images: new Map(message.imageEntries) };
  }
  if (message.kind === "build-zip") {
    return { kind: "zip", name: message.name, questions: message.questions, notes: new Map(message.noteEntries), images: new Map(message.imageEntries) };
  }
  return { kind: "json", name: message.name, questions: message.questions, notes: new Map(message.noteEntries) };
}

self.onmessage = (event: MessageEvent<IoWorkerMessage>) => {
  const message = event.data;
  if (message.kind === "build-xlsx" || message.kind === "build-zip" || message.kind === "build-json") {
    try {
      const result = buildExportArtifact(toBuildRequest(message));
      if (result.kind === "json") post({ kind: "built-json", requestId: message.requestId, text: result.text });
      else post({ kind: result.kind === "xlsx" ? "built-xlsx" : "built-zip", requestId: message.requestId, bytes: result.bytes });
    } catch (error: unknown) {
      post({ kind: "io-error", requestId: message.requestId, ...serializeIoError(error) });
    }
    return;
  }
  void parseImportBuffer(toParseRequest(message)).then(
    (result) => {
      if (result.kind === "xlsx") post({ kind: "parsed-xlsx", requestId: message.requestId, rows: result.rows, images: result.images });
      else if (result.kind === "zip") post({ kind: "parsed-zip", requestId: message.requestId, bundle: result.bundle });
      else post({ kind: "parsed-json", requestId: message.requestId, raw: result.raw });
    },
    (error: unknown) => {
      post({ kind: "io-error", requestId: message.requestId, ...serializeIoError(error) });
    },
  );
};
