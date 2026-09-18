import { dailyStatsKey, datePart, studyDb } from "./db-core";
import {
  addAttemptToStats,
  addDailyStats,
  addReviewRoundProgress,
  updateReviewRoundProgressForAttemptInTx,
} from "./db-attempt-projections";
import { updatePracticeRunStatsInTx } from "./db-practice-stats";
import { assemblePracticeRunRecords } from "./practice-run-store";
import type {
  Attempt,
  AttemptDailyStats,
  AttemptStats,
  BankPracticeStats,
  PracticeRun,
  PracticeRunRecord,
  PracticeRunSource,
  ReviewRoundProgress,
} from "./types";

const PROJECTION_REBUILD_PENDING_KEY = "projection:rebuild-pending";

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

/** Apply the device-local projection derived from a PracticeRun transition. */
export async function applyPracticeRunProjectionInTx(
  previous: PracticeRun | undefined,
  next: PracticeRun | undefined,
): Promise<void> {
  await updatePracticeRunStatsInTx(previous, next);
}

function compareAttempts(left: Attempt, right: Attempt): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function canonicalRunBankIds(run: PracticeRun): string[] {
  return [...new Set((run.bankIds?.length ? run.bankIds : [run.bankId]).filter(Boolean))];
}

interface ProjectionRows {
  questionProgress: AttemptStats[];
  questionDailyProgress: AttemptDailyStats[];
  bankPracticeStats: BankPracticeStats[];
  reviewRoundProgress: ReviewRoundProgress[];
}

/**
 * Pure projection reducer. Large checkpoint/reconcile rebuilds aggregate all
 * canonical facts in memory first, then perform one bulk write per projection
 * table instead of one IndexedDB round trip per attempt/run.
 */
function projectCanonicalFacts(
  attempts: readonly Attempt[],
  runs: readonly PracticeRun[],
): ProjectionRows {
  const questionProgress = new Map<string, AttemptStats>();
  const questionDailyProgress = new Map<string, AttemptDailyStats>();
  const reviewRoundProgress = new Map<string, ReviewRoundProgress>();

  for (const attempt of [...attempts].sort(compareAttempts)) {
    questionProgress.set(
      attempt.questionId,
      addAttemptToStats(questionProgress.get(attempt.questionId), attempt),
    );
    const dailyKey = dailyStatsKey(attempt.createdAt, attempt.questionId);
    questionDailyProgress.set(
      dailyKey,
      addDailyStats(questionDailyProgress.get(dailyKey), attempt),
    );
    if (attempt.reviewRoundId) {
      const roundKey = `${attempt.reviewRoundId}:${attempt.questionId}`;
      reviewRoundProgress.set(
        roundKey,
        addReviewRoundProgress(
          reviewRoundProgress.get(roundKey),
          attempt.reviewRoundId,
          attempt.questionId,
          attempt,
        ),
      );
    }
  }

  const bankPracticeStats = new Map<string, BankPracticeStats>();
  for (const run of runs) {
    for (const bankId of canonicalRunBankIds(run)) {
      const current = bankPracticeStats.get(bankId) ?? {
        bankId,
        total: 0,
        completed: 0,
        inProgress: 0,
        abandoned: 0,
        latestActivityAt: "",
      };
      current.total += 1;
      if (run.status === "completed") current.completed += 1;
      else if (run.status === "abandoned") current.abandoned += 1;
      else current.inProgress += 1;
      if (run.updatedAt > current.latestActivityAt) current.latestActivityAt = run.updatedAt;
      bankPracticeStats.set(bankId, current);
    }
  }

  return {
    questionProgress: [...questionProgress.values()],
    questionDailyProgress: [...questionDailyProgress.values()],
    bankPracticeStats: [...bankPracticeStats.values()],
    reviewRoundProgress: [...reviewRoundProgress.values()],
  };
}

export async function markProjectionRebuildPendingInTx(): Promise<void> {
  await studyDb.syncMeta.put({
    key: PROJECTION_REBUILD_PENDING_KEY,
    value: true,
    updatedAt: new Date().toISOString(),
  });
}

async function clearProjectionRebuildPendingInTx(): Promise<void> {
  await studyDb.syncMeta.delete(PROJECTION_REBUILD_PENDING_KEY);
}

export async function ensureLocalProjectionsReady(): Promise<void> {
  if (!await studyDb.syncMeta.get(PROJECTION_REBUILD_PENDING_KEY)) return;
  await rebuildAllProjections();
}

async function replaceProjectionRowsInTx(rows: ProjectionRows): Promise<void> {
  await Promise.all([
    studyDb.questionProgress.clear(),
    studyDb.questionDailyProgress.clear(),
    studyDb.bankPracticeStats.clear(),
    studyDb.reviewRoundProgress.clear(),
  ]);
  await Promise.all([
    rows.questionProgress.length ? studyDb.questionProgress.bulkPut(rows.questionProgress) : Promise.resolve(),
    rows.questionDailyProgress.length ? studyDb.questionDailyProgress.bulkPut(rows.questionDailyProgress) : Promise.resolve(),
    rows.bankPracticeStats.length ? studyDb.bankPracticeStats.bulkPut(rows.bankPracticeStats) : Promise.resolve(),
    rows.reviewRoundProgress.length ? studyDb.reviewRoundProgress.bulkPut(rows.reviewRoundProgress) : Promise.resolve(),
  ]);
}

/**
 * Rebuild local projections directly from an already materialized canonical
 * snapshot. Restore/reconcile callers use this path so they do not write the
 * canonical snapshot and then immediately materialize the same large tables
 * from IndexedDB again.
 */
async function replaceProjectionRows(rows: ProjectionRows): Promise<void> {
  await studyDb.transaction(
    "rw",
    [
      studyDb.questionProgress,
      studyDb.questionDailyProgress,
      studyDb.bankPracticeStats,
      studyDb.reviewRoundProgress,
      studyDb.syncMeta,
    ],
    async () => {
      await replaceProjectionRowsInTx(rows);
      await clearProjectionRebuildPendingInTx();
    },
  );
}

export async function rebuildProjectionsFromFacts(
  attempts: readonly Attempt[],
  runs: readonly PracticeRun[],
): Promise<void> {
  await replaceProjectionRows(projectCanonicalFacts(attempts, runs));
}

/**
 * Restore path for already-normalized canonical run facts. This avoids
 * assembling PracticeRun aggregates only to derive bank-level run statistics.
 */
export async function rebuildProjectionsFromNormalizedFacts(
  attempts: readonly Attempt[],
  runRecords: readonly PracticeRunRecord[],
  runSources: readonly PracticeRunSource[],
): Promise<void> {
  const attemptRows = projectCanonicalFacts(attempts, []);
  const bankPracticeStats = new Map<string, BankPracticeStats>();
  const bankIdsByRun = new Map<string, Set<string>>();
  for (const source of runSources) {
    let ids = bankIdsByRun.get(source.runId);
    if (!ids) {
      ids = new Set<string>();
      bankIdsByRun.set(source.runId, ids);
    }
    ids.add(source.bankId);
  }
  for (const run of runRecords) {
    for (const bankId of bankIdsByRun.get(run.id) ?? []) {
      const current = bankPracticeStats.get(bankId) ?? {
        bankId,
        total: 0,
        completed: 0,
        inProgress: 0,
        abandoned: 0,
        latestActivityAt: "",
      };
      current.total += 1;
      if (run.status === "completed") current.completed += 1;
      else if (run.status === "abandoned") current.abandoned += 1;
      else current.inProgress += 1;
      if (run.updatedAt > current.latestActivityAt) current.latestActivityAt = run.updatedAt;
      bankPracticeStats.set(bankId, current);
    }
  }
  await replaceProjectionRows({
    ...attemptRows,
    bankPracticeStats: [...bankPracticeStats.values()],
  });
}

/**
 * Rebuild every device-local projection from canonical facts only.
 *
 * This never touches changeSets and therefore cannot generate a sync event.
 * syncMeta only carries the local crash-recovery marker, which is cleared in
 * the same transaction as the rebuilt projection rows.
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
      studyDb.syncMeta,
    ],
    async () => {
      const [attempts, records, sources, items] = await Promise.all([
        studyDb.attempts.toArray(),
        studyDb.practiceRuns.toArray(),
        studyDb.practiceRunSources.toArray(),
        studyDb.practiceRunItems.toArray(),
      ]);
      const runs = assemblePracticeRunRecords(records, sources, items, attempts);
      await replaceProjectionRowsInTx(projectCanonicalFacts(attempts, runs));
      await clearProjectionRebuildPendingInTx();
    },
  );
}
