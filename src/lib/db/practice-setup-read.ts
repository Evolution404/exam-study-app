import { getQuestionsForBanks } from "./db-bank";
import { studyDb } from "./db-core";
import type { AttemptStats, Attempt, Question, ReviewRoundProgress } from "./types";

export interface PracticeSetupHistory {
  stats: AttemptStats[];
  roundsProgress: ReviewRoundProgress[];
  attempts: Attempt[];
}

export interface PracticeSetupDataset extends PracticeSetupHistory {
  questions: Question[];
}

function uniqueQuestionIds(questionIds: readonly string[]): string[] {
  return [...new Set(questionIds)];
}

/** Read only history rows belonging to the current Practice Setup question set. */
export async function readPracticeSetupHistoryForQuestionIds(
  questionIds: readonly string[],
  options: { includeAttempts?: boolean } = {},
): Promise<PracticeSetupHistory> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return { stats: [], roundsProgress: [], attempts: [] };
  const includeAttempts = options.includeAttempts !== false;
  const [statsRows, roundsProgress, attempts] = await Promise.all([
    studyDb.questionProgress.bulkGet(ids),
    studyDb.reviewRoundProgress.where("questionId").anyOf(ids).toArray(),
    includeAttempts ? studyDb.attempts.where("questionId").anyOf(ids).toArray() : Promise.resolve([]),
  ]);
  return {
    stats: statsRows.filter((row): row is AttemptStats => row !== undefined),
    roundsProgress,
    attempts,
  };
}

/** Canonical Practice Setup read-model: resolve current questions first, then read only their history. */
export async function readPracticeSetupDataset(bankIds: readonly string[]): Promise<PracticeSetupDataset> {
  const questions = await getQuestionsForBanks(bankIds);
  const history = await readPracticeSetupHistoryForQuestionIds(questions.map((question) => question.id));
  return { questions, ...history };
}
