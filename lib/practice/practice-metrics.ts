import type { Attempt, AttemptDailyStats, AttemptStats } from "@/lib/db/types";

export interface AttemptSummary {
  total: number;
  correct: number;
  wrong: number;
  latest: number | null;
  difficulty: number;
}

export function calculateDifficulty(total: number, wrong: number) {
  return Math.round((wrong + 1) / (total + 2) * 100);
}

export function summarizeAttempts(attempts: Attempt[]): AttemptSummary {
  let correct = 0;
  let wrong = 0;
  let latest: number | null = null;
  attempts.forEach((attempt) => {
    if (attempt.correct) correct += 1;
    else wrong += 1;
    const createdAt = new Date(attempt.createdAt).getTime();
    if (Number.isFinite(createdAt) && (latest === null || createdAt > latest)) latest = createdAt;
  });
  const total = correct + wrong;
  return { total, correct, wrong, latest, difficulty: calculateDifficulty(total, wrong) };
}

export function createAttemptStats(attempt: Attempt): AttemptStats {
  return {
    questionId: attempt.questionId,
    bankId: attempt.bankId,
    total: 1,
    correct: attempt.correct ? 1 : 0,
    wrong: attempt.correct ? 0 : 1,
    giveUps: attempt.selected ? 0 : 1,
    totalElapsedMs: Math.max(0, attempt.elapsedMs || 0),
    firstAttemptAt: attempt.createdAt,
    firstAttemptCorrect: attempt.correct,
    latestAttemptAt: attempt.createdAt,
    hasBeenWrong: !attempt.correct,
    correctStreakAfterWrong: 0,
    currentCorrectStreak: attempt.correct ? 1 : 0,
    recentOutcomes: [{ id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct }],
  };
}

export function addAttemptToStats(current: AttemptStats | undefined, attempt: Attempt): AttemptStats {
  if (!current) return createAttemptStats(attempt);
  const recentOutcomes = [...(current.recentOutcomes ?? []), { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct }]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-32);
  let currentCorrectStreak = 0;
  for (let index = recentOutcomes.length - 1; index >= 0 && recentOutcomes[index].correct; index -= 1) currentCorrectStreak += 1;
  const isLater = attempt.createdAt >= current.latestAttemptAt;
  const isEarlier = attempt.createdAt < current.firstAttemptAt;
  return {
    ...current,
    bankId: attempt.bankId,
    total: current.total + 1,
    correct: current.correct + (attempt.correct ? 1 : 0),
    wrong: current.wrong + (attempt.correct ? 0 : 1),
    giveUps: current.giveUps + (attempt.selected ? 0 : 1),
    totalElapsedMs: current.totalElapsedMs + Math.max(0, attempt.elapsedMs || 0),
    firstAttemptAt: isEarlier ? attempt.createdAt : current.firstAttemptAt,
    firstAttemptCorrect: isEarlier ? attempt.correct : current.firstAttemptCorrect,
    latestAttemptAt: isLater ? attempt.createdAt : current.latestAttemptAt,
    hasBeenWrong: current.hasBeenWrong || !attempt.correct,
    correctStreakAfterWrong: (current.hasBeenWrong || !attempt.correct) ? currentCorrectStreak : 0,
    currentCorrectStreak,
    recentOutcomes,
  };
}

export function buildAttemptStats(attempts: Attempt[]) {
  let result: AttemptStats | undefined;
  for (const attempt of [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    result = addAttemptToStats(result, attempt);
  }
  return result;
}

export function summarizeAttemptStats(stats?: AttemptStats): AttemptSummary {
  if (!stats) return { total: 0, correct: 0, wrong: 0, latest: null, difficulty: calculateDifficulty(0, 0) };
  const latest = new Date(stats.latestAttemptAt).getTime();
  return {
    total: stats.total,
    correct: stats.correct,
    wrong: stats.wrong,
    latest: Number.isFinite(latest) ? latest : null,
    difficulty: calculateDifficulty(stats.total, stats.wrong),
  };
}

export function statsNeedWrongReview(stats: AttemptStats | undefined, requiredCorrectStreak: number) {
  return Boolean(stats?.hasBeenWrong && stats.correctStreakAfterWrong < Math.max(1, requiredCorrectStreak));
}

export function calendarDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function attemptDate(attempt: Attempt) {
  return calendarDate(attempt.createdAt);
}

export function attemptDailyKey(attempt: Pick<Attempt, "createdAt" | "questionId">) {
  return `${calendarDate(attempt.createdAt)}:${attempt.questionId}`;
}

export function addAttemptToDailyStats(current: AttemptDailyStats | undefined, attempt: Attempt): AttemptDailyStats {
  return {
    key: attemptDailyKey(attempt),
    date: attemptDate(attempt),
    questionId: attempt.questionId,
    bankId: attempt.bankId,
    total: (current?.total ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    giveUps: (current?.giveUps ?? 0) + (attempt.selected ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs || 0),
  };
}

export function needsWrongReview(attempts: Attempt[], requiredCorrectStreak: number) {
  const ordered = [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let hasBeenWrong = false;
  let correctStreak = 0;
  ordered.forEach((attempt) => {
    if (attempt.correct) {
      if (hasBeenWrong) correctStreak += 1;
    } else {
      hasBeenWrong = true;
      correctStreak = 0;
    }
  });
  return hasBeenWrong && correctStreak < Math.max(1, requiredCorrectStreak);
}

export function difficultyLabel(score: number) {
  if (score >= 70) return "困难";
  if (score >= 45) return "中等";
  return "容易";
}

export function difficultyTone(score: number): "easy" | "medium" | "hard" {
  if (score >= 70) return "hard";
  if (score >= 45) return "medium";
  return "easy";
}
