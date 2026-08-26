import { dbV7, restoreV7Checkpoint, type ChangeSetQueueRecordV7, type V7RestoreState } from "../db/db-v7";
import type { AttemptDailyStatsV7, ImageAsset } from "../db/v7-types";
import { SYNC_V7_CHECKPOINT_FORMAT, type SyncCheckpointV7, type SyncCheckpointV7Counts, type SyncCheckpointV7State } from "./sync-v7-checkpoint-types";
import { validateSyncCheckpointV7 } from "./sync-v7-checkpoint-validation";

function withoutBlobs(asset: ImageAsset): Omit<ImageAsset, "blob"> {
  const descriptor = { ...asset } as Omit<ImageAsset, "blob"> & { blob?: Blob };
  delete descriptor.blob;
  return descriptor;
}

function canonicalAttemptDailyStats(rows: readonly AttemptDailyStatsV7[]): AttemptDailyStatsV7[] {
  const merged = new Map<string, AttemptDailyStatsV7>();
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

function countsFor(state: SyncCheckpointV7State): SyncCheckpointV7Counts {
  return {
    banks: state.banks.length, bankFolders: state.bankFolders.length, questions: state.questions.length, memberships: state.memberships.length,
    imageAssets: state.imageAssets.length, attempts: state.attempts.length, attemptStats: state.attemptStats.length, attemptDailyStats: state.attemptDailyStats.length,
    notes: state.notes.length, practiceRuns: state.practiceRuns.length, practiceRunStats: state.practiceRunStats.length, questionGroups: state.questionGroups.length,
    reviewRounds: state.reviewRounds.length, reviewRoundProgress: state.reviewRoundProgress.length, tombstones: state.tombstones.length,
    totalAttempts: state.attempts.length, totalPracticeRuns: state.practiceRuns.length,
  };
}

function cloneState(state: V7RestoreState & { imageAssets: ImageAsset[] }): SyncCheckpointV7State {
  return {
    banks: state.banks.map((item) => ({ ...item })),
    bankFolders: state.bankFolders.map((item) => ({ ...item })),
    questions: state.questions.map((item) => ({ ...item, content: item.content.map((block) => ({ ...block })), options: item.options.map((option) => option.map((block) => ({ ...block }))), tags: [...item.tags] })),
    memberships: state.memberships.map((item) => ({ ...item })),
    imageAssets: state.imageAssets.map(withoutBlobs),
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

export interface SyncCheckpointSnapshotV7 {
  checkpoint: SyncCheckpointV7;
  /** Exact queue rows read by the same IndexedDB transaction as the projection. */
  changeSets: ChangeSetQueueRecordV7[];
}

/** Create a full checkpoint and retain the exact queue rows it covered.
 *
 * Every projection table and change-set cursor is read from one readonly
 * transaction.  A Promise.all over individual Dexie table calls is not a
 * snapshot: a local write can commit between two requests and produce a
 * checkpoint whose projection and cursor describe different moments.
 */
export async function createSyncCheckpointV7Snapshot(generatedAt = new Date().toISOString()): Promise<SyncCheckpointSnapshotV7> {
  const tables = [
    dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.imageAssets,
    dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.notes, dbV7.practiceRuns,
    dbV7.practiceRunStats, dbV7.questionGroups, dbV7.reviewRounds, dbV7.reviewRoundProgress,
    dbV7.tombstones, dbV7.changeSets,
  ] as const;
  const rows = await dbV7.transaction("r", tables, async () => Promise.all([
    dbV7.banks.toArray(), dbV7.bankFolders.toArray(), dbV7.questions.toArray(), dbV7.bankQuestionMemberships.toArray(), dbV7.imageAssets.toArray(),
    dbV7.attempts.toArray(), dbV7.attemptStats.toArray(), dbV7.attemptDailyStats.toArray(), dbV7.notes.toArray(), dbV7.practiceRuns.toArray(), dbV7.practiceRunStats.toArray(),
    dbV7.questionGroups.toArray(), dbV7.reviewRounds.toArray(), dbV7.reviewRoundProgress.toArray(), dbV7.tombstones.toArray(), dbV7.changeSets.toArray(),
  ]));
  const [banks, bankFolders, questions, memberships, imageAssets, attempts, attemptStats, attemptDailyStats, notes, practiceRuns, practiceRunStats, questionGroups, reviewRounds, reviewRoundProgress, tombstones, changeSets] = rows;
  // The local checkpoint is a projection, not an event log.  Cursors track the
  // pending change-set tail so concurrent devices can detect coverage.
  const state = cloneState({ banks, bankFolders, questions, memberships, imageAssets, attempts, attemptStats, attemptDailyStats, notes, practiceRuns, practiceRunStats, questionGroups, reviewRounds, reviewRoundProgress, tombstones });
  const cursors: Record<string, number> = {};
  for (const change of changeSets) cursors[change.deviceId] = Math.max(cursors[change.deviceId] ?? 0, change.localSequence);
  const checkpoint: SyncCheckpointV7 = { formatVersion: SYNC_V7_CHECKPOINT_FORMAT, generatedAt, state, cursors, counts: countsFor(state) };
  validateSyncCheckpointV7(checkpoint);
  return { checkpoint, changeSets };
}

/** Create a full checkpoint from the v7 namespace only. */
export async function createSyncCheckpointV7(generatedAt = new Date().toISOString()): Promise<SyncCheckpointV7> {
  return (await createSyncCheckpointV7Snapshot(generatedAt)).checkpoint;
}

export const createV7Checkpoint = createSyncCheckpointV7;
export const buildSyncCheckpointV7 = createSyncCheckpointV7;
export const createCheckpointV7 = createSyncCheckpointV7;

/** JSON bytes used for content-addressed checkpoint paths. */
export function encodeSyncCheckpointV7(checkpoint: SyncCheckpointV7): Uint8Array {
  validateSyncCheckpointV7(checkpoint);
  return new TextEncoder().encode(JSON.stringify(checkpoint));
}

export function parseSyncCheckpointV7(bytes: Uint8Array | string): SyncCheckpointV7 {
  let parsed: unknown;
  try { parsed = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)) as unknown; } catch { throw new Error("远程 v7 检查点不是有效 JSON。"); }
  validateSyncCheckpointV7(parsed);
  return parsed;
}

/** Restore the complete checkpoint projection in one DB transaction. */
export async function applySyncCheckpointV7(checkpoint: SyncCheckpointV7): Promise<void> {
  validateSyncCheckpointV7(checkpoint);
  await restoreV7Checkpoint(checkpoint.state);
}
