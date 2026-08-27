// Stable app-layer imports for UI callers. The implementation lives in the
// dependency-free question layer so it can also run in a module Worker.
export {
  SEARCH_CONTENT_SCOPE_OPTIONS,
  SEARCH_TYPE_ORDER,
  createSearchMatcher,
  searchFieldsForQuestion,
} from "@/lib/question/search-matching";
export type {
  SearchContentScope,
  SearchFilterProjection,
  SearchIndexQuestion,
  SearchIndexResult,
} from "@/lib/question/search-matching";
