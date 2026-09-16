import type { QuestionViewV7 } from "@/lib/db/app-data-v7";
import {
  readAttemptsForQuestionIdsV7,
  readAttemptStatsForQuestionIdsV7,
  readNotesForQuestionIdsV7,
  readReviewRoundProgressForQuestionIdsV7,
} from "@/lib/db/search-read-v7";

export async function readSearchHistoryDataV7(views: readonly QuestionViewV7[]) {
  const questionIds = views.map((view) => view.question.id);
  const sourceBankByQuestion = new Map(views.map((view) => [view.question.id, view.memberships[0]?.bankId ?? ""]));
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
