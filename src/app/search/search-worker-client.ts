import { filterSearchIndex, type SearchIndexQuestion, type SearchIndexRequest, type SearchIndexResult } from "@/lib/question/search-matching";
import type { SearchWorkerMessage, SearchWorkerResponse } from "@/app/search/search-worker-protocol";

/** A small structural Worker type keeps the client straightforward to fake in tests. */
export interface SearchWorkerLike {
  onmessage: ((event: MessageEvent<SearchWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SearchWorkerMessage): void;
  terminate(): void;
}

export interface SearchWorkerSearchInput {
  indexKey: string;
  index: SearchIndexQuestion[];
  request: SearchIndexRequest;
}

export interface SearchWorkerClientOptions {
  /** Small indexes stay synchronous to avoid worker startup/message overhead. */
  threshold?: number;
  workerFactory?: () => SearchWorkerLike | undefined;
}

export interface SearchWorkerClient {
  /** Resolves undefined when this request was superseded by a newer request. */
  search(input: SearchWorkerSearchInput): Promise<SearchIndexResult | undefined>;
  cancel(): void;
  dispose(): void;
}

const DEFAULT_WORKER_THRESHOLD = 500;

function createBrowserWorker(): SearchWorkerLike | undefined {
  if (typeof Worker === "undefined") return undefined;
  try {
    return new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
  } catch {
    // Some embedded WebViews expose Worker but reject module workers. The
    // synchronous path remains fully functional in that environment.
    return undefined;
  }
}

/**
 * Search controller shared by the large search page and top-bar quick search.
 * It transfers only SearchIndexQuestion projections (text/numbers), never
 * QuestionViewModel.canonical or any image Blob.
 */
export function createSearchWorkerClient(options: SearchWorkerClientOptions = {}): SearchWorkerClient {
  const threshold = Math.max(0, options.threshold ?? DEFAULT_WORKER_THRESHOLD);
  const workerFactory = options.workerFactory ?? createBrowserWorker;
  let worker: SearchWorkerLike | undefined;
  let indexedKey = "";
  let requestSequence = 0;
  let latestRequestId = 0;
  let pending: {
    requestId: number;
    resolve: (result: SearchIndexResult | undefined) => void;
    fallback: () => SearchIndexResult | undefined;
  } | undefined;
  let disposed = false;

  function settlePending(result: SearchIndexResult | undefined) {
    const current = pending;
    pending = undefined;
    current?.resolve(result);
  }

  function runFallback(input: SearchWorkerSearchInput, requestId: number) {
    const result = filterSearchIndex(input.index, input.request);
    if (requestId !== latestRequestId || disposed) return undefined;
    return result;
  }

  function stopWorker() {
    worker?.terminate();
    worker = undefined;
    indexedKey = "";
  }

  function fallbackLatest(input: SearchWorkerSearchInput, requestId: number) {
    const result = runFallback(input, requestId);
    if (requestId === latestRequestId) settlePending(result);
  }

  function ensureWorker() {
    if (worker || disposed) return worker;
    let candidate: SearchWorkerLike | undefined;
    try {
      candidate = workerFactory();
    } catch {
      candidate = undefined;
    }
    if (!candidate) return undefined;
    candidate.onmessage = (event) => {
      const response = event.data;
      if (response.kind !== "search-result" || response.requestId !== latestRequestId || response.indexKey !== indexedKey) return;
      settlePending(response.result);
    };
    candidate.onerror = () => {
      const current = pending;
      stopWorker();
      if (current && current.requestId === latestRequestId) {
        current.resolve(current.fallback());
        pending = undefined;
      }
    };
    worker = candidate;
    return worker;
  }

  function cancel() {
    latestRequestId = ++requestSequence;
    if (worker) {
      try { worker.postMessage({ kind: "cancel", requestId: latestRequestId }); } catch { stopWorker(); }
    }
    settlePending(undefined);
  }

  return {
    search(input) {
      const requestId = ++requestSequence;
      latestRequestId = requestId;
      settlePending(undefined);
      if (disposed) return Promise.resolve(undefined);

      if (input.index.length < threshold) return Promise.resolve(runFallback(input, requestId));
      const candidate = ensureWorker();
      if (!candidate) return Promise.resolve(runFallback(input, requestId));

      return new Promise<SearchIndexResult | undefined>((resolve) => {
        pending = { requestId, resolve, fallback: () => runFallback(input, requestId) };
        try {
          if (indexedKey !== input.indexKey) {
            candidate.postMessage({ kind: "set-index", indexKey: input.indexKey, questions: input.index });
            indexedKey = input.indexKey;
          }
          candidate.postMessage({ kind: "search", requestId, indexKey: input.indexKey, request: input.request });
        } catch {
          stopWorker();
          fallbackLatest(input, requestId);
        }
      });
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      latestRequestId = ++requestSequence;
      settlePending(undefined);
      stopWorker();
    },
  };
}
