import { dbV7, restoreV7Checkpoint, type V7ChangeSetQueueGuard } from "../db/db-v7";
import type { ChangeSetV7 } from "./change-set-v7";
import { replayChangeSetBatchV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import type { SyncCheckpointV7 } from "./sync-v7-checkpoint";
import type { SyncV7DeviceWatermark } from "./sync-v7-head";
import { reclaimableTombstonesV7 } from "./sync-v7-watermark";

export async function saveQueueBase(projection: ChangeSetProjectionV7): Promise<void> {
  await dbV7.syncMeta.put({ key: "v7:queue-base", value: projection, updatedAt: new Date().toISOString() });
}

export function projectionFromCheckpoint(checkpoint: SyncCheckpointV7): Promise<ChangeSetProjectionV7> {
  return Promise.resolve({ ...checkpoint.state, memberships: checkpoint.state.memberships, imageAssets: checkpoint.state.imageAssets });
}

export function checkpointFromProjection(
  projection: ChangeSetProjectionV7,
  cursors: Record<string, number>,
  options?: { tombstoneGc?: { devices: Record<string, SyncV7DeviceWatermark>; headCursors: Record<string, number>; selfDeviceId: string; now?: string } },
): Promise<SyncCheckpointV7> {
  // Causally-stable tombstone GC (H3/H4): reclaim tombstones every known
  // device has observed; the compaction checkpoint is the only place old
  // tombstones would otherwise persist forever.
  let tombstones = projection.tombstones;
  if (options?.tombstoneGc) {
    const gc = reclaimableTombstonesV7(tombstones, options.tombstoneGc);
    tombstones = gc.keep;
  }
  // Serialize the explicit wire schema instead of spreading the internal
  // projection object. ChangeSetProjectionV7 intentionally carries aliases
  // such as bankQuestionMemberships (and reducer-only metadata such as
  // attemptRoundIds); leaking those into checkpoint JSON duplicates data and
  // makes a hydrate/rebuild produce a structurally different checkpoint even
  // when every persisted entity is identical.
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
        remote: asset.remote,
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
  // Strict batch replay: compaction/restore must fail loudly on any bad record,
  // but derived tables recompute + validate once instead of per record.
  return replayChangeSetBatchV7(projection, changes, onStep, { onConflict: "throw" }).projection;
}

// Replay remote (committed) change-sets defensively. A single poisoned record — e.g. a
// committed upsert for an entity already tombstoned and compacted into the checkpoint —
// throws inside the batch applier (rejectTombstoned). Previously that rejected the ENTIRE
// sync, so one such record permanently blocked a device from pulling anything. Skip poison
// records instead: the checkpoint/tombstone state already won the conflict, so dropping the
// conflicting replay is the correct end state. Skipped ids are surfaced (not silent) and the
// records are still marked committed via the cursor watermark, so they won't re-pull forever.
export function replayRemoteResilient(projection: ChangeSetProjectionV7, changes: readonly ChangeSetV7[], onStep?: (done: number, total: number) => void): { projection: ChangeSetProjectionV7; skipped: string[] } {
  return replayChangeSetBatchV7(projection, changes, onStep);
}

export async function installProjection(
  projection: ChangeSetProjectionV7,
  options?: { queueGuard?: readonly V7ChangeSetQueueGuard[]; clearChangeSets?: boolean },
): Promise<boolean> {
  // Restore directly from the projection state — building a full checkpoint
  // envelope (with counts/cursors) just to unwrap it was pure overhead.
  return restoreV7Checkpoint({
    ...projection,
    memberships: projection.memberships,
    imageAssets: projection.imageAssets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mimeType,
      size: asset.size,
      width: asset.width,
      height: asset.height,
      remote: asset.remote,
    })),
  }, options);
}
