import { studyDb, reconcileProjection, type ChangeSetQueueGuard } from "../db/db";
import type { ChangeSet } from "./change-set-types";
import { replayChangeSetBatch, type ChangeSetProjection } from "./change-set-projection";
import { normalizeProjection } from "./change-set-projection-core";
import type { DirtyInstallKeys } from "./sync-dirty-install";
import type { SyncCheckpoint } from "./sync-checkpoint-types";
import type { SyncDeviceWatermark } from "./sync-head-types";
import { reclaimableTombstones } from "./sync-watermark";

export async function saveQueueBase(projection: ChangeSetProjection): Promise<void> {
  await studyDb.syncMeta.put({ key: "sync:queue-base", value: projection, updatedAt: new Date().toISOString() });
}

export function projectionFromCheckpoint(checkpoint: SyncCheckpoint): Promise<ChangeSetProjection> {
  return Promise.resolve(normalizeProjection({
    ...checkpoint.state,
    memberships: checkpoint.state.memberships,
    imageAssets: checkpoint.state.imageAssets,
  }));
}

export function checkpointFromProjection(
  projection: ChangeSetProjection,
  cursors: Record<string, number>,
  options?: { tombstoneGc?: { devices: Record<string, SyncDeviceWatermark>; headCursors: Record<string, number>; selfDeviceId: string; now?: string } },
): Promise<SyncCheckpoint> {
  let tombstones = projection.tombstones;
  if (options?.tombstoneGc) {
    const gc = reclaimableTombstones(tombstones, options.tombstoneGc);
    tombstones = gc.keep;
  }
  const checkpoint: SyncCheckpoint = {
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

export function replayInWireOrder(projection: ChangeSetProjection, changes: readonly ChangeSet[], onStep?: (done: number, total: number) => void): ChangeSetProjection {
  return replayChangeSetBatch(projection, changes, onStep, { onConflict: "throw" }).projection;
}

export function replayRemoteResilient(projection: ChangeSetProjection, changes: readonly ChangeSet[], onStep?: (done: number, total: number) => void): { projection: ChangeSetProjection; skipped: string[] } {
  return replayChangeSetBatch(projection, changes, onStep);
}

export async function installProjection(
  projection: ChangeSetProjection,
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
  return reconcileProjection({
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