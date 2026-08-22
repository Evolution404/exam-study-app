/**
 * Client for the question-bank io worker.  Imports and exports are rare,
 * heavyweight operations, so one module worker is shared for the page
 * lifetime.  Parse inputs are File handles (the buffer is transferred, not
 * copied); build inputs are already in memory.  A worker that fails to start
 * or crashes falls back to the identical main-thread logic, which keeps the
 * pipeline working in embedded WebViews.
 */
import {
  buildExportArtifact,
  deserializeIoError,
  parseImportBuffer,
  type ExportBuildRequest,
  type ImportParseRequest,
} from "./io-worker-core";
import type { ExportBuildResult, ImportParseResult, IoWorkerMessage, IoWorkerResponse } from "./io-worker-protocol";

/** A small structural Worker type so tests can fake the boundary. */
export interface IoWorkerLike {
  onmessage: ((event: MessageEvent<IoWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: IoWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

export type IoWorkerFactory = () => IoWorkerLike | undefined;

export interface IoWorkerClient {
  parse(file: File, request: Omit<ImportParseRequest, "buffer">): Promise<ImportParseResult>;
  build(request: ExportBuildRequest): Promise<ExportBuildResult>;
  dispose(): void;
}

function createBrowserWorker(): IoWorkerLike | undefined {
  if (typeof Worker === "undefined") return undefined;
  try {
    return new Worker(new URL("./io-worker.ts", import.meta.url), { type: "module" });
  } catch {
    // Some embedded WebViews expose Worker but reject module workers; the
    // synchronous main-thread path remains fully functional there.
    return undefined;
  }
}

function toParseResult(response: Extract<IoWorkerResponse, { kind: "parsed-xlsx" | "parsed-zip" | "parsed-json" }>): ImportParseResult {
  if (response.kind === "parsed-xlsx") return { kind: "xlsx", rows: response.rows, images: response.images };
  if (response.kind === "parsed-zip") return { kind: "zip", bundle: response.bundle };
  return { kind: "json", raw: response.raw };
}

function toBuildResult(response: Extract<IoWorkerResponse, { kind: "built-xlsx" | "built-zip" | "built-json" }>): ExportBuildResult {
  if (response.kind === "built-json") return { kind: "json", text: response.text };
  return { kind: response.kind === "built-xlsx" ? "xlsx" : "zip", bytes: response.bytes };
}

function buildMessage(requestId: number, buffer: ArrayBuffer, request: Omit<ImportParseRequest, "buffer">): IoWorkerMessage {
  if (request.kind === "xlsx") return { kind: "parse-xlsx", requestId, buffer, collapseVisualLineBreaks: Boolean(request.collapseVisualLineBreaks) };
  if (request.kind === "zip") return { kind: "parse-zip", requestId, buffer };
  return { kind: "parse-json", requestId, buffer };
}

export function createIoWorkerClient(workerFactory: IoWorkerFactory = createBrowserWorker): IoWorkerClient {
  let worker: IoWorkerLike | undefined;
  let requestSequence = 0;
  let pending: {
    requestId: number;
    /** Settles with the worker's (or fallback's) result; typed `unknown`
     *  because the lane is shared by parse and build tasks. */
    resolve: (result: unknown) => void;
    reject: (error: unknown) => void;
    fallback: () => Promise<unknown> | unknown;
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
    void Promise.resolve(current.fallback()).then(current.resolve, current.reject);
  }

  function ensureWorker(): IoWorkerLike | undefined {
    if (worker || disposed) return worker;
    let candidate: IoWorkerLike | undefined;
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
      if (response.kind === "io-error") {
        // A deterministic parse/build failure would fail identically on the
        // main thread; surface it instead of paying for a second full pass.
        settleError(deserializeIoError(response));
        return;
      }
      pending = undefined;
      current.resolve(
        response.kind === "parsed-xlsx" || response.kind === "parsed-zip" || response.kind === "parsed-json"
          ? toParseResult(response)
          : toBuildResult(response),
      );
    };
    candidate.onerror = () => {
      // The worker itself died mid-task; retry the same work locally.
      stopWorker();
      runFallback();
    };
    worker = candidate;
    return worker;
  }

  function guardLane(): Promise<unknown> | undefined {
    // One io task at a time: a concurrent task would strand the first
    // request's promise forever.
    if (pending) return Promise.reject(new Error("一次只能处理一个题库文件任务，请等待当前任务完成。"));
    return undefined;
  }

  return {
    parse(file, request) {
      const busy = guardLane();
      if (busy) return busy as Promise<ImportParseResult>;
      const requestId = ++requestSequence;
      const fallback = async (): Promise<ImportParseResult> => parseImportBuffer({ ...request, buffer: await file.arrayBuffer() });
      const candidate = ensureWorker();
      if (!candidate) return fallback();
      return new Promise<ImportParseResult>((resolve, reject) => {
        pending = { requestId, resolve: (value) => resolve(value as ImportParseResult), reject, fallback };
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
    build(request) {
      const busy = guardLane();
      if (busy) return busy as Promise<ExportBuildResult>;
      const requestId = ++requestSequence;
      const fallback = (): ExportBuildResult => buildExportArtifact(request);
      const candidate = ensureWorker();
      if (!candidate) return Promise.resolve(fallback());
      const message: IoWorkerMessage = request.kind === "xlsx"
        ? { kind: "build-xlsx", requestId, questions: request.questions, noteEntries: [...request.notes], imageEntries: [...(request.images ?? new Map())] }
        : request.kind === "zip"
          ? { kind: "build-zip", requestId, name: request.name, questions: request.questions, noteEntries: [...request.notes], imageEntries: [...(request.images ?? new Map())] }
          : { kind: "build-json", requestId, name: request.name, questions: request.questions, noteEntries: [...request.notes] };
      return new Promise<ExportBuildResult>((resolve, reject) => {
        pending = { requestId, resolve: (value) => resolve(value as ExportBuildResult), reject, fallback };
        try {
          candidate.postMessage(message);
        } catch {
          stopWorker();
          runFallback();
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // A task in flight must not silently vanish; finish it locally.
      runFallback();
      stopWorker();
    },
  };
}

/** Page-lifetime client used by the import and export UI. */
export const questionBankIoWorker = createIoWorkerClient();
