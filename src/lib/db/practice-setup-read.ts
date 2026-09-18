import { getQuestionsForBanks } from "./db-bank";
import { readAttemptsForQuestionIdsInWindow } from "./attempt-read";
import { studyDb } from "./db-core";
import type { AttemptStats, Attempt, Question, ReviewRoundProgress } from "./types";
import { normalizeProgressScope, progressScopeCutoff, type ProgressScope } from "../practice/progress-scope";

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

/**
 * Scope-aware Practice Setup history. The setup UI needs exact wrong-card data,
 * but lifetime/round scopes already have durable projections and rolling scope
 * only needs immutable attempts inside its selected time window.
 */
export async function readPracticeSetupScopedHistoryForQuestionIds(
  questionIds: readonly string[],
  scope: ProgressScope,
  referenceTime: number,
  options: { includeRollingAttempts?: boolean } = {},
): Promise<PracticeSetupHistory> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return { stats: [], roundsProgress: [], attempts: [] };
  const normalized = normalizeProgressScope(scope);
  const statsPromise = studyDb.questionProgress.bulkGet(ids).then((rows) =>
    rows.filter((row): row is AttemptStats => row !== undefined),
  );

  if (normalized.type === "round") {
    const [stats, roundRows] = await Promise.all([
      statsPromise,
      studyDb.reviewRoundProgress.bulkGet(ids.map((questionId) => [normalized.roundId, questionId] as [string, string])),
    ]);
    return {
      stats,
      roundsProgress: roundRows.filter((row): row is ReviewRoundProgress => row !== undefined),
      attempts: [],
    };
  }

  if (normalized.type === "lifetime" || options.includeRollingAttempts === false) {
    return { stats: await statsPromise, roundsProgress: [], attempts: [] };
  }

  const from = new Date(progressScopeCutoff(normalized, referenceTime)!).toISOString();
  const to = new Date(referenceTime).toISOString();
  const [stats, attempts] = await Promise.all([
    statsPromise,
    readAttemptsForQuestionIdsInWindow(ids, from, to),
  ]);
  return { stats, roundsProgress: [], attempts };
}

/** Canonical Practice Setup read-model: resolve current questions first, then read only scope-relevant history. */
export async function readPracticeSetupDataset(
  bankIds: readonly string[],
  scope: ProgressScope,
  referenceTime: number,
): Promise<PracticeSetupDataset> {
  const questions = await getQuestionsForBanks(bankIds);
  const history = await readPracticeSetupScopedHistoryForQuestionIds(
    questions.map((question) => question.id),
    scope,
    referenceTime,
  );
  return { questions, ...history };
}
