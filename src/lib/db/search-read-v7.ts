import { dbV7 } from "./db-v7";
import type { AttemptStatsV7, AttemptV7, NoteV7, ReviewRoundProgress } from "./v7-types";

function uniqueQuestionIds(questionIds: readonly string[]): string[] {
  return [...new Set(questionIds)];
}

/** Read only notes belonging to the current search question set. */
export async function readNotesForQuestionIdsV7(questionIds: readonly string[]): Promise<NoteV7[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  const rows = await dbV7.notes.bulkGet(ids);
  return rows.filter((row): row is NoteV7 => row !== undefined);
}

/** Read lifetime aggregate stats by their questionId primary keys. */
export async function readAttemptStatsForQuestionIdsV7(questionIds: readonly string[]): Promise<AttemptStatsV7[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  const rows = await dbV7.attemptStats.bulkGet(ids);
  return rows.filter((row): row is AttemptStatsV7 => row !== undefined);
}

/** Read only attempt history rows whose indexed questionId is in scope. */
export async function readAttemptsForQuestionIdsV7(questionIds: readonly string[]): Promise<AttemptV7[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  return dbV7.attempts.where("questionId").anyOf(ids).toArray();
}

/** Read only review-round progress rows whose indexed questionId is in scope. */
export async function readReviewRoundProgressForQuestionIdsV7(questionIds: readonly string[]): Promise<ReviewRoundProgress[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  return dbV7.reviewRoundProgress.where("questionId").anyOf(ids).toArray();
}
