import type { QuestionViewModel } from "@/app/bank/question-editor";

/** Which parts of a question are searched by a keyword query. */
export type SearchContentScope = "all" | "stem" | "options" | "explanation";

export const SEARCH_CONTENT_SCOPE_OPTIONS: Array<{ value: SearchContentScope; label: string }> = [
  { value: "all", label: "全部" },
  { value: "stem", label: "题干" },
  { value: "options", label: "选项" },
  { value: "explanation", label: "解析" },
];

const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_FIELD_LENGTH = 20_000;

/**
 * Return the exact fields a keyword query is allowed to inspect.
 * Tags are part of the existing all-fields search contract, while the three
 * focused modes deliberately exclude tags so a field selection is real.
 */
export function searchFieldsForQuestion(question: Pick<QuestionViewModel, "stem" | "options" | "tags">, explanation: string, scope: SearchContentScope): string[] {
  switch (scope) {
    case "stem": return [question.stem];
    case "options": return question.options;
    case "explanation": return [explanation];
    case "all": return [question.stem, ...question.options, ...question.tags, explanation];
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
export function createSearchMatcher(query: string, mode: "plain" | "regex"): SearchMatcher {
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
