/// <reference lib="webworker" />
/**
 * Question-bank parse worker: runs the hand-rolled xlsx/zip readers and the
 * JSON.parse of files up to the 128–256 MiB import ceiling off the main
 * thread.  The dispatch logic lives in import-parse-core so a failed worker
 * can always be retried on the main thread with byte-identical behavior.
 */
import { parseImportBuffer, serializeParseError } from "./import-parse-core";
import type { ImportWorkerMessage, ImportWorkerResponse } from "./import-worker-protocol";

function post(response: ImportWorkerResponse): void {
  (self as unknown as Worker).postMessage(response);
}

self.onmessage = (event: MessageEvent<ImportWorkerMessage>) => {
  const message = event.data;
  const request = message.kind === "parse-xlsx"
    ? { kind: "xlsx" as const, buffer: message.buffer, collapseVisualLineBreaks: message.collapseVisualLineBreaks }
    : message.kind === "parse-zip"
      ? { kind: "zip" as const, buffer: message.buffer }
      : { kind: "json" as const, buffer: message.buffer };
  void parseImportBuffer(request).then(
    (result) => {
      if (result.kind === "xlsx") post({ kind: "parsed-xlsx", requestId: message.requestId, rows: result.rows, images: result.images });
      else if (result.kind === "zip") post({ kind: "parsed-zip", requestId: message.requestId, bundle: result.bundle });
      else post({ kind: "parsed-json", requestId: message.requestId, raw: result.raw });
    },
    (error: unknown) => {
      post({ kind: "parse-error", requestId: message.requestId, ...serializeParseError(error) });
    },
  );
};
