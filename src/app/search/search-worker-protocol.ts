import type {
  SearchIndexQuestion,
  SearchIndexRequest,
  SearchIndexResult,
} from "@/lib/question/search-matching";

export type SearchWorkerMessage =
  | { kind: "set-index"; indexKey: string; questions: SearchIndexQuestion[] }
  | { kind: "search"; requestId: number; indexKey: string; request: SearchIndexRequest }
  | { kind: "cancel"; requestId: number };

export interface SearchWorkerResponse {
  kind: "search-result";
  requestId: number;
  indexKey: string;
  result: SearchIndexResult;
}
