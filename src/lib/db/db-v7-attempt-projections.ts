import { dailyStatsKey, datePart, dbV7 } from "./db-v7-core";
import { attemptHasSelectionV7 } from "./practice-run-store-v7";
import type { AttemptDailyStatsV7, AttemptStatsV7, AttemptV7, ReviewRoundProgress } from "./v7-types";

export function addAttemptToStatsV7(current: AttemptStatsV7 | undefined, attempt: AttemptV7): AttemptStatsV7 {
  if (!current) {
    return {
      questionId: attempt.questionId,
      total: 1,
      correct: attempt.correct ? 1 : 0,
      wrong: attempt.correct ? 0 : 1,
      giveUps: attemptHasSelectionV7(attempt) ? 0 : 1,
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
  let currentCorrectStreak = 0;
  for (let index = recentOutcomes.length - 1; index >= 0 && recentOutcomes[index].correct; index -= 1) currentCorrectStreak += 1;
  const first = attempt.createdAt < current.firstAttemptAt;
  return {
    ...current,
    total: current.total + 1,
    correct: current.correct + (attempt.correct ? 1 : 0),
    wrong: current.wrong + (attempt.correct ? 0 : 1),
    giveUps: current.giveUps + (attemptHasSelectionV7(attempt) ? 0 : 1),
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

export function addDailyStatsV7(current: AttemptDailyStatsV7 | undefined, attempt: AttemptV7): AttemptDailyStatsV7 {
  return {
    key: dailyStatsKey(attempt.createdAt, attempt.questionId),
    date: datePart(attempt.createdAt),
    questionId: attempt.questionId,
    total: (current?.total ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    giveUps: (current?.giveUps ?? 0) + (attemptHasSelectionV7(attempt) ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs),
  };
}

export async function updateReviewRoundProgressForAttemptInTx(roundId: string, questionId: string, attempt: AttemptV7): Promise<void> {
  const current = await dbV7.reviewRoundProgress.get([roundId, questionId]);
  const recentOutcomes = [...(current ? current.recentOutcomes : []), { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs) }]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-32);
  let currentCorrectStreak = 0;
  for (let index = recentOutcomes.length - 1; index >= 0 && recentOutcomes[index].correct; index -= 1) currentCorrectStreak += 1;
  const first = !current || attempt.createdAt < current.firstAttemptAt;
  const hasBeenWrong = Boolean(current?.hasBeenWrong) || !attempt.correct;
  const progress: ReviewRoundProgress = {
    key: `${roundId}:${questionId}`,
    roundId,
    questionId,
    attempts: (current?.attempts ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    firstAttemptAt: first ? attempt.createdAt : current!.firstAttemptAt,
    latestAttemptAt: current && current.latestAttemptAt > attempt.createdAt ? current.latestAttemptAt : attempt.createdAt,
    giveUps: (current?.giveUps ?? 0) + (attemptHasSelectionV7(attempt) ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs),
    firstAttemptCorrect: first ? attempt.correct : current!.firstAttemptCorrect,
    hasBeenWrong,
    currentCorrectStreak,
    correctStreakAfterWrong: hasBeenWrong ? currentCorrectStreak : 0,
    recentOutcomes,
  };
  await dbV7.reviewRoundProgress.put(progress);
}
