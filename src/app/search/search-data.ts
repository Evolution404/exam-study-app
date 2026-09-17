import {
  readAttemptsForQuestionIdsV7,
  readAttemptStatsForQuestionIdsV7,
  readNotesForQuestionIdsV7,
  readReviewRoundProgressForQuestionIdsV7,
} from "@/lib/db/search-read-v7";

export async function readSearchHistoryDataV7(questions: readonly { id: string; bankId?: string }[]) {
  const questionIds = [...new Set(questions.map((question) => question.id))];
  const sourceBankByQuestion = new Map(questions.map((question) => [question.id, question.bankId ?? ""]));
  const [rawStats, attempts, notes, roundProgress] = await Promise.all([
    readAttemptStatsForQuestionIdsV7(questionIds),
    readAttemptsForQuestionIdsV7(questionIds),
    readNotesForQuestionIdsV7(questionIds),
    readReviewRoundProgressForQuestionIdsV7(questionIds),
  ]);
  return {
    attemptStats: rawStats.map((stats) => ({ ...stats, bankId: sourceBankByQuestion.get(stats.questionId) ?? "" })),
    attempts,
    notes,
    roundProgress,
  };
}
