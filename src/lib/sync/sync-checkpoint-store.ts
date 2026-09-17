import { studyDb, restoreLocalCheckpoint, type ChangeSetQueueRecord, type RestoreState } from "../db/db";
import type { AttemptDailyStats } from "../db/types";
import { assemblePracticeRunRecords } from "../db/practice-run-store";
import { SYNC_CHECKPOINT_FORMAT, type SyncCheckpoint, type SyncCheckpointCounts, type SyncCheckpointState } from "./sync-checkpoint-types";
import { validateSyncCheckpoint } from "./sync-checkpoint-validation";

function canonicalAttemptDailyStats(rows: readonly AttemptDailyStats[]): AttemptDailyStats[] {
  const merged = new Map<string, AttemptDailyStats>();
  for (const row of rows) {
    const key = `${row.date}:${row.questionId}`;
    const current = merged.get(key);
    if (!current) merged.set(key, { ...row, key });
    else merged.set(key, {
      ...current,
      total: current.total + row.total,
      correct: current.correct + row.correct,
      wrong: current.wrong + row.wrong,
      giveUps: current.giveUps + row.giveUps,
      totalElapsedMs: current.totalElapsedMs + row.totalElapsedMs,
    });
  }
  return [...merged.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function countsFor(state: SyncCheckpointState): SyncCheckpointCounts {
  return {
    banks: state.banks.length, bankFolders: state.bankFolders.length, questions: state.questions.length, memberships: state.memberships.length,
    imageAssets: state.imageAssets.length, attempts: state.attempts.length, attemptStats: state.attemptStats.length, attemptDailyStats: state.attemptDailyStats.length,
    notes: state.notes.length, practiceRuns: state.practiceRuns.length, practiceRunStats: state.practiceRunStats.length, questionGroups: state.questionGroups.length,
    reviewRounds: state.reviewRounds.length, reviewRoundProgress: state.reviewRoundProgress.length, tombstones: state.tombstones.length,
    totalAttempts: state.attempts.length, totalPracticeRuns: state.practiceRuns.length,
  };
}

function cloneState(state: RestoreState): SyncCheckpointState {
  return {
    banks: state.banks.map((item) => ({ ...item })),
    bankFolders: state.bankFolders.map((item) => ({ ...item })),
    questions: state.questions.map((item) => ({ ...item, content: item.content.map((block) => ({ ...block })), options: item.options.map((option) => option.map((block) => ({ ...block }))), tags: [...item.tags] })),
    memberships: state.memberships.map((item) => ({ ...item })),
    imageAssets: state.imageAssets.map((item) => ({ ...item })),
    attempts: state.attempts.map((item) => ({ ...item })),
    attemptStats: state.attemptStats.map((item) => ({ ...item, recentOutcomes: item.recentOutcomes.map((outcome) => ({ ...outcome })) })),
    attemptDailyStats: canonicalAttemptDailyStats(state.attemptDailyStats),
    notes: state.notes.map((item) => ({ ...item })),
    practiceRuns: state.practiceRuns.map((item) => ({ ...item, bankIds: [...item.bankIds], questionIds: [...item.questionIds], questionTypes: { ...item.questionTypes }, answers: { ...item.answers }, optionOrders: { ...item.optionOrders } })),
    practiceRunStats: state.practiceRunStats.map((item) => ({ ...item })),
    questionGroups: state.questionGroups.map((item) => ({ ...item, items: item.items.map((entry) => ({ ...entry })) })),
    reviewRounds: state.reviewRounds.map((item) => ({ ...item, bankIds: [...item.bankIds], finalQuestionIds: item.finalQuestionIds ? [...item.finalQuestionIds] : undefined })),
    reviewRoundProgress: state.reviewRoundProgress.map((item) => ({ ...item, recentOutcomes: item.recentOutcomes?.map((outcome) => ({ ...outcome })) })),
    tombstones: state.tombstones.map((item) => ({ ...item })),
  };
}

export interface SyncCheckpointSnapshot {
  checkpoint: SyncCheckpoint;
  /** Exact queue rows read by the same IndexedDB transaction as the projection. */
  changeSets: ChangeSetQueueRecord[];
}

/** Create a full checkpoint and retain the exact queue rows it covered.
 *
 * Every projection table and change-set cursor is read from one readonly
 * transaction.  A Promise.all over individual Dexie table calls is not a
 * snapshot: a local write can commit between two requests and produce a
 * checkpoint whose projection and cursor describe different moments.
 */
export async function createSyncCheckpointSnapshot(generatedAt = new Date().toISOString()): Promise<SyncCheckpointSnapshot> {
  const tables = [
    studyDb.banks, studyDb.bankFolders, studyDb.questions, studyDb.bankQuestionMemberships, studyDb.imageAssets,
    studyDb.attempts, studyDb.questionProgress, studyDb.questionDailyProgress, studyDb.notes, studyDb.practiceRuns, studyDb.practiceRunSources, studyDb.practiceRunItems,
    studyDb.bankPracticeStats, studyDb.questionGroups, studyDb.questionGroupItems, studyDb.reviewRounds, studyDb.reviewRoundBanks, studyDb.reviewRoundItems, studyDb.reviewRoundProgress,
    studyDb.tombstones, studyDb.changeSets,
  ] as const;
  const rows = await studyDb.transaction("r", tables, async () => Promise.all([
    studyDb.banks.toArray(), studyDb.bankFolders.toArray(), studyDb.questions.toArray(), studyDb.bankQuestionMemberships.toArray(), studyDb.imageAssets.toArray(),
    studyDb.attempts.toArray(), studyDb.questionProgress.toArray(), studyDb.questionDailyProgress.toArray(), studyDb.notes.toArray(), studyDb.practiceRuns.toArray(), studyDb.practiceRunSources.toArray(), studyDb.practiceRunItems.toArray(), studyDb.bankPracticeStats.toArray(),
    studyDb.questionGroups.toArray(), studyDb.questionGroupItems.toArray(), studyDb.reviewRounds.toArray(), studyDb.reviewRoundBanks.toArray(), studyDb.reviewRoundItems.toArray(), studyDb.reviewRoundProgress.toArray(), studyDb.tombstones.toArray(), studyDb.changeSets.toArray(),
  ]));
  const [banks, bankFolders, questions, memberships, imageAssets, attempts, attemptStats, attemptDailyStats, notes, practiceRunRecords, practiceRunSources, practiceRunItems, practiceRunStats, questionGroupRecords, questionGroupItems, reviewRoundRecords, reviewRoundBanks, reviewRoundItems, reviewRoundProgress, tombstones, changeSets] = rows;
  const practiceRuns = assemblePracticeRunRecords(practiceRunRecords, practiceRunSources, practiceRunItems, attempts);
  // The local checkpoint is a projection, not an event log.  Cursors track the
  // pending change-set tail so concurrent devices can detect coverage.
  const state = cloneState({
    banks,
    bankFolders,
    questions,
    memberships,
    imageAssets,
    attempts,
    attemptStats,
    attemptDailyStats,
    notes,
    practiceRuns,
    practiceRunStats: practiceRunStats.map((stats) => ({
      key: stats.bankId,
      bankId: stats.bankId,
      total: stats.total,
      completed: stats.completed,
      inProgress: stats.inProgress,
      abandoned: stats.abandoned,
      latestUpdatedAt: stats.latestActivityAt,
    })),
    questionGroups: questionGroupRecords.map((group) => ({
      ...group,
      items: questionGroupItems
        .filter((item) => item.groupId === group.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => ({ questionId: item.questionId, note: item.note ?? "" })),
    })),
    reviewRounds: reviewRoundRecords.map((round) => {
      const finalQuestionIds = reviewRoundItems
        .filter((item) => item.roundId === round.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => item.questionId);
      return {
        ...round,
        bankIds: reviewRoundBanks
          .filter((bank) => bank.roundId === round.id)
          .sort((left, right) => left.position - right.position)
          .map((bank) => bank.bankId),
        ...(finalQuestionIds.length ? { finalQuestionIds } : {}),
      };
    }),
    reviewRoundProgress,
    tombstones,
  });
  const cursors: Record<string, number> = {};
  for (const change of changeSets) cursors[change.deviceId] = Math.max(cursors[change.deviceId] ?? 0, change.localSequence);
  const checkpoint: SyncCheckpoint = { formatVersion: SYNC_CHECKPOINT_FORMAT, generatedAt, state, cursors, counts: countsFor(state) };
  validateSyncCheckpoint(checkpoint);
  return { checkpoint, changeSets };
}

/** Create a full checkpoint from the current local namespace only. */
export async function createSyncCheckpoint(generatedAt = new Date().toISOString()): Promise<SyncCheckpoint> {
  return (await createSyncCheckpointSnapshot(generatedAt)).checkpoint;
}

export const createLocalCheckpoint = createSyncCheckpoint;
export const buildSyncCheckpoint = createSyncCheckpoint;
export const createCheckpoint = createSyncCheckpoint;

/** JSON bytes used for content-addressed checkpoint paths. */
export function encodeSyncCheckpoint(checkpoint: SyncCheckpoint): Uint8Array {
  validateSyncCheckpoint(checkpoint);
  return new TextEncoder().encode(JSON.stringify(checkpoint));
}

export function parseSyncCheckpoint(bytes: Uint8Array | string): SyncCheckpoint {
  let parsed: unknown;
  try { parsed = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)) as unknown; } catch { throw new Error("远程检查点不是有效 JSON。"); }
  validateSyncCheckpoint(parsed);
  return parsed;
}

/** Restore the complete checkpoint projection in one DB transaction. */
export async function applySyncCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
  validateSyncCheckpoint(checkpoint);
  await restoreLocalCheckpoint(checkpoint.state);
}
