import type { AttemptStats } from "../../types/types";
import type { AttemptV7, NoteV7, QuestionV7, ReviewRoundProgress } from "../db/v7-types";
import { statsNeedWrongReview, summarizeAttemptStats, type AttemptSummary } from "../practice/practice-metrics";
import { buildScopedQuestionStats, isQuestionDoneInScope, scopedStatsToAttemptStats, type ProgressScope, type ReferenceTime } from "../practice/progress-scope";
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

export interface SearchDerivedData {
  index: SearchIndexQuestion[];
  indexById: Map<string, SearchIndexQuestion>;
  scopedMetricByQuestion: Map<string, AttemptSummary>;
  normalizedScope: ProgressScope;
}

/**
 * Build the complete Search View read-model from already-targeted local rows.
 * This owns progress/note/stat derivation without depending on React or Dexie;
 * the UI only decides which canonical questions are currently in scope.
 */
export function buildSearchDerivedData({
  questions,
  attemptStats,
  attempts,
  notes,
  roundProgress,
  progressScope,
  referenceTime,
  wrongRemovalStreak,
}: {
  questions: readonly QuestionV7[];
  attemptStats: readonly AttemptStats[];
  attempts: readonly AttemptV7[];
  notes: readonly NoteV7[];
  roundProgress: readonly ReviewRoundProgress[];
  progressScope: ProgressScope;
  referenceTime: ReferenceTime;
  wrongRemovalStreak: number;
}): SearchDerivedData {
  const questionIds = questions.map((question) => question.id);
  const scopedStatsByQuestion = buildScopedQuestionStats(questionIds, progressScope, attempts, roundProgress, referenceTime);
  const scopedMetricByQuestion = new Map([...scopedStatsByQuestion.values()].map((stats) => [stats.questionId, summarizeAttemptStats(scopedStatsToAttemptStats(stats))]));
  const statsByQuestion = new Map(attemptStats.map((stats) => [stats.questionId, stats]));
  const notesByQuestion = new Map(notes.map((note) => [note.questionId, note.content]));
  const scopedLegacyByQuestion = new Map([...scopedStatsByQuestion.values()].map((stats) => [stats.questionId, scopedStatsToAttemptStats(stats)]));
  const index = questions.map((question) => {
    const stats = statsByQuestion.get(question.id);
    const metric = scopedMetricByQuestion.get(question.id) ?? summarizeAttemptStats(stats);
    return buildSearchIndexQuestion(question, {
      explanation: notesByQuestion.get(question.id) ?? "",
      difficulty: metric.difficulty,
      total: metric.total,
      wrong: metric.wrong,
      latest: summarizeAttemptStats(stats).latest,
      done: isQuestionDoneInScope(question.id, progressScope, attemptStats, roundProgress, referenceTime),
      needsWrongReview: statsNeedWrongReview(scopedLegacyByQuestion.get(question.id), wrongRemovalStreak),
    });
  });
  return {
    index,
    indexById: new Map(index.map((item) => [item.id, item])),
    scopedMetricByQuestion,
    normalizedScope: progressScope,
  };
}
