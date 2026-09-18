import { dailyStatsKey, datePart, studyDb } from "./db-core";
import { attemptHasSelection } from "./practice-run-store";
import type { AttemptDailyStats, AttemptStats, Attempt, ReviewRoundProgress } from "./types";

function compareAttemptOrder(
  left: Pick<Attempt, "createdAt" | "id">,
  right: Pick<Attempt, "createdAt" | "id">,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function attemptExtendsLatest(
  current: Pick<AttemptStats | ReviewRoundProgress, "recentOutcomes" | "latestAttemptAt">,
  attempt: Attempt,
): boolean {
  const latest = current.recentOutcomes.at(-1);
  if (latest) return compareAttemptOrder(attempt, latest) >= 0;
  return attempt.createdAt >= current.latestAttemptAt;
}

function tailCorrectStreak(outcomes: readonly { correct: boolean }[]): number {
  let streak = 0;
  for (let index = outcomes.length - 1; index >= 0 && outcomes[index].correct; index -= 1) streak += 1;
  return streak;
}

export function rebuildAttemptStats(attempts: readonly Attempt[]): AttemptStats | undefined {
  let stats: AttemptStats | undefined;
  for (const attempt of [...attempts].sort(compareAttemptOrder)) stats = addAttemptToStats(stats, attempt);
  return stats;
}

export function rebuildReviewRoundProgress(
  roundId: string,
  questionId: string,
  attempts: readonly Attempt[],
): ReviewRoundProgress | undefined {
  let progress: ReviewRoundProgress | undefined;
  for (const attempt of [...attempts].sort(compareAttemptOrder)) {
    progress = addReviewRoundProgress(progress, roundId, questionId, attempt);
  }
  return progress;
}

export function addAttemptToStats(current: AttemptStats | undefined, attempt: Attempt): AttemptStats {
  if (!current) {
    return {
      questionId: attempt.questionId,
      total: 1,
      correct: attempt.correct ? 1 : 0,
      wrong: attempt.correct ? 0 : 1,
      giveUps: attemptHasSelection(attempt) ? 0 : 1,
      totalElapsedMs: Math.max(0, attempt.elapsedMs),
      firstAttemptAt: attempt.createdAt,
      firstAttemptCorrect: attempt.correct,
      latestAttemptAt: attempt.createdAt,
      hasBeenWrong: !attempt.correct,
      correctStreakAfterWrong: 0,
      currentCorrectStreak: attempt.correct ? 1 : 0,
      recentOutcomes: [{ id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs) }],
    };
  }
  const recentOutcomes = [...current.recentOutcomes, { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs) }]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-32);
  const currentCorrectStreak = attemptExtendsLatest(current, attempt)
    ? attempt.correct ? current.currentCorrectStreak + 1 : 0
    : tailCorrectStreak(recentOutcomes);
  const first = attempt.createdAt < current.firstAttemptAt;
  return {
    ...current,
    total: current.total + 1,
    correct: current.correct + (attempt.correct ? 1 : 0),
    wrong: current.wrong + (attempt.correct ? 0 : 1),
    giveUps: current.giveUps + (attemptHasSelection(attempt) ? 0 : 1),
    totalElapsedMs: current.totalElapsedMs + Math.max(0, attempt.elapsedMs),
    firstAttemptAt: first ? attempt.createdAt : current.firstAttemptAt,
    firstAttemptCorrect: first ? attempt.correct : current.firstAttemptCorrect,
    latestAttemptAt: attempt.createdAt > current.latestAttemptAt ? attempt.createdAt : current.latestAttemptAt,
    hasBeenWrong: current.hasBeenWrong || !attempt.correct,
    correctStreakAfterWrong: (current.hasBeenWrong || !attempt.correct) ? currentCorrectStreak : 0,
    currentCorrectStreak,
    recentOutcomes,
  };
}

export function addDailyStats(current: AttemptDailyStats | undefined, attempt: Attempt): AttemptDailyStats {
  return {
    key: dailyStatsKey(attempt.createdAt, attempt.questionId),
    date: datePart(attempt.createdAt),
    questionId: attempt.questionId,
    total: (current?.total ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    giveUps: (current?.giveUps ?? 0) + (attemptHasSelection(attempt) ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs),
  };
}

export function addReviewRoundProgress(
  current: ReviewRoundProgress | undefined,
  roundId: string,
  questionId: string,
  attempt: Attempt,
): ReviewRoundProgress {
  const recentOutcomes = [...(current ? current.recentOutcomes : []), { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs) }]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-32);
  const currentCorrectStreak = current && attemptExtendsLatest(current, attempt)
    ? attempt.correct ? current.currentCorrectStreak + 1 : 0
    : tailCorrectStreak(recentOutcomes);
  const first = !current || attempt.createdAt < current.firstAttemptAt;
  const hasBeenWrong = Boolean(current?.hasBeenWrong) || !attempt.correct;
  return {
    key: `${roundId}:${questionId}`,
    roundId,
    questionId,
    attempts: (current?.attempts ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    firstAttemptAt: first ? attempt.createdAt : current.firstAttemptAt,
    latestAttemptAt: current && current.latestAttemptAt > attempt.createdAt ? current.latestAttemptAt : attempt.createdAt,
    giveUps: (current?.giveUps ?? 0) + (attemptHasSelection(attempt) ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs),
    firstAttemptCorrect: first ? attempt.correct : current.firstAttemptCorrect,
    hasBeenWrong,
    currentCorrectStreak,
    correctStreakAfterWrong: hasBeenWrong ? currentCorrectStreak : 0,
    recentOutcomes,
  };
}

export async function updateReviewRoundProgressForAttemptInTx(roundId: string, questionId: string, attempt: Attempt): Promise<void> {
  const current = await studyDb.reviewRoundProgress.get([roundId, questionId]);
  if (current && !attemptExtendsLatest(current, attempt)) {
    const attempts = (await studyDb.attempts.where("questionId").equals(questionId).toArray())
      .filter((row) => row.reviewRoundId === roundId);
    const rebuilt = rebuildReviewRoundProgress(roundId, questionId, attempts);
    if (rebuilt) await studyDb.reviewRoundProgress.put(rebuilt);
    return;
  }
  await studyDb.reviewRoundProgress.put(addReviewRoundProgress(current, roundId, questionId, attempt));
}
