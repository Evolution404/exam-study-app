import { dailyStatsKey, datePart, studyDb } from "./db-core";
import {
  addAttemptToStats,
  addDailyStats,
  addReviewRoundProgress,
  attemptExtendsLatest,
  rebuildAttemptStats,
  updateReviewRoundProgressForAttemptInTx,
} from "./db-attempt-projections";
import { updatePracticeRunStatsInTx } from "./db-practice-stats";
import { runActivityAt } from "../practice/practice-metrics";
import type { ProjectionImpact } from "../sync/projection-dependency-planner";
import type {
  Attempt,
  AttemptDailyStats,
  AttemptStats,
  BankPracticeStats,
  BankQuestionMembership,
  BankQuestionStats,
  CanonicalState,
  PracticeRun,
  PracticeRunRecord,
  PracticeRunSource,
  ReviewRoundProgress,
} from "./types";

const PROJECTION_REBUILD_PENDING_KEY = "projection:rebuild-pending";
const PROJECTION_MODEL_REVISION_KEY = "projection:model-revision";

/** Bump only when projection semantics/schema change. */
export const PROJECTION_MODEL_REVISION = 2 as const;

/**
 * Apply the device-local projections derived from one canonical Attempt.
 * Must run inside a transaction that includes the projection tables it writes.
 */
export async function applyAttemptProjectionInTx(attempt: Attempt): Promise<void> {
  const current = await studyDb.questionProgress.get(attempt.questionId);
  if (current && !attemptExtendsLatest(current, attempt)) {
    const rebuilt = rebuildAttemptStats(await studyDb.attempts.where("questionId").equals(attempt.questionId).toArray());
    if (rebuilt) await studyDb.questionProgress.put(rebuilt);
  } else {
    await studyDb.questionProgress.put(addAttemptToStats(current, attempt));
  }
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
  bankQuestionStats: BankQuestionStats[];
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
  memberships: readonly BankQuestionMembership[] = [],
): ProjectionRows {
  const bankQuestionStats = new Map<string, BankQuestionStats>();
  for (const membership of memberships) {
    const current = bankQuestionStats.get(membership.bankId) ?? { bankId: membership.bankId, questionCount: 0 };
    current.questionCount += 1;
    bankQuestionStats.set(membership.bankId, current);
  }

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
      const activityAt = runActivityAt(run);
      if (activityAt > current.latestActivityAt) current.latestActivityAt = activityAt;
      bankPracticeStats.set(bankId, current);
    }
  }

  return {
    bankQuestionStats: [...bankQuestionStats.values()],
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

async function markProjectionModelCurrentInTx(): Promise<void> {
  await studyDb.syncMeta.put({
    key: PROJECTION_MODEL_REVISION_KEY,
    value: PROJECTION_MODEL_REVISION,
    updatedAt: new Date().toISOString(),
  });
}

async function clearProjectionRebuildPendingInTx(): Promise<void> {
  await studyDb.syncMeta.delete(PROJECTION_REBUILD_PENDING_KEY);
}

export async function ensureLocalProjectionsReady(): Promise<void> {
  const [pending, revision] = await Promise.all([
    studyDb.syncMeta.get(PROJECTION_REBUILD_PENDING_KEY),
    studyDb.syncMeta.get(PROJECTION_MODEL_REVISION_KEY),
  ]);
  if (!pending && revision?.value === PROJECTION_MODEL_REVISION) return;
  await rebuildAllProjections();
}

async function replaceProjectionRowsInTx(rows: ProjectionRows): Promise<void> {
  await Promise.all([
    studyDb.bankQuestionStats.clear(),
    studyDb.questionProgress.clear(),
    studyDb.questionDailyProgress.clear(),
    studyDb.bankPracticeStats.clear(),
    studyDb.reviewRoundProgress.clear(),
  ]);
  await Promise.all([
    rows.bankQuestionStats.length ? studyDb.bankQuestionStats.bulkPut(rows.bankQuestionStats) : Promise.resolve(),
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
      studyDb.bankQuestionStats,
      studyDb.questionProgress,
      studyDb.questionDailyProgress,
      studyDb.bankPracticeStats,
      studyDb.reviewRoundProgress,
      studyDb.syncMeta,
    ],
    async () => {
      await replaceProjectionRowsInTx(rows);
      await clearProjectionRebuildPendingInTx();
      await markProjectionModelCurrentInTx();
    },
  );
}

export async function rebuildProjectionsFromFacts(
  attempts: readonly Attempt[],
  runs: readonly PracticeRun[],
  memberships: readonly BankQuestionMembership[] = [],
): Promise<void> {
  await replaceProjectionRows(projectCanonicalFacts(attempts, runs, memberships));
}

function bankPracticeStatsFromNormalizedFacts(
  runRecords: readonly PracticeRunRecord[],
  runSources: readonly PracticeRunSource[],
  bankFilter?: ReadonlySet<string>,
): BankPracticeStats[] {
  const bankPracticeStats = new Map<string, BankPracticeStats>();
  const bankIdsByRun = new Map<string, Set<string>>();
  for (const source of runSources) {
    if (bankFilter && !bankFilter.has(source.bankId)) continue;
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
      if (run.activityAt > current.latestActivityAt) current.latestActivityAt = run.activityAt;
      bankPracticeStats.set(bankId, current);
    }
  }
  return [...bankPracticeStats.values()];
}

export async function rebuildProjectionImpactFromNormalizedFacts(
  state: CanonicalState,
  impact: ProjectionImpact,
): Promise<void> {
  const questionIds = [...impact.questionIds];
  const bankIds = [...impact.bankIds];
  const questionSet = new Set(questionIds);
  const bankSet = new Set(bankIds);

  const questionProgress: AttemptStats[] = [];
  const questionDailyProgress = new Map<string, AttemptDailyStats>();
  const reviewRoundProgress = new Map<string, ReviewRoundProgress>();
  if (questionIds.length) {
    const attempts = state.attempts.filter((attempt) => questionSet.has(attempt.questionId)).sort(compareAttempts);
    const attemptsByQuestion = new Map<string, Attempt[]>();
    for (const attempt of attempts) {
      const rows = attemptsByQuestion.get(attempt.questionId) ?? [];
      rows.push(attempt);
      attemptsByQuestion.set(attempt.questionId, rows);
      const dailyKey = dailyStatsKey(attempt.createdAt, attempt.questionId);
      questionDailyProgress.set(dailyKey, addDailyStats(questionDailyProgress.get(dailyKey), attempt));
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
    for (const questionId of questionIds) {
      const rebuilt = rebuildAttemptStats(attemptsByQuestion.get(questionId) ?? []);
      if (rebuilt) questionProgress.push(rebuilt);
    }
  }

  const bankQuestionStats = bankIds
    .filter((bankId) => state.banks.some((bank) => bank.id === bankId))
    .map((bankId) => ({
      bankId,
      questionCount: state.memberships.filter((membership) => membership.bankId === bankId).length,
    }));
  const bankPracticeStats = bankPracticeStatsFromNormalizedFacts(state.practiceRuns, state.practiceRunSources, bankSet);

  await studyDb.transaction(
    "rw",
    [
      studyDb.bankQuestionStats,
      studyDb.questionProgress,
      studyDb.questionDailyProgress,
      studyDb.bankPracticeStats,
      studyDb.reviewRoundProgress,
      studyDb.syncMeta,
    ],
    async () => {
      if (questionIds.length) {
        await studyDb.questionProgress.bulkDelete(questionIds);
        await studyDb.questionDailyProgress.where("questionId").anyOf(questionIds).delete();
        await studyDb.reviewRoundProgress.where("questionId").anyOf(questionIds).delete();
        if (questionProgress.length) await studyDb.questionProgress.bulkPut(questionProgress);
        if (questionDailyProgress.size) await studyDb.questionDailyProgress.bulkPut([...questionDailyProgress.values()]);
        if (reviewRoundProgress.size) await studyDb.reviewRoundProgress.bulkPut([...reviewRoundProgress.values()]);
      }
      if (bankIds.length) {
        await studyDb.bankQuestionStats.bulkDelete(bankIds);
        await studyDb.bankPracticeStats.bulkDelete(bankIds);
        if (bankQuestionStats.length) await studyDb.bankQuestionStats.bulkPut(bankQuestionStats);
        if (bankPracticeStats.length) await studyDb.bankPracticeStats.bulkPut(bankPracticeStats);
      }
      await clearProjectionRebuildPendingInTx();
      await markProjectionModelCurrentInTx();
    },
  );
}

/**
 * Restore path for already-normalized canonical run facts. This avoids
 * assembling PracticeRun aggregates only to derive bank-level run statistics.
 */
export async function rebuildProjectionsFromNormalizedFacts(
  attempts: readonly Attempt[],
  runRecords: readonly PracticeRunRecord[],
  runSources: readonly PracticeRunSource[],
  memberships: readonly BankQuestionMembership[],
): Promise<void> {
  const attemptRows = projectCanonicalFacts(attempts, [], memberships);
  await replaceProjectionRows({
    ...attemptRows,
    bankPracticeStats: bankPracticeStatsFromNormalizedFacts(runRecords, runSources),
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
  const [attempts, memberships, records, sources] = await studyDb.transaction(
    "r",
    [studyDb.attempts, studyDb.bankQuestionMemberships, studyDb.practiceRuns, studyDb.practiceRunSources],
    async () => Promise.all([
      studyDb.attempts.toArray(),
      studyDb.bankQuestionMemberships.toArray(),
      studyDb.practiceRuns.toArray(),
      studyDb.practiceRunSources.toArray(),
    ]),
  );
  await rebuildProjectionsFromNormalizedFacts(attempts, records, sources, memberships);
}
