import { datePart, studyDb } from "./db-core";
import {
  addAttemptToStats,
  addDailyStats,
  updateReviewRoundProgressForAttemptInTx,
} from "./db-attempt-projections";
import { updatePracticeRunStatsInTx } from "./db-practice-stats";
import { assemblePracticeRunRecords } from "./practice-run-store";
import type { Attempt, PracticeRun } from "./types";

/**
 * Apply the device-local projections derived from one canonical Attempt.
 * Must run inside a transaction that includes the projection tables it writes.
 */
export async function applyAttemptProjectionInTx(attempt: Attempt): Promise<void> {
  await studyDb.questionProgress.put(
    addAttemptToStats(await studyDb.questionProgress.get(attempt.questionId), attempt),
  );
  await studyDb.questionDailyProgress.put(
    addDailyStats(
      await studyDb.questionDailyProgress.get([datePart(attempt.createdAt), attempt.questionId]),
      attempt,
    ),
  );
  if (attempt.reviewRoundId) {
    await updateReviewRoundProgressForAttemptInTx(attempt.reviewRoundId, attempt.questionId, attempt);
  }
}

/**
 * Apply the device-local projection derived from a PracticeRun transition.
 */
export async function applyPracticeRunProjectionInTx(
  previous: PracticeRun | undefined,
  next: PracticeRun | undefined,
): Promise<void> {
  await updatePracticeRunStatsInTx(previous, next);
}

function compareAttempts(left: Attempt, right: Attempt): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

async function rebuildProjectionRowsInTx(
  attempts: readonly Attempt[],
  runs: readonly PracticeRun[],
): Promise<void> {
  const orderedAttempts = [...attempts].sort(compareAttempts);
  await Promise.all([
    studyDb.questionProgress.clear(),
    studyDb.questionDailyProgress.clear(),
    studyDb.bankPracticeStats.clear(),
    studyDb.reviewRoundProgress.clear(),
  ]);

  for (const attempt of orderedAttempts) await applyAttemptProjectionInTx(attempt);
  for (const run of runs) await applyPracticeRunProjectionInTx(undefined, run);
}

/**
 * Rebuild local projections directly from an already materialized canonical
 * snapshot. Restore/reconcile callers use this path so they do not write the
 * canonical snapshot and then immediately materialize the same large tables
 * from IndexedDB again.
 */
export async function rebuildProjectionsFromFacts(
  attempts: readonly Attempt[],
  runs: readonly PracticeRun[],
): Promise<void> {
  await studyDb.transaction(
    "rw",
    [
      studyDb.questionProgress,
      studyDb.questionDailyProgress,
      studyDb.bankPracticeStats,
      studyDb.reviewRoundProgress,
    ],
    () => rebuildProjectionRowsInTx(attempts, runs),
  );
}

/**
 * Rebuild every device-local projection from canonical facts only.
 *
 * This intentionally does not touch changeSets/syncMeta and therefore cannot
 * generate a sync event. It is safe to run after projection loss or when no
 * in-memory canonical snapshot is already available.
 */
export async function rebuildAllProjections(): Promise<void> {
  await studyDb.transaction(
    "rw",
    [
      studyDb.attempts,
      studyDb.practiceRuns,
      studyDb.practiceRunSources,
      studyDb.practiceRunItems,
      studyDb.questionProgress,
      studyDb.questionDailyProgress,
      studyDb.bankPracticeStats,
      studyDb.reviewRoundProgress,
    ],
    async () => {
      const [attempts, records, sources, items] = await Promise.all([
        studyDb.attempts.toArray(),
        studyDb.practiceRuns.toArray(),
        studyDb.practiceRunSources.toArray(),
        studyDb.practiceRunItems.toArray(),
      ]);
      const runs = assemblePracticeRunRecords(records, sources, items, attempts);
      await rebuildProjectionRowsInTx(attempts, runs);
    },
  );
}
