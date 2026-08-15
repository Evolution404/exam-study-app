/**
 * Where a saved practice run should resume.
 *
 * Pure helper: the resume position is derived from the submitted answers
 * themselves, never from the run's `lastAnsweredIndex` hint (a derived field
 * that sync restores can leave stale, since event replay order is not
 * chronological).
 */
import type { PracticeAnswerState } from "../../types/types";

export function resumeIndexAfterLastAnswer(
  questionIds: string[],
  answers: Record<string, PracticeAnswerState>,
): number {
  if (!questionIds.length) return 0;
  const lastAnsweredIndex = questionIds.reduce((last, questionId, index) => answers[questionId]?.submitted ? index : last, -1);
  // The last question answered means there is no "one past the last" slot:
  // continue at the first still-unanswered question instead of showing the
  // answered final question again.
  if (lastAnsweredIndex === questionIds.length - 1) {
    const firstUnanswered = questionIds.findIndex((questionId) => !answers[questionId]?.submitted);
    return firstUnanswered >= 0 ? firstUnanswered : questionIds.length - 1;
  }
  return Math.min(lastAnsweredIndex + 1, questionIds.length - 1);
}
