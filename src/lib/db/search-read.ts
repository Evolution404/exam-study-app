import { studyDb } from "./db";
import type { AttemptStats, Attempt, Note, ReviewRoundProgress } from "./types";

function uniqueQuestionIds(questionIds: readonly string[]): string[] {
  return [...new Set(questionIds)];
}

/** Read only notes belonging to the current search question set. */
export async function readNotesForQuestionIds(questionIds: readonly string[]): Promise<Note[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  const rows = await studyDb.notes.bulkGet(ids);
  return rows.filter((row): row is Note => row !== undefined);
}

/** Read lifetime aggregate stats by their questionId primary keys. */
export async function readAttemptStatsForQuestionIds(questionIds: readonly string[]): Promise<AttemptStats[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  const rows = await studyDb.questionProgress.bulkGet(ids);
  return rows.filter((row): row is AttemptStats => row !== undefined);
}

/** Read only attempt history rows whose indexed questionId is in scope. */
export async function readAttemptsForQuestionIds(questionIds: readonly string[]): Promise<Attempt[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  return studyDb.attempts.where("questionId").anyOf(ids).toArray();
}

/** Read only review-round progress rows whose indexed questionId is in scope. */
export async function readReviewRoundProgressForQuestionIds(questionIds: readonly string[]): Promise<ReviewRoundProgress[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  return studyDb.reviewRoundProgress.where("questionId").anyOf(ids).toArray();
}
