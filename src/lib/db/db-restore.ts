/**
 * Atomic checkpoint restore.
 */
import Dexie from "dexie";
import { studyDb } from "./db-core";
import type { RestoreState } from "./db-core";
import { markProjectionRebuildPendingInTx, rebuildProjectionsFromNormalizedFacts } from "./projection-engine";

export interface ChangeSetQueueGuard {
  id: string;
  digest: string;
  state: string;
  claimId?: string;
  claimedAt?: string;
}

interface RestoreLocalCheckpointProgress {
  completed: number;
  total: number;
  label: string;
}

export interface RestoreLocalCheckpointOptions {
  /**
   * When present, checkpoint replacement is performed only if the complete
   * queue still has exactly these rows. The comparison happens in the same
   * read-write transaction as canonical replacement, so a new local edit
   * either wins before the restore (causing a safe no-op) or commits after it.
   */
  queueGuard?: readonly ChangeSetQueueGuard[];
  /** Clear the queue as part of the guarded canonical replacement. */
  clearChangeSets?: boolean;
  /** Fine-grained local write progress used by the sync UI on slower phones. */
  onProgress?: (progress: RestoreLocalCheckpointProgress) => void;
}

const RESTORE_BATCH_SIZE = 400;
const RESTORE_STALL_TIMEOUT_MS = 30_000;

function queueRow(record: ChangeSetQueueGuard): string {
  return JSON.stringify([record.id, record.digest, record.state, record.claimId ?? null, record.claimedAt ?? null]);
}

function queueMatches(current: readonly ChangeSetQueueGuard[], expected: readonly ChangeSetQueueGuard[]): boolean {
  if (current.length !== expected.length) return false;
  const left = current.map(queueRow).sort();
  const right = expected.map(queueRow).sort();
  return left.every((value, index) => value === right[index]);
}

function restoreRowCount(state: RestoreState): number {
  return [
    state.banks,
    state.bankFolders,
    state.questions,
    state.memberships,
    state.imageAssets,
    state.attempts,
    state.notes,
    state.practiceRuns,
    state.practiceRunSources,
    state.practiceRunItems,
    state.questionGroups,
    state.questionGroupItems,
    state.reviewRounds,
    state.reviewRoundBanks,
    state.reviewRoundItems,
    state.tombstones,
  ].reduce((total, rows) => total + rows.length, 0);
}

/**
 * Replace canonical checkpoint facts atomically, then deterministically rebuild
 * every device-local projection from those facts. Projection rows contained in
 * older checkpoint payloads are deliberately ignored: they are caches, not facts.
 * Pending change-sets are left in place unless the guarded caller explicitly
 * requests clearing them, and projection rebuild never emits a sync change set.
 */
export async function restoreLocalCheckpoint(state: RestoreState, options: RestoreLocalCheckpointOptions = {}): Promise<boolean> {
  // Projection tables are cleared in the canonical install transaction so no
  // stale derived rows survive a successful restore. They are populated only
  // from the already materialized canonical snapshot after that transaction commits.
  const replaceTables = [
    studyDb.banks, studyDb.bankFolders, studyDb.questions, studyDb.bankQuestionMemberships,
    studyDb.attempts, studyDb.questionProgress, studyDb.questionDailyProgress, studyDb.notes, studyDb.practiceRuns, studyDb.practiceRunSources, studyDb.practiceRunItems,
    studyDb.bankPracticeStats, studyDb.questionGroups, studyDb.questionGroupItems, studyDb.reviewRounds, studyDb.reviewRoundBanks, studyDb.reviewRoundItems, studyDb.reviewRoundProgress,
    studyDb.tombstones,
  ];
  const totalRows = Math.max(1, restoreRowCount(state));

  const restored = await studyDb.transaction("rw", [...replaceTables, studyDb.imageAssets, studyDb.imageBlobs, studyDb.changeSets, studyDb.syncMeta], async () => {
    const transaction = Dexie.currentTransaction;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let completedRows = 0;

    const armStallWatchdog = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        try {
          if (transaction?.active) transaction.abort();
        } catch {
          // The transaction may have completed between the timer firing and abort().
        }
      }, RESTORE_STALL_TIMEOUT_MS);
    };
    const touched = () => armStallWatchdog();
    const progress = (count: number, label: string) => {
      completedRows = Math.min(totalRows, completedRows + count);
      options.onProgress?.({ completed: completedRows, total: totalRows, label });
      touched();
    };
    const writeChunks = async <T>(rows: readonly T[], writer: (chunk: T[]) => Promise<unknown>, label: string) => {
      for (let index = 0; index < rows.length; index += RESTORE_BATCH_SIZE) {
        const chunk = rows.slice(index, index + RESTORE_BATCH_SIZE);
        await writer(chunk);
        progress(chunk.length, label);
      }
    };

    armStallWatchdog();
    options.onProgress?.({ completed: 0, total: totalRows, label: "准备写入本机数据库" });
    try {
      if (options.queueGuard) {
        const current = await studyDb.changeSets.toArray();
        touched();
        if (!queueMatches(current, options.queueGuard)) return false;
      }
      await markProjectionRebuildPendingInTx();
      touched();

      for (const table of replaceTables) {
        await table.clear();
        touched();
      }

      // imageAssets is canonical descriptor data reconciled in place. imageBlobs
      // is a local-only cache and never comes from checkpoint state.
      const existingAssetKeys = await studyDb.imageAssets.toCollection().primaryKeys();
      touched();
      const existingAssetIds = new Set(existingAssetKeys.filter((key): key is string => typeof key === "string"));
      const incomingAssetIds = new Set(state.imageAssets.map((asset) => asset.id));
      const removedAssetIds = [...existingAssetIds].filter((id) => !incomingAssetIds.has(id));
      for (let index = 0; index < removedAssetIds.length; index += RESTORE_BATCH_SIZE) {
        const chunk = removedAssetIds.slice(index, index + RESTORE_BATCH_SIZE);
        await studyDb.imageAssets.bulkDelete(chunk);
        await studyDb.imageBlobs.bulkDelete(chunk);
        touched();
      }

      const existingDescriptors = state.imageAssets.filter((asset) => existingAssetIds.has(asset.id));
      await writeChunks(existingDescriptors, (chunk) => studyDb.imageAssets.bulkUpdate(chunk.map((asset) => ({
        key: asset.id,
        changes: {
          mimeType: asset.mimeType,
          size: asset.size,
          width: asset.width,
          height: asset.height,
        },
      }))), "更新图片索引");
      await writeChunks(state.imageAssets.filter((asset) => !existingAssetIds.has(asset.id)), (chunk) => studyDb.imageAssets.bulkPut(chunk), "写入图片索引");

      await writeChunks(state.banks, (chunk) => studyDb.banks.bulkPut(chunk), "写入题库");
      await writeChunks(state.bankFolders, (chunk) => studyDb.bankFolders.bulkPut(chunk), "写入文件夹");
      await writeChunks(state.questions, (chunk) => studyDb.questions.bulkPut(chunk), "写入题目");
      await writeChunks(state.memberships, (chunk) => studyDb.bankQuestionMemberships.bulkPut(chunk), "写入题库关系");
      await writeChunks(state.attempts, (chunk) => studyDb.attempts.bulkPut(chunk), "写入作答记录");
      await writeChunks(state.notes, (chunk) => studyDb.notes.bulkPut(chunk), "写入解析笔记");
      await writeChunks(state.practiceRuns, (chunk) => studyDb.practiceRuns.bulkPut(chunk), "写入练习记录");
      await writeChunks(state.practiceRunSources, (chunk) => studyDb.practiceRunSources.bulkPut(chunk), "写入练习来源关系");
      await writeChunks(state.practiceRunItems, (chunk) => studyDb.practiceRunItems.bulkPut(chunk), "写入练习题目关系");
      await writeChunks(state.questionGroups, (chunk) => studyDb.questionGroups.bulkPut(chunk), "写入题组");
      await writeChunks(state.questionGroupItems, (chunk) => studyDb.questionGroupItems.bulkPut(chunk), "写入题组关系");
      await writeChunks(state.reviewRounds, (chunk) => studyDb.reviewRounds.bulkPut(chunk), "写入复习轮次");
      await writeChunks(state.reviewRoundBanks, (chunk) => studyDb.reviewRoundBanks.bulkPut(chunk), "写入复习轮次题库关系");
      await writeChunks(state.reviewRoundItems, (chunk) => studyDb.reviewRoundItems.bulkPut(chunk), "写入复习轮次题目关系");
      await writeChunks(state.tombstones, (chunk) => studyDb.tombstones.bulkPut(chunk), "写入删除标记");
      if (options.clearChangeSets) {
        await studyDb.changeSets.clear();
        touched();
      }
      return true;
    } catch (error) {
      if (stalled) throw new Error("本机数据库写入长时间无响应，已安全取消本次写入。请保持应用在前台后重试同步。");
      throw error;
    } finally {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
    }
  });

  if (!restored) return false;
  options.onProgress?.({ completed: totalRows, total: totalRows, label: "重建本地学习统计" });
  await rebuildProjectionsFromNormalizedFacts(state.attempts, state.practiceRuns, state.practiceRunSources);
  options.onProgress?.({ completed: totalRows, total: totalRows, label: "本机数据库写入完成" });
  return true;
}
