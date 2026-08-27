import type { QuestionV7 } from "../db/v7-types";
import { deriveContentText } from "./question-content";
import { questionAnswerTextV7 } from "./question-answer-text";
import type { SearchIndexQuestion } from "./search-matching";

/**
 * Runtime-only fields that enrich a canonical question for search filters.
 * The canonical searchable content itself is always derived from QuestionV7
 * in this module so Quick Search and Search View cannot drift apart.
 */
export interface SearchIndexContext {
  explanation?: string;
  difficulty?: number;
  total?: number;
  wrong?: number;
  latest?: number | null;
  done?: boolean;
  needsWrongReview?: boolean;
}

/**
 * Build the serializable search read-model for one current-schema question.
 * Keep this layer pure: callers supply note/stats/progress context and this
 * module owns every canonical searchable question field.
 */
export function buildSearchIndexQuestion(question: QuestionV7, context: SearchIndexContext = {}): SearchIndexQuestion {
  return {
    id: question.id,
    type: question.type,
    stem: deriveContentText(question.content),
    options: question.options.map((blocks) => deriveContentText(blocks)),
    answer: questionAnswerTextV7(question),
    tags: [...question.tags],
    explanation: context.explanation ?? "",
    favorite: Boolean(question.favorite),
    difficulty: context.difficulty ?? 50,
    total: context.total ?? 0,
    wrong: context.wrong ?? 0,
    latest: context.latest ?? null,
    done: context.done ?? false,
    needsWrongReview: context.needsWrongReview ?? false,
  };
}
