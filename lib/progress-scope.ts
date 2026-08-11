import type { ReviewRoundProgress } from "./v6-types";

/** Minimal global projection required to decide whether a question is done. */
export interface ProgressAttemptStats {
  questionId: string;
  total: number;
  latestAttemptAt: string;
}

export type ProgressScope =
  | { type: "lifetime" }
  | { type: "rolling"; days: number }
  | { type: "round"; roundId: string };

export interface ProgressCompletion {
  total: number;
  completed: number;
  percent: number;
}

export type ReferenceTime = Date | string | number;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCOPE: ProgressScope = { type: "rolling", days: 90 };

function epochMs(value: ReferenceTime): number {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(result)) throw new RangeError("referenceTime must be a valid date");
  return result;
}

/** Normalize an optional scope without ever producing a non-positive window. */
export function normalizeProgressScope(scope?: ProgressScope | null): ProgressScope {
  if (!scope) return { ...DEFAULT_SCOPE };
  if (scope.type === "lifetime") return { type: "lifetime" };
  if (scope.type === "rolling") {
    return Number.isInteger(scope.days) && scope.days > 0
      ? { type: "rolling", days: scope.days }
      : { ...DEFAULT_SCOPE };
  }
  if (scope.type === "round" && scope.roundId.trim()) return { type: "round", roundId: scope.roundId.trim() };
  return { ...DEFAULT_SCOPE };
}

export function progressScopeKey(scope: ProgressScope): string {
  const normalized = normalizeProgressScope(scope);
  switch (normalized.type) {
    case "lifetime": return "lifetime";
    case "rolling": return `rolling:${normalized.days}`;
    case "round": return `round:${normalized.roundId}`;
  }
}

export function progressScopeLabel(scope: ProgressScope): string {
  const normalized = normalizeProgressScope(scope);
  switch (normalized.type) {
    case "lifetime": return "全部时间";
    case "rolling": return `近 ${normalized.days} 天`;
    case "round": return `复习轮次 ${normalized.roundId}`;
  }
}

/**
 * Return the inclusive lower boundary for a scope in epoch milliseconds.
 * Lifetime and round scopes do not have a time cutoff and return null.
 */
export function progressScopeCutoff(scope: ProgressScope, referenceTime: ReferenceTime): number | null {
  const normalized = normalizeProgressScope(scope);
  if (normalized.type !== "rolling") return null;
  return epochMs(referenceTime) - normalized.days * DAY_MS;
}

function statsForQuestion(questionId: string, stats: readonly ProgressAttemptStats[]): ProgressAttemptStats | undefined {
  return stats.find((candidate) => candidate.questionId === questionId);
}

function progressForQuestion(roundId: string, questionId: string, progress: readonly ReviewRoundProgress[]) {
  const key = `${roundId}:${questionId}`;
  return progress.find((candidate) => candidate.key === key && candidate.roundId === roundId && candidate.questionId === questionId);
}

function hasRoundProgress(progress: ReviewRoundProgress | undefined): boolean {
  if (!progress) return false;
  return progress.attempts > 0 || progress.correct > 0 || progress.wrong > 0;
}

/**
 * Whether a question has at least one completed attempt in the requested
 * scope.  Rolling windows intentionally use only AttemptStats.latestAttemptAt
 * (not firstAttemptAt or individual attempt history) so the answer is stable
 * with the bounded stats projection.
 */
export function isQuestionDoneInScope(
  questionId: string,
  scope: ProgressScope,
  attemptStats: readonly ProgressAttemptStats[],
  roundProgress: readonly ReviewRoundProgress[],
  referenceTime: ReferenceTime,
): boolean {
  const normalized = normalizeProgressScope(scope);
  if (normalized.type === "round") return hasRoundProgress(progressForQuestion(normalized.roundId, questionId, roundProgress));

  const stats = statsForQuestion(questionId, attemptStats);
  if (!stats || stats.total <= 0) return false;
  if (normalized.type === "lifetime") return true;

  const referenceMs = epochMs(referenceTime);
  const cutoff = referenceMs - normalized.days * DAY_MS;
  const latest = new Date(stats.latestAttemptAt).getTime();
  return Number.isFinite(latest) && latest >= cutoff && latest <= referenceMs;
}

/** Calculate deduplicated question completion for a scope as a percentage. */
export function calculateProgressCompletion(
  questionIds: readonly string[],
  scope: ProgressScope,
  attemptStats: readonly ProgressAttemptStats[],
  roundProgress: readonly ReviewRoundProgress[],
  referenceTime: ReferenceTime,
): ProgressCompletion {
  const uniqueQuestionIds = [...new Set(questionIds)];
  const completed = uniqueQuestionIds.reduce(
    (count, questionId) => count + (isQuestionDoneInScope(questionId, scope, attemptStats, roundProgress, referenceTime) ? 1 : 0),
    0,
  );
  return {
    total: uniqueQuestionIds.length,
    completed,
    percent: uniqueQuestionIds.length ? Math.round(completed / uniqueQuestionIds.length * 100) : 0,
  };
}
