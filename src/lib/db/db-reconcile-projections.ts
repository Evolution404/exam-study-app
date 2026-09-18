import { studyDb } from "./db-core";
import type { CanonicalState } from "./types";
import type { ProjectionImpact } from "../sync/projection-dependency-planner";

interface ProjectionDirtyKeys {
  memberships?: readonly string[];
  practiceRuns?: readonly string[];
  attempts?: readonly string[];
}

export async function localProjectionsNeedRebuild(): Promise<boolean> {
  const [
    membershipCount,
    attemptCount,
    practiceRunCount,
    practiceRunSourceCount,
    bankQuestionStatsCount,
    questionProgressCount,
    questionDailyProgressCount,
    bankPracticeStatsCount,
    bankPracticeRunIndexCount,
    reviewRoundAttemptCount,
    reviewRoundProgressCount,
  ] = await Promise.all([
    studyDb.bankQuestionMemberships.count(),
    studyDb.attempts.count(),
    studyDb.practiceRuns.count(),
    studyDb.practiceRunSources.count(),
    studyDb.bankQuestionStats.count(),
    studyDb.questionProgress.count(),
    studyDb.questionDailyProgress.count(),
    studyDb.bankPracticeStats.count(),
    studyDb.bankPracticeRunIndex.count(),
    studyDb.attempts.where("reviewRoundId").above("").count(),
    studyDb.reviewRoundProgress.count(),
  ]);
  return (membershipCount > 0 && bankQuestionStatsCount === 0)
    || (attemptCount > 0 && (questionProgressCount === 0 || questionDailyProgressCount === 0))
    || (practiceRunCount > 0 && bankPracticeStatsCount === 0)
    || (practiceRunSourceCount > 0 && bankPracticeRunIndexCount === 0)
    || (reviewRoundAttemptCount > 0 && reviewRoundProgressCount === 0);
}

/**
 * Delete/status mutations can identify only the canonical row being changed.
 * Enrich their derived impact before reconcile mutates the old local facts.
 */
export async function enrichProjectionImpactForDirtyInstall(
  input: ProjectionImpact | undefined,
  state: CanonicalState,
  dirty: ProjectionDirtyKeys | undefined,
): Promise<ProjectionImpact | undefined> {
  if (!input) return undefined;
  const impact: ProjectionImpact = {
    questionIds: new Set(input.questionIds),
    questionDailyKeys: new Set(input.questionDailyKeys),
    reviewRoundQuestionKeys: new Set(input.reviewRoundQuestionKeys),
    bankIds: new Set(input.bankIds),
    bankRunKeys: new Set(input.bankRunKeys),
    runIds: new Set(input.runIds),
  };

  for (const key of dirty?.memberships ?? []) {
    const separator = key.indexOf(":");
    if (separator > 0) impact.bankIds.add(key.slice(0, separator));
  }

  const dirtyRunIds = new Set([...(dirty?.practiceRuns ?? []), ...impact.runIds]);
  if (dirtyRunIds.size) {
    const ids = [...dirtyRunIds];
    const currentSources = await studyDb.practiceRunSources.where("runId").anyOf(ids).toArray();
    currentSources.forEach((row) => impact.bankIds.add(row.bankId));
    state.practiceRunSources
      .filter((row) => dirtyRunIds.has(row.runId))
      .forEach((row) => impact.bankIds.add(row.bankId));
  }

  const dirtyAttemptIds = [...(dirty?.attempts ?? [])];
  if (dirtyAttemptIds.length) {
    const currentAttempts = await studyDb.attempts.bulkGet(dirtyAttemptIds);
    currentAttempts
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .forEach((row) => impact.questionIds.add(row.questionId));
    const wanted = new Set(dirtyAttemptIds);
    state.attempts
      .filter((row) => wanted.has(row.id))
      .forEach((row) => impact.questionIds.add(row.questionId));
  }
  return impact;
}
