// Kept as a stable app-layer import for existing callers. The implementation
// lives in the dependency-free question layer so it can run in a module Worker.
export {
  SEARCH_CONTENT_SCOPE_OPTIONS,
  SEARCH_TYPE_ORDER,
  createSearchMatcher,
  emptySearchFilterProjection,
  filterSearchIndex,
  searchFieldsForQuestion,
  searchIndexFingerprint,
} from "@/lib/question/search-matching";
export type {
  SearchContentScope,
  SearchFilterProjection,
  SearchIndexQuestion,
  SearchIndexRequest,
  SearchIndexResult,
  SearchKeywordMode,
  SearchMatcher,
  SearchNoteFilter,
  SearchQuestionType,
  SearchStatus,
  SearchTagMatch,
  SearchTypeTab,
} from "@/lib/question/search-matching";
