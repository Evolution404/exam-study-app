import { filterSearchIndex, type SearchIndexQuestion } from "@/lib/question/search-matching";
import type { SearchWorkerMessage, SearchWorkerResponse } from "@/app/search/search-worker-protocol";

type WorkerScope = {
  onmessage: ((event: MessageEvent<SearchWorkerMessage>) => void) | null;
  postMessage: (message: SearchWorkerResponse) => void;
};

const workerScope = globalThis as unknown as WorkerScope;
let indexKey = "";
let index: SearchIndexQuestion[] = [];
let latestRequestId = 0;

workerScope.onmessage = (event) => {
  const message = event.data;
  if (message.kind === "set-index") {
    indexKey = message.indexKey;
    index = message.questions;
    return;
  }
  if (message.kind === "cancel") {
    if (message.requestId > latestRequestId) latestRequestId = message.requestId;
    return;
  }

  latestRequestId = Math.max(latestRequestId, message.requestId);
  if (message.indexKey !== indexKey || message.requestId !== latestRequestId) return;
  const result = filterSearchIndex(index, message.request);
  // A newer queued request must win. The client also repeats this guard, so a
  // delayed response can never replace a newer input state.
  if (message.requestId !== latestRequestId) return;
  workerScope.postMessage({ kind: "search-result", requestId: message.requestId, indexKey, result });
};
