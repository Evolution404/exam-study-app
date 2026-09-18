import { reconcileProjection, studyDb, type ChangeSetQueueGuard } from "../db/db";
import type { CanonicalState } from "../db/types";
import type { ChangeSet } from "./change-set-types";
import { normalizeCanonicalStateForReplay, replayChangeSetBatch } from "./change-set-projection";
import type { DirtyInstallKeys } from "./sync-dirty-install";
import { SYNC_CHECKPOINT_FORMAT, type SyncCheckpoint, type SyncCheckpointCounts } from "./sync-checkpoint-types";
import type { SyncDeviceWatermark } from "./sync-head-types";
import { reclaimableTombstones } from "./sync-watermark";

function countsFor(state: CanonicalState): SyncCheckpointCounts {
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

export async function saveQueueBase(state: CanonicalState): Promise<void> {
  await studyDb.syncMeta.put({ key: "sync:queue-base", value: structuredClone(state), updatedAt: new Date().toISOString() });
}

export function canonicalStateFromCheckpoint(checkpoint: SyncCheckpoint): CanonicalState {
  return normalizeCanonicalStateForReplay(structuredClone(checkpoint.state));
}

export function checkpointFromCanonicalState(
  input: CanonicalState,
  cursors: Record<string, number>,
  options?: { tombstoneGc?: { devices: Record<string, SyncDeviceWatermark>; headCursors: Record<string, number>; selfDeviceId: string; now?: string } },
): Promise<SyncCheckpoint> {
  const state = normalizeCanonicalStateForReplay(input);
  let tombstones = state.tombstones;
  if (options?.tombstoneGc) tombstones = reclaimableTombstones(tombstones, options.tombstoneGc).keep;
  const checkpointState = { ...state, tombstones: structuredClone(tombstones) };
  return Promise.resolve({
    formatVersion: SYNC_CHECKPOINT_FORMAT,
    generatedAt: new Date().toISOString(),
    cursors: { ...cursors },
    state: checkpointState,
    counts: countsFor(checkpointState),
  });
}

export function replayInWireOrder(state: CanonicalState, changes: readonly ChangeSet[], onStep?: (done: number, total: number) => void): CanonicalState {
  return replayChangeSetBatch(state, changes, onStep, { onConflict: "throw" }).state;
}

export function replayRemoteResilient(
  state: CanonicalState,
  changes: readonly ChangeSet[],
  onStep?: (done: number, total: number) => void,
): { state: CanonicalState; skipped: string[] } {
  return replayChangeSetBatch(state, changes, onStep);
}

export async function installCanonicalState(
  state: CanonicalState,
  options?: {
    queueGuard?: readonly ChangeSetQueueGuard[];
    clearChangeSets?: boolean;
    dirtyKeys?: DirtyInstallKeys;
    onProgress?: (progress: { completed: number; total: number; label: string }) => void;
    onTiming?: (timing: {
      phase: "plan" | "write";
      table: string;
      durationMs: number;
      scannedRows: number;
      comparedRows: number;
      putRows: number;
      deleteRows: number;
      mode: "full" | "fresh" | "dirty";
    }) => void;
  },
): Promise<boolean> {
  return reconcileProjection(state, options);
}
