import {
  readAttemptsForQuestionIds,
  readAttemptStatsForQuestionIds,
  readNotesForQuestionIds,
  readReviewRoundProgressForQuestionIds,
} from "@/lib/db/search-read";

export async function readSearchHistoryData(questions: readonly { id: string; bankId?: string }[]) {
  const questionIds = [...new Set(questions.map((question) => question.id))];
  const sourceBankByQuestion = new Map(questions.map((question) => [question.id, question.bankId ?? ""]));
  const [rawStats, attempts, notes, roundProgress] = await Promise.all([
    readAttemptStatsForQuestionIds(questionIds),
    readAttemptsForQuestionIds(questionIds),
    readNotesForQuestionIds(questionIds),
    readReviewRoundProgressForQuestionIds(questionIds),
  ]);
  return {
    attemptStats: rawStats.map((stats) => ({ ...stats, bankId: sourceBankByQuestion.get(stats.questionId) ?? "" })),
    attempts,
    notes,
    roundProgress,
  };
}
