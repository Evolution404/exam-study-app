import { getQuestionsForBanksV7 } from "./db-v7-bank";
import { dbV7 } from "./db-v7-core";
import type { AttemptStatsV7, AttemptV7, QuestionV7, ReviewRoundProgress } from "./v7-types";

export interface PracticeSetupHistoryV7 {
  stats: AttemptStatsV7[];
  roundsProgress: ReviewRoundProgress[];
  attempts: AttemptV7[];
}

export interface PracticeSetupDatasetV7 extends PracticeSetupHistoryV7 {
  questions: QuestionV7[];
}

function uniqueQuestionIds(questionIds: readonly string[]): string[] {
  return [...new Set(questionIds)];
}

/** Read only history rows belonging to the current Practice Setup question set. */
export async function readPracticeSetupHistoryForQuestionIdsV7(questionIds: readonly string[]): Promise<PracticeSetupHistoryV7> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return { stats: [], roundsProgress: [], attempts: [] };
  const [statsRows, roundsProgress, attempts] = await Promise.all([
    dbV7.attemptStats.bulkGet(ids),
    dbV7.reviewRoundProgress.where("questionId").anyOf(ids).toArray(),
    dbV7.attempts.where("questionId").anyOf(ids).toArray(),
  ]);
  return {
    stats: statsRows.filter((row): row is AttemptStatsV7 => row !== undefined),
    roundsProgress,
    attempts,
  };
}

/** Canonical Practice Setup read-model: resolve current questions first, then read only their history. */
export async function readPracticeSetupDatasetV7(bankIds: readonly string[]): Promise<PracticeSetupDatasetV7> {
  const questions = await getQuestionsForBanksV7(bankIds);
  const history = await readPracticeSetupHistoryForQuestionIdsV7(questions.map((question) => question.id));
  return { questions, ...history };
}
