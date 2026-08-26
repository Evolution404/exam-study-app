import type { AttemptStats } from "../../types/types";
import type { AttemptV7, ReviewRoundProgress } from "../db/v7-types";

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

export interface ScopedQuestionStats {
  questionId: string;
  total: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
  firstAttemptAt: string;
  firstAttemptCorrect: boolean;
  latestAttemptAt: string;
  hasBeenWrong: boolean;
  currentCorrectStreak: number;
  correctStreakAfterWrong: number;
  /** 窗口内最近作答序列（含作答时间），供时间/间隔感知的个人难度使用。 */
  recentOutcomes: Array<{ id: string; correct: boolean; createdAt: string; elapsedMs: number }>;
}

export interface ScopedAttemptSummary {
  attempts: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
  attemptedQuestions: number;
  firstCorrect: number;
  firstKnown: number;
  lastAttemptAt?: string;
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
  return progress !== undefined;
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
  const normalized = normalizeProgressScope(scope);
  let completed = 0;
  if (normalized.type === "round") {
    // Index round progress by its canonical key for O(1) lookups instead of a
    // linear scan per question (the scan made this quadratic for large banks).
    const progressByKey = new Map(roundProgress.filter((row) => row.roundId === normalized.roundId).map((row) => [row.key, row]));
    for (const questionId of uniqueQuestionIds) {
      const row = progressByKey.get(`${normalized.roundId}:${questionId}`);
      if (row && hasRoundProgress(row)) completed += 1;
    }
    return { total: uniqueQuestionIds.length, completed, percent: uniqueQuestionIds.length ? Math.round(completed / uniqueQuestionIds.length * 100) : 0 };
  }

  const statsByQuestion = new Map(attemptStats.map((row) => [row.questionId, row]));
  const referenceMs = epochMs(referenceTime);
  const cutoff = normalized.type === "rolling" ? referenceMs - normalized.days * DAY_MS : null;
  for (const questionId of uniqueQuestionIds) {
    const stats = statsByQuestion.get(questionId);
    if (!stats || stats.total <= 0) continue;
    if (normalized.type === "lifetime") { completed += 1; continue; }
    const latest = new Date(stats.latestAttemptAt).getTime();
    if (Number.isFinite(latest) && latest >= cutoff! && latest <= referenceMs) completed += 1;
  }
  return {
    total: uniqueQuestionIds.length,
    completed,
    percent: uniqueQuestionIds.length ? Math.round(completed / uniqueQuestionIds.length * 100) : 0,
  };
}

/**
 * Build per-question statistics for the exact user-selected scope.
 * Rolling/lifetime scopes use immutable attempts so accuracy and streaks are
 * exact. Named rounds use their complete durable aggregate projection.
 */
export function buildScopedQuestionStats(
  questionIds: readonly string[],
  scope: ProgressScope,
  attempts: readonly AttemptV7[],
  roundProgress: readonly ReviewRoundProgress[],
  referenceTime: ReferenceTime,
): Map<string, ScopedQuestionStats> {
  const ids = new Set(questionIds);
  const normalized = normalizeProgressScope(scope);
  if (normalized.type === "round") {
    return new Map(roundProgress
      .filter((row) => row.roundId === normalized.roundId && ids.has(row.questionId) && row.attempts > 0)
      .map((row) => [row.questionId, {
        questionId: row.questionId,
        total: row.attempts,
        correct: row.correct,
        wrong: row.wrong,
        giveUps: row.giveUps,
        totalElapsedMs: row.totalElapsedMs,
        firstAttemptAt: row.firstAttemptAt,
        firstAttemptCorrect: row.firstAttemptCorrect,
        latestAttemptAt: row.latestAttemptAt,
        hasBeenWrong: row.hasBeenWrong,
        currentCorrectStreak: row.currentCorrectStreak,
        correctStreakAfterWrong: row.correctStreakAfterWrong,
        recentOutcomes: row.recentOutcomes,
      }]));
  }

  const referenceMs = epochMs(referenceTime);
  const cutoff = normalized.type === "rolling" ? referenceMs - normalized.days * DAY_MS : null;
  const grouped = new Map<string, AttemptV7[]>();
  for (const attempt of attempts) {
    if (!ids.has(attempt.questionId)) continue;
    const createdAt = new Date(attempt.createdAt).getTime();
    if (!Number.isFinite(createdAt) || createdAt > referenceMs || (cutoff !== null && createdAt < cutoff)) continue;
    const rows = grouped.get(attempt.questionId);
    if (rows) rows.push(attempt);
    else grouped.set(attempt.questionId, [attempt]);
  }

  const result = new Map<string, ScopedQuestionStats>();
  for (const [questionId, rows] of grouped) {
    const ordered = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    let correct = 0;
    let wrong = 0;
    let giveUps = 0;
    let totalElapsedMs = 0;
    let hasBeenWrong = false;
    let currentCorrectStreak = 0;
    for (const row of ordered) {
      if (row.correct) {
        correct += 1;
        currentCorrectStreak += 1;
      } else {
        wrong += 1;
        hasBeenWrong = true;
        currentCorrectStreak = 0;
      }
      if (!row.selected) giveUps += 1;
      totalElapsedMs += Math.max(0, row.elapsedMs || 0);
    }
    result.set(questionId, {
      questionId,
      total: ordered.length,
      correct,
      wrong,
      giveUps,
      totalElapsedMs,
      firstAttemptAt: ordered[0].createdAt,
      firstAttemptCorrect: ordered[0].correct,
      latestAttemptAt: ordered.at(-1)!.createdAt,
      hasBeenWrong,
      currentCorrectStreak,
      correctStreakAfterWrong: hasBeenWrong ? currentCorrectStreak : 0,
      recentOutcomes: ordered.slice(-32).map((row) => ({ id: row.id, correct: row.correct, createdAt: row.createdAt, elapsedMs: Math.max(0, row.elapsedMs || 0) })),
    });
  }
  return result;
}

export function summarizeScopedQuestionStats(stats: ReadonlyMap<string, ScopedQuestionStats>): ScopedAttemptSummary {
  let attempts = 0;
  let correct = 0;
  let wrong = 0;
  let giveUps = 0;
  let totalElapsedMs = 0;
  let firstCorrect = 0;
  let firstKnown = 0;
  let lastAttemptAt: string | undefined;
  for (const row of stats.values()) {
    attempts += row.total;
    correct += row.correct;
    wrong += row.wrong;
    giveUps += row.giveUps;
    totalElapsedMs += row.totalElapsedMs;
    firstKnown += 1;
    if (row.firstAttemptCorrect) firstCorrect += 1;
    if (!lastAttemptAt || row.latestAttemptAt > lastAttemptAt) lastAttemptAt = row.latestAttemptAt;
  }
  return { attempts, correct, wrong, giveUps, totalElapsedMs, attemptedQuestions: stats.size, firstCorrect, firstKnown, lastAttemptAt };
}

/**
 * Convert scoped per-question statistics into the canonical `AttemptStats`
 * shape so existing helpers (`summarizeAttemptStats`, `calculateDifficulty`)
 * work on date-range-filtered data.  The rolling/lifetime path now carries a
 * `recentOutcomes` window for the time-aware personal difficulty. Round
 * projections carry the same evidence.
 */
export function scopedStatsToAttemptStats(stats: ScopedQuestionStats, bankId = ""): AttemptStats {
  return {
    questionId: stats.questionId,
    bankId,
    total: stats.total,
    correct: stats.correct,
    wrong: stats.wrong,
    giveUps: stats.giveUps,
    totalElapsedMs: stats.totalElapsedMs,
    firstAttemptAt: stats.firstAttemptAt,
    firstAttemptCorrect: stats.firstAttemptCorrect,
    latestAttemptAt: stats.latestAttemptAt,
    hasBeenWrong: stats.hasBeenWrong,
    correctStreakAfterWrong: stats.correctStreakAfterWrong,
    currentCorrectStreak: stats.currentCorrectStreak,
    recentOutcomes: stats.recentOutcomes.map((outcome) => ({ ...outcome })),
  };
}
