/**
 * Client for the question-bank parse worker.  Imports are rare, heavyweight
 * operations, so one module worker is shared for the page lifetime and reused
 * across files.  The input buffer is transferred (not copied); a worker that
 * fails to start or crashes falls back to the identical main-thread parse by
 * re-reading the File, which keeps imports working in embedded WebViews.
 */
import { deserializeParseError, parseImportBuffer, type ImportParseRequest } from "./import-parse-core";
import type { ImportParseResult, ImportWorkerMessage, ImportWorkerResponse } from "./import-worker-protocol";

/** A small structural Worker type so tests can fake the boundary. */
export interface ImportWorkerLike {
  onmessage: ((event: MessageEvent<ImportWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ImportWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

export type ImportWorkerFactory = () => ImportWorkerLike | undefined;

export interface ImportParseWorkerClient {
  parse(file: File, request: Omit<ImportParseRequest, "buffer">): Promise<ImportParseResult>;
  dispose(): void;
}

function createBrowserWorker(): ImportWorkerLike | undefined {
  if (typeof Worker === "undefined") return undefined;
  try {
    return new Worker(new URL("./import-worker.ts", import.meta.url), { type: "module" });
  } catch {
    // Some embedded WebViews expose Worker but reject module workers; the
    // synchronous main-thread path remains fully functional there.
    return undefined;
  }
}

function toResult(response: Extract<ImportWorkerResponse, { kind: "parsed-xlsx" | "parsed-zip" | "parsed-json" }>): ImportParseResult {
  if (response.kind === "parsed-xlsx") return { kind: "xlsx", rows: response.rows, images: response.images };
  if (response.kind === "parsed-zip") return { kind: "zip", bundle: response.bundle };
  return { kind: "json", raw: response.raw };
}

function buildMessage(requestId: number, buffer: ArrayBuffer, request: Omit<ImportParseRequest, "buffer">): ImportWorkerMessage {
  if (request.kind === "xlsx") return { kind: "parse-xlsx", requestId, buffer, collapseVisualLineBreaks: Boolean(request.collapseVisualLineBreaks) };
  if (request.kind === "zip") return { kind: "parse-zip", requestId, buffer };
  return { kind: "parse-json", requestId, buffer };
}

export function createImportParseWorkerClient(workerFactory: ImportWorkerFactory = createBrowserWorker): ImportParseWorkerClient {
  let worker: ImportWorkerLike | undefined;
  let requestSequence = 0;
  let pending: {
    requestId: number;
    resolve: (result: ImportParseResult) => void;
    reject: (error: unknown) => void;
    fallback: () => Promise<ImportParseResult>;
  } | undefined;
  let disposed = false;

  function stopWorker() {
    worker?.terminate();
    worker = undefined;
  }

  function settleError(error: unknown) {
    const current = pending;
    pending = undefined;
    current?.reject(error);
  }

  function runFallback() {
    const current = pending;
    pending = undefined;
    if (!current) return;
    void current.fallback().then(current.resolve, current.reject);
  }

  function ensureWorker(): ImportWorkerLike | undefined {
    if (worker || disposed) return worker;
    let candidate: ImportWorkerLike | undefined;
    try {
      candidate = workerFactory();
    } catch {
      candidate = undefined;
    }
    if (!candidate) return undefined;
    candidate.onmessage = (event) => {
      const response = event.data;
      const current = pending;
      if (!current || response.requestId !== current.requestId) return;
      if (response.kind === "parse-error") {
        // A deterministic parse failure would fail identically on the main
        // thread; surface it instead of paying for a second full parse.
        settleError(deserializeParseError(response));
        return;
      }
      pending = undefined;
      current.resolve(toResult(response));
    };
    candidate.onerror = () => {
      // The worker itself died mid-parse; retry the same bytes locally.
      stopWorker();
      runFallback();
    };
    worker = candidate;
    return worker;
  }

  return {
    parse(file, request) {
      // One import at a time: the UI disables the trigger while importing, and
      // a concurrent parse would strand the first request forever.
      if (pending) return Promise.reject(new Error("一次只能解析一个题库文件，请等待当前导入完成。"));
      const requestId = ++requestSequence;
      const fallback = async (): Promise<ImportParseResult> => parseImportBuffer({ ...request, buffer: await file.arrayBuffer() });
      const candidate = ensureWorker();
      if (!candidate) return fallback();
      return new Promise<ImportParseResult>((resolve, reject) => {
        pending = { requestId, resolve, reject, fallback };
        void (async () => {
          try {
            // The freshly read buffer is transferred to avoid a second
            // 128 MiB copy; if the worker path fails afterwards the fallback
            // re-reads the File, which remains readable.
            const buffer = await file.arrayBuffer();
            if (pending?.requestId !== requestId) return;
            candidate.postMessage(buildMessage(requestId, buffer, request), [buffer]);
          } catch {
            stopWorker();
            runFallback();
          }
        })();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // An import in flight must not silently vanish; finish it locally.
      runFallback();
      stopWorker();
    },
  };
}

/** Page-lifetime client used by the import UI. */
export const importParseWorker = createImportParseWorkerClient();
