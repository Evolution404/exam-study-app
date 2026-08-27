import { QUESTION_TYPE_ORDER, type QuestionType } from "../../types/types";

/**
 * Pure search/index primitives shared by the search page, quick search and
 * the module worker.  Keep this module free of React, Dexie and Blob values:
 * the worker receives only this small text/number projection.
 */

export type SearchContentScope = "all" | "stem" | "options" | "explanation";
export type SearchKeywordMode = "plain" | "regex";
export type SearchStatus = "all" | "unanswered" | "wrong" | "favorite";
export type SearchNoteFilter = "all" | "with" | "without";
export type SearchTagMatch = "any" | "all";
export type SearchQuestionType = QuestionType;
export type SearchTypeTab = "全部" | SearchQuestionType;

export const SEARCH_TYPE_ORDER: readonly SearchQuestionType[] = QUESTION_TYPE_ORDER;

/** Zeroed per-type counters, derived so new question types cannot be missed. */
export function emptyTypeCounts(): Record<SearchQuestionType, number> {
  const counts = {} as Record<SearchQuestionType, number>;
  for (const type of SEARCH_TYPE_ORDER) counts[type] = 0;
  return counts;
}

export const SEARCH_CONTENT_SCOPE_OPTIONS: Array<{ value: SearchContentScope; label: string }> = [
  { value: "all", label: "全部" },
  { value: "stem", label: "题干" },
  { value: "options", label: "选项" },
  { value: "explanation", label: "解析" },
];

export interface SearchFilterProjection {
  keywordMode: SearchKeywordMode;
  contentScope: SearchContentScope;
  status: SearchStatus;
  tags: readonly string[];
  tagMatch: SearchTagMatch;
  noteFilter: SearchNoteFilter;
  difficultyMin: number | null;
  difficultyMax: number | null;
  attemptsMin: number | null;
  attemptsMax: number | null;
  wrongMin: number | null;
  wrongMax: number | null;
  lastFrom: number | null;
  lastTo: number | null;
}

/** The serializable fields needed by the matcher and filter predicates. */
export interface SearchIndexQuestion {
  id: string;
  type: SearchQuestionType;
  stem: string;
  options: readonly string[];
  /** Canonical answer text that is safe and useful for all-fields search. */
  answer?: string;
  tags: readonly string[];
  explanation: string;
  favorite: boolean;
  difficulty: number;
  total: number;
  wrong: number;
  latest: number | null;
  done: boolean;
  needsWrongReview: boolean;
}

export interface SearchIndexRequest {
  query: string;
  filters: SearchFilterProjection;
  typeTab?: SearchTypeTab;
  limit?: number;
}

export interface SearchIndexResult {
  ids: string[];
  total: number;
  counts: Record<SearchQuestionType, number>;
  error: string;
}

const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_FIELD_LENGTH = 20_000;

/**
 * Return the exact fields a keyword query is allowed to inspect.
 * Tags and canonical answer text are part of the all-fields search contract,
 * while the three focused modes deliberately exclude them so a field
 * selection is real.
 */
export function searchFieldsForQuestion(
  question: Pick<SearchIndexQuestion, "stem" | "options" | "answer" | "tags">,
  explanation: string,
  scope: SearchContentScope,
): string[] {
  switch (scope) {
    case "stem": return [question.stem];
    case "options": return [...question.options];
    case "explanation": return [explanation];
    case "all": return [question.stem, ...question.options, question.answer ?? "", ...question.tags, explanation];
  }
}

function hasNestedQuantifier(query: string) {
  // A small conservative guard for the common catastrophic-backtracking
  // shape, e.g. `(a+)+` or `(.*){2,}`. Valid ordinary expressions continue to
  // work; suspicious patterns receive a readable validation error instead of
  // blocking the UI on a large local question bank.
  return /\([^()]*[+*][^()]*\)\s*(?:[+*]|\{\d)/.test(query);
}

export interface SearchMatcher {
  query: string;
  error: string;
  matches: (fields: readonly string[]) => boolean;
}

/** Compile a plain or regular-expression query with bounded input safety. */
export function createSearchMatcher(query: string, mode: SearchKeywordMode): SearchMatcher {
  const normalized = query.trim();
  if (!normalized) return { query: "", error: "", matches: () => true };
  if (normalized.length > MAX_SEARCH_QUERY_LENGTH) {
    return { query: normalized, error: `搜索关键词不能超过 ${MAX_SEARCH_QUERY_LENGTH} 个字符`, matches: () => false };
  }

  if (mode === "plain") {
    const lower = normalized.toLocaleLowerCase("zh-CN");
    return {
      query: normalized,
      error: "",
      matches: (fields) => fields.some((field) => field.slice(0, MAX_SEARCH_FIELD_LENGTH).toLocaleLowerCase("zh-CN").includes(lower)),
    };
  }

  if (hasNestedQuantifier(normalized)) {
    return { query: normalized, error: "正则表达式过于复杂，请改用较简单的表达式", matches: () => false };
  }
  try {
    const pattern = new RegExp(normalized, "i");
    return {
      query: normalized,
      error: "",
      matches: (fields) => fields.some((field) => pattern.test(field.slice(0, MAX_SEARCH_FIELD_LENGTH))),
    };
  } catch {
    return { query: normalized, error: "正则表达式格式不正确", matches: () => false };
  }
}

function matchesTagSelection(questionTags: readonly string[], selectedTags: readonly string[], mode: SearchTagMatch) {
  if (!selectedTags.length) return true;
  const available = new Set(questionTags);
  return mode === "all"
    ? selectedTags.every((tag) => available.has(tag))
    : selectedTags.some((tag) => available.has(tag));
}

function countByType(questions: readonly SearchIndexQuestion[]): Record<SearchQuestionType, number> {
  const counts = emptyTypeCounts();
  for (const question of questions) counts[question.type] += 1;
  return counts;
}

function between(value: number, minimum: number | null, maximum: number | null) {
  return (minimum === null || value >= minimum) && (maximum === null || value <= maximum);
}

function matchesFilters(question: SearchIndexQuestion, matcher: SearchMatcher, filters: SearchFilterProjection) {
  const queryMatches = !matcher.query || matcher.matches(searchFieldsForQuestion(question, question.explanation, filters.contentScope));
  if (!queryMatches) return false;
  if (!matchesTagSelection(question.tags, filters.tags, filters.tagMatch)) return false;
  if (filters.status === "unanswered" && question.done) return false;
  if (filters.status === "wrong" && !question.needsWrongReview) return false;
  if (filters.status === "favorite" && !question.favorite) return false;
  if (filters.noteFilter === "with" && !question.explanation.trim()) return false;
  if (filters.noteFilter === "without" && question.explanation.trim()) return false;
  if (!between(question.difficulty, filters.difficultyMin, filters.difficultyMax)) return false;
  if (!between(question.total, filters.attemptsMin, filters.attemptsMax)) return false;
  if (!between(question.wrong, filters.wrongMin, filters.wrongMax)) return false;
  if ((filters.lastFrom !== null || filters.lastTo !== null) && question.latest === null) return false;
  if (filters.lastFrom !== null && question.latest !== null && question.latest < filters.lastFrom) return false;
  if (filters.lastTo !== null && question.latest !== null && question.latest > filters.lastTo) return false;
  return true;
}

/**
 * Filter and order an index without touching UI/database objects. This is the
 * worker's complete pure operation and is also the deterministic fallback used
 * when a module Worker is unavailable or the index is small.
 */
export function filterSearchIndex(questions: readonly SearchIndexQuestion[], request: SearchIndexRequest): SearchIndexResult {
  const matcher = createSearchMatcher(request.query, request.filters.keywordMode);
  if (matcher.error) return { ids: [], total: 0, counts: emptyTypeCounts(), error: matcher.error };

  const matched = questions.filter((question) => matchesFilters(question, matcher, request.filters));
  const counts = countByType(matched);
  const typeTab = request.typeTab ?? "全部";
  const ordered = SEARCH_TYPE_ORDER.flatMap((type) => typeTab !== "全部" && type !== typeTab
    ? []
    : matched.filter((question) => question.type === type));
  const limit = request.limit === undefined ? ordered.length : Math.max(0, Math.floor(request.limit));
  return { ids: ordered.slice(0, limit).map((question) => question.id), total: ordered.length, counts, error: "" };
}

/** Empty filters used by quick search, which only applies a keyword query. */
export function emptySearchFilterProjection(contentScope: SearchContentScope = "all"): SearchFilterProjection {
  return {
    keywordMode: "regex",
    contentScope,
    status: "all",
    tags: [],
    tagMatch: "any",
    noteFilter: "all",
    difficultyMin: null,
    difficultyMax: null,
    attemptsMin: null,
    attemptsMax: null,
    wrongMin: null,
    wrongMax: null,
    lastFrom: null,
    lastTo: null,
  };
}

/** Stable lightweight key for deciding whether a worker index must be resent. */
export function searchIndexFingerprint(questions: readonly SearchIndexQuestion[]): string {
  let hash = 2_166_136_261;
  for (const question of questions) {
    const value = [
      question.id,
      question.type,
      question.stem,
      question.options.join("\u001f"),
      question.answer ?? "",
      question.tags.join("\u001f"),
      question.explanation,
      question.favorite ? "1" : "0",
      String(question.difficulty),
      String(question.total),
      String(question.wrong),
      String(question.latest ?? ""),
      question.done ? "1" : "0",
      question.needsWrongReview ? "1" : "0",
    ].join("\u001e");
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
  }
  return `${questions.length}:${hash >>> 0}`;
}
