import { studyDb, reconcileProjection, type ChangeSetQueueGuard } from "../db/db";
import { assemblePracticeRunRecords, decomposePracticeRuns } from "../db/practice-run-store";
import type { QuestionGroupItem, QuestionGroupRecord, ReviewRoundBank, ReviewRoundItem, ReviewRoundRecord } from "../db/types";
import type { ChangeSet } from "./change-set-types";
import { recomputeChangeSetProjection, replayChangeSetBatch, type ChangeSetProjection } from "./change-set-projection";
import type { DirtyInstallKeys } from "./sync-dirty-install";
import { SYNC_CHECKPOINT_FORMAT, type SyncCheckpoint, type SyncCheckpointCounts, type SyncCheckpointState } from "./sync-checkpoint-types";
import type { SyncDeviceWatermark } from "./sync-head-types";
import { reclaimableTombstones } from "./sync-watermark";

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

function canonicalQuestionGroups(projection: ChangeSetProjection): {
  records: QuestionGroupRecord[];
  items: QuestionGroupItem[];
} {
  const records: QuestionGroupRecord[] = [];
  const items: QuestionGroupItem[] = [];
  for (const group of projection.questionGroups) {
    const { items: groupItems, ...record } = group;
    records.push(record);
    groupItems.forEach((item, position) => {
      items.push({
        groupId: group.id,
        questionId: item.questionId,
        position,
        ...(item.note ? { note: item.note } : {}),
      });
    });
  }
  return { records, items };
}

function canonicalReviewRounds(projection: ChangeSetProjection): {
  records: ReviewRoundRecord[];
  banks: ReviewRoundBank[];
  items: ReviewRoundItem[];
} {
  const records: ReviewRoundRecord[] = [];
  const banks: ReviewRoundBank[] = [];
  const items: ReviewRoundItem[] = [];
  for (const round of projection.reviewRounds) {
    const { bankIds, finalQuestionIds, ...record } = round;
    records.push(record);
    bankIds.forEach((bankId, position) => banks.push({ roundId: round.id, bankId, position }));
    (finalQuestionIds ?? []).forEach((questionId, position) => items.push({ roundId: round.id, questionId, position }));
  }
  return { records, banks, items };
}

export async function saveQueueBase(projection: ChangeSetProjection): Promise<void> {
  await studyDb.syncMeta.put({ key: "sync:queue-base", value: projection, updatedAt: new Date().toISOString() });
}

/**
 * Hydrate the reducer's in-memory aggregate model from canonical checkpoint facts.
 * The aggregate shape is internal only; no derived/projection arrays are accepted
 * from the wire and all projections are recomputed locally.
 */
export function projectionFromCheckpoint(checkpoint: SyncCheckpoint): Promise<ChangeSetProjection> {
  const state = checkpoint.state;
  const practiceRuns = assemblePracticeRunRecords(
    state.practiceRuns,
    state.practiceRunSources,
    state.practiceRunItems,
    state.attempts,
  );
  const questionGroups = state.questionGroups.map((group) => ({
    ...group,
    items: state.questionGroupItems
      .filter((item) => item.groupId === group.id)
      .sort((left, right) => left.position - right.position || left.questionId.localeCompare(right.questionId))
      .map((item) => ({ questionId: item.questionId, note: item.note ?? "" })),
  }));
  const reviewRounds = state.reviewRounds.map((round) => {
    const finalQuestionIds = state.reviewRoundItems
      .filter((item) => item.roundId === round.id)
      .sort((left, right) => left.position - right.position || left.questionId.localeCompare(right.questionId))
      .map((item) => item.questionId);
    return {
      ...round,
      bankIds: state.reviewRoundBanks
        .filter((bank) => bank.roundId === round.id)
        .sort((left, right) => left.position - right.position || left.bankId.localeCompare(right.bankId))
        .map((bank) => bank.bankId),
      ...(finalQuestionIds.length ? { finalQuestionIds } : {}),
    };
  });
  return Promise.resolve(recomputeChangeSetProjection({
    banks: structuredClone(state.banks),
    bankFolders: structuredClone(state.bankFolders),
    questions: structuredClone(state.questions),
    memberships: structuredClone(state.memberships),
    imageAssets: structuredClone(state.imageAssets),
    attempts: structuredClone(state.attempts),
    attemptStats: [],
    attemptDailyStats: [],
    notes: structuredClone(state.notes),
    practiceRuns,
    practiceRunStats: [],
    questionGroups,
    reviewRounds,
    reviewRoundProgress: [],
    tombstones: structuredClone(state.tombstones),
  }));
}

/**
 * Convert the reducer's internal aggregate model back to canonical facts only.
 * Device-local projections are deliberately omitted from the checkpoint state.
 */
export function canonicalStateFromProjection(
  projection: ChangeSetProjection,
  tombstones: readonly ChangeSetProjection["tombstones"][number][] = projection.tombstones,
): SyncCheckpointState {
  const runBundles = decomposePracticeRuns(projection.practiceRuns, projection.attempts);
  const groups = canonicalQuestionGroups(projection);
  const rounds = canonicalReviewRounds(projection);
  return {
    banks: structuredClone(projection.banks),
    bankFolders: structuredClone(projection.bankFolders),
    questions: structuredClone(projection.questions),
    memberships: structuredClone(projection.memberships),
    imageAssets: projection.imageAssets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mimeType,
      size: asset.size,
      width: asset.width,
      height: asset.height,
    })),
    attempts: structuredClone(projection.attempts),
    notes: structuredClone(projection.notes),
    practiceRuns: runBundles.map((bundle) => bundle.record),
    practiceRunSources: runBundles.flatMap((bundle) => bundle.sources),
    practiceRunItems: runBundles.flatMap((bundle) => bundle.items),
    questionGroups: groups.records,
    questionGroupItems: groups.items,
    reviewRounds: rounds.records,
    reviewRoundBanks: rounds.banks,
    reviewRoundItems: rounds.items,
    tombstones: structuredClone(tombstones),
  };
}

export function checkpointFromProjection(
  projection: ChangeSetProjection,
  cursors: Record<string, number>,
  options?: { tombstoneGc?: { devices: Record<string, SyncDeviceWatermark>; headCursors: Record<string, number>; selfDeviceId: string; now?: string } },
): Promise<SyncCheckpoint> {
  let tombstones = projection.tombstones;
  if (options?.tombstoneGc) tombstones = reclaimableTombstones(tombstones, options.tombstoneGc).keep;
  const state = canonicalStateFromProjection(projection, tombstones);
  return Promise.resolve({
    formatVersion: SYNC_CHECKPOINT_FORMAT,
    generatedAt: new Date().toISOString(),
    cursors: { ...cursors },
    state,
    counts: countsFor(state),
  });
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