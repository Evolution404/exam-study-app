import { dbV7, reconcileV7Projection, type V7ChangeSetQueueGuard } from "../db/db-v7";
import type { ChangeSetV7 } from "./change-set-v7-types";
import { replayChangeSetBatchV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import { normalizeProjection } from "./change-set-v7-projection-core";
import type { DirtyInstallKeysV7 } from "./sync-v7-dirty-install";
import type { SyncCheckpointV7 } from "./sync-v7-checkpoint-types";
import type { SyncV7DeviceWatermark } from "./sync-v7-head-types";
import { reclaimableTombstonesV7 } from "./sync-v7-watermark";

export async function saveQueueBase(projection: ChangeSetProjectionV7): Promise<void> {
  await dbV7.syncMeta.put({ key: "v7:queue-base", value: projection, updatedAt: new Date().toISOString() });
}

export function projectionFromCheckpoint(checkpoint: SyncCheckpointV7): Promise<ChangeSetProjectionV7> {
  return Promise.resolve(normalizeProjection({
    ...checkpoint.state,
    memberships: checkpoint.state.memberships,
    imageAssets: checkpoint.state.imageAssets,
  }));
}

export function checkpointFromProjection(
  projection: ChangeSetProjectionV7,
  cursors: Record<string, number>,
  options?: { tombstoneGc?: { devices: Record<string, SyncV7DeviceWatermark>; headCursors: Record<string, number>; selfDeviceId: string; now?: string } },
): Promise<SyncCheckpointV7> {
  let tombstones = projection.tombstones;
  if (options?.tombstoneGc) {
    const gc = reclaimableTombstonesV7(tombstones, options.tombstoneGc);
    tombstones = gc.keep;
  }
  const checkpoint: SyncCheckpointV7 = {
    formatVersion: 7,
    generatedAt: new Date().toISOString(),
    cursors: { ...cursors },
    state: {
      banks: projection.banks,
      bankFolders: projection.bankFolders,
      questions: projection.questions,
      memberships: projection.memberships,
      imageAssets: projection.imageAssets.map((asset) => ({
        id: asset.id,
        mimeType: asset.mimeType,
        size: asset.size,
        width: asset.width,
        height: asset.height,
      })),
      attempts: projection.attempts,
      attemptStats: projection.attemptStats,
      attemptDailyStats: projection.attemptDailyStats,
      notes: projection.notes,
      practiceRuns: projection.practiceRuns,
      practiceRunStats: projection.practiceRunStats,
      questionGroups: projection.questionGroups,
      reviewRounds: projection.reviewRounds,
      reviewRoundProgress: projection.reviewRoundProgress,
      tombstones,
    },
    counts: {
      banks: projection.banks.length,
      bankFolders: projection.bankFolders.length,
      questions: projection.questions.length,
      memberships: projection.memberships.length,
      imageAssets: projection.imageAssets.length,
      attempts: projection.attempts.length,
      attemptStats: projection.attemptStats.length,
      attemptDailyStats: projection.attemptDailyStats.length,
      notes: projection.notes.length,
      practiceRuns: projection.practiceRuns.length,
      practiceRunStats: projection.practiceRunStats.length,
      questionGroups: projection.questionGroups.length,
      reviewRounds: projection.reviewRounds.length,
      reviewRoundProgress: projection.reviewRoundProgress.length,
      tombstones: tombstones.length,
      totalAttempts: projection.attempts.length,
      totalPracticeRuns: projection.practiceRuns.length,
    },
  };
  return Promise.resolve(checkpoint);
}

export function replayInWireOrder(projection: ChangeSetProjectionV7, changes: readonly ChangeSetV7[], onStep?: (done: number, total: number) => void): ChangeSetProjectionV7 {
  return replayChangeSetBatchV7(projection, changes, onStep, { onConflict: "throw" }).projection;
}

export function replayRemoteResilient(projection: ChangeSetProjectionV7, changes: readonly ChangeSetV7[], onStep?: (done: number, total: number) => void): { projection: ChangeSetProjectionV7; skipped: string[] } {
  return replayChangeSetBatchV7(projection, changes, onStep);
}

export async function installProjection(
  projection: ChangeSetProjectionV7,
  options?: {
    queueGuard?: readonly V7ChangeSetQueueGuard[];
    clearChangeSets?: boolean;
    dirtyKeys?: DirtyInstallKeysV7;
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
  return reconcileV7Projection({
    ...projection,
    memberships: projection.memberships,
    imageAssets: projection.imageAssets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mimeType,
      size: asset.size,
      width: asset.width,
      height: asset.height,
    })),
  }, options);
}