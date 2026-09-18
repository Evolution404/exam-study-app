import { studyDb, restoreLocalCheckpoint, type ChangeSetQueueRecord, type RestoreState } from "../db/db";
import { assemblePracticeRunRecords } from "../db/practice-run-store";
import { SYNC_CHECKPOINT_FORMAT, type SyncCheckpoint, type SyncCheckpointCounts, type SyncCheckpointState } from "./sync-checkpoint-types";
import { validateSyncCheckpoint } from "./sync-checkpoint-validation";

function countsFor(state: SyncCheckpointState): SyncCheckpointCounts {
  return {
    banks: state.banks.length,
    bankFolders: state.bankFolders.length,
    questions: state.questions.length,
    memberships: state.memberships.length,
    imageAssets: state.imageAssets.length,
    attempts: state.attempts.length,
    notes: state.notes.length,
    practiceRuns: state.practiceRuns.length,
    practiceRunSources: state.practiceRunSources.length,
    practiceRunItems: state.practiceRunItems.length,
    questionGroups: state.questionGroups.length,
    questionGroupItems: state.questionGroupItems.length,
    reviewRounds: state.reviewRounds.length,
    reviewRoundBanks: state.reviewRoundBanks.length,
    reviewRoundItems: state.reviewRoundItems.length,
    tombstones: state.tombstones.length,
    totalAttempts: state.attempts.length,
    totalPracticeRuns: state.practiceRuns.length,
  };
}

function cloneState(state: SyncCheckpointState): SyncCheckpointState {
  return structuredClone(state);
}

export interface SyncCheckpointSnapshot {
  checkpoint: SyncCheckpoint;
  /** Exact queue rows read by the same IndexedDB transaction as the canonical facts. */
  changeSets: ChangeSetQueueRecord[];
}

/**
 * Create a canonical checkpoint and retain the exact queue rows it covered.
 *
 * Canonical tables and change-set cursors are read from one readonly transaction.
 * Device-local projection/cache tables are intentionally absent: they are rebuilt
 * after restore and must never influence remote payload bytes.
 */
export async function createSyncCheckpointSnapshot(generatedAt = new Date().toISOString()): Promise<SyncCheckpointSnapshot> {
  const tables = [
    studyDb.banks,
    studyDb.bankFolders,
    studyDb.questions,
    studyDb.bankQuestionMemberships,
    studyDb.imageAssets,
    studyDb.attempts,
    studyDb.notes,
    studyDb.practiceRuns,
    studyDb.practiceRunSources,
    studyDb.practiceRunItems,
    studyDb.questionGroups,
    studyDb.questionGroupItems,
    studyDb.reviewRounds,
    studyDb.reviewRoundBanks,
    studyDb.reviewRoundItems,
    studyDb.tombstones,
    studyDb.changeSets,
  ] as const;
  const rows = await studyDb.transaction("r", tables, async () => Promise.all([
    studyDb.banks.toArray(),
    studyDb.bankFolders.toArray(),
    studyDb.questions.toArray(),
    studyDb.bankQuestionMemberships.toArray(),
    studyDb.imageAssets.toArray(),
    studyDb.attempts.toArray(),
    studyDb.notes.toArray(),
    studyDb.practiceRuns.toArray(),
    studyDb.practiceRunSources.toArray(),
    studyDb.practiceRunItems.toArray(),
    studyDb.questionGroups.toArray(),
    studyDb.questionGroupItems.toArray(),
    studyDb.reviewRounds.toArray(),
    studyDb.reviewRoundBanks.toArray(),
    studyDb.reviewRoundItems.toArray(),
    studyDb.tombstones.toArray(),
    studyDb.changeSets.toArray(),
  ]));
  const [
    banks,
    bankFolders,
    questions,
    memberships,
    imageAssets,
    attempts,
    notes,
    practiceRuns,
    practiceRunSources,
    practiceRunItems,
    questionGroups,
    questionGroupItems,
    reviewRounds,
    reviewRoundBanks,
    reviewRoundItems,
    tombstones,
    changeSets,
  ] = rows;
  const state = cloneState({
    banks,
    bankFolders,
    questions,
    memberships,
    imageAssets,
    attempts,
    notes,
    practiceRuns,
    practiceRunSources,
    practiceRunItems,
    questionGroups,
    questionGroupItems,
    reviewRounds,
    reviewRoundBanks,
    reviewRoundItems,
    tombstones,
  });
  const cursors: Record<string, number> = {};
  for (const change of changeSets) cursors[change.deviceId] = Math.max(cursors[change.deviceId] ?? 0, change.localSequence);
  const checkpoint: SyncCheckpoint = {
    formatVersion: SYNC_CHECKPOINT_FORMAT,
    generatedAt,
    state,
    cursors,
    counts: countsFor(state),
  };
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
  try {
    parsed = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("远程检查点不是有效 JSON。");
  }
  validateSyncCheckpoint(parsed);
  return parsed;
}

/**
 * Restore the current canonical checkpoint through the local canonical write
 * adapter. Rebuildable projections are intentionally absent from RestoreState
 * and are regenerated only after canonical facts commit.
 */
export async function applySyncCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
  validateSyncCheckpoint(checkpoint);
  const state = checkpoint.state;
  const practiceRuns = assemblePracticeRunRecords(
    state.practiceRuns,
    state.practiceRunSources,
    state.practiceRunItems,
    state.attempts,
  );
  const restoreState: RestoreState = {
    banks: state.banks,
    bankFolders: state.bankFolders,
    questions: state.questions,
    memberships: state.memberships,
    imageAssets: state.imageAssets,
    attempts: state.attempts,
    notes: state.notes,
    practiceRuns,
    questionGroups: state.questionGroups.map((group) => ({
      ...group,
      items: state.questionGroupItems
        .filter((item) => item.groupId === group.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => ({ questionId: item.questionId, note: item.note ?? "" })),
    })),
    reviewRounds: state.reviewRounds.map((round) => {
      const finalQuestionIds = state.reviewRoundItems
        .filter((item) => item.roundId === round.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => item.questionId);
      return {
        ...round,
        bankIds: state.reviewRoundBanks
          .filter((bank) => bank.roundId === round.id)
          .sort((left, right) => left.position - right.position)
          .map((bank) => bank.bankId),
        ...(finalQuestionIds.length ? { finalQuestionIds } : {}),
      };
    }),
    tombstones: state.tombstones,
  };
  await restoreLocalCheckpoint(restoreState);
}
