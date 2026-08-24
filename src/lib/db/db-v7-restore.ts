/**
 * v7 atomic checkpoint restore.
 */
import Dexie from "dexie";
import { dbV7 } from "./db-v7-core";
import type { V7RestoreState } from "./db-v7-core";

export interface V7ChangeSetQueueGuard {
  id: string;
  digest: string;
  state: string;
  claimId?: string;
  claimedAt?: string;
}

interface RestoreV7CheckpointProgress {
  completed: number;
  total: number;
  label: string;
}

export interface RestoreV7CheckpointOptions {
  /**
   * When present, projection replacement is performed only if the complete
   * queue still has exactly these rows.  The comparison happens in the same
   * read-write transaction as the replacement, so a new local edit either
   * wins before the restore (causing a safe no-op) or commits after it.
   */
  queueGuard?: readonly V7ChangeSetQueueGuard[];
  /** Clear the queue as part of the guarded projection replacement. */
  clearChangeSets?: boolean;
  /** Fine-grained local write progress used by the sync UI on slower phones. */
  onProgress?: (progress: RestoreV7CheckpointProgress) => void;
}

const RESTORE_BATCH_SIZE = 400;
const RESTORE_STALL_TIMEOUT_MS = 30_000;

function queueRow(record: V7ChangeSetQueueGuard): string {
  return JSON.stringify([record.id, record.digest, record.state, record.claimId ?? null, record.claimedAt ?? null]);
}

function queueMatches(current: readonly V7ChangeSetQueueGuard[], expected: readonly V7ChangeSetQueueGuard[]): boolean {
  if (current.length !== expected.length) return false;
  const left = current.map(queueRow).sort();
  const right = expected.map(queueRow).sort();
  return left.every((value, index) => value === right[index]);
}

function restoreRowCount(state: V7RestoreState, memberships: V7RestoreState["memberships"]): number {
  return [
    state.banks,
    state.bankFolders,
    state.questions,
    memberships ?? [],
    state.imageAssets,
    state.attempts,
    state.attemptStats,
    state.attemptDailyStats,
    state.notes,
    state.practiceRuns,
    state.practiceRunStats,
    state.questionGroups,
    state.reviewRounds,
    state.reviewRoundProgress,
    state.tombstones,
  ].reduce((total, rows) => total + rows.length, 0);
}

/**
 * Replace every v7 projection atomically.  The `events` store stays dormant
 * (Phase 3) and pending change-sets are deliberately left in place: callers
 * clear `changeSets` separately when a remote tail is being replayed.
 */
export async function restoreV7Checkpoint(state: V7RestoreState, options: RestoreV7CheckpointOptions = {}): Promise<boolean> {
  const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];
  // imageAssets is reconciled in place instead of clear+rewrite.  Cached image
  // Blobs can be large; reading every Blob into JS and writing it back on each
  // ordinary sync was the main iOS/WKWebView write-path pressure point.
  const replaceTables = [
    dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships,
    dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.notes, dbV7.practiceRuns,
    dbV7.practiceRunStats, dbV7.questionGroups, dbV7.reviewRounds, dbV7.reviewRoundProgress,
    dbV7.tombstones,
  ];
  const totalRows = Math.max(1, restoreRowCount(state, memberships));

  return dbV7.transaction("rw", [...replaceTables, dbV7.imageAssets, dbV7.changeSets], async () => {
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
        const current = await dbV7.changeSets.toArray();
        touched();
        if (!queueMatches(current, options.queueGuard)) return false;
      }

      // Clear only projection tables.  imageAssets stays live so its Blob cache
      // does not make a round-trip through JavaScript memory on every sync.
      for (const table of replaceTables) {
        await table.clear();
        touched();
      }

      const existingAssetKeys = await dbV7.imageAssets.toCollection().primaryKeys();
      touched();
      const existingAssetIds = new Set(existingAssetKeys.filter((key): key is string => typeof key === "string"));
      const incomingAssetIds = new Set(state.imageAssets.map((asset) => asset.id));
      const removedAssetIds = [...existingAssetIds].filter((id) => !incomingAssetIds.has(id));
      for (let index = 0; index < removedAssetIds.length; index += RESTORE_BATCH_SIZE) {
        await dbV7.imageAssets.bulkDelete(removedAssetIds.slice(index, index + RESTORE_BATCH_SIZE));
        touched();
      }

      const existingDescriptors = state.imageAssets.filter((asset) => existingAssetIds.has(asset.id));
      await writeChunks(existingDescriptors, (chunk) => dbV7.imageAssets.bulkUpdate(chunk.map((asset) => ({
        key: asset.id,
        changes: {
          mimeType: asset.mimeType,
          size: asset.size,
          width: asset.width,
          height: asset.height,
          remote: asset.remote,
          ...(asset.blob ? { blob: asset.blob } : {}),
        },
      }))), "更新图片索引");
      await writeChunks(state.imageAssets.filter((asset) => !existingAssetIds.has(asset.id)), (chunk) => dbV7.imageAssets.bulkPut(chunk), "写入图片索引");

      await writeChunks(state.banks, (chunk) => dbV7.banks.bulkPut(chunk), "写入题库");
      await writeChunks(state.bankFolders, (chunk) => dbV7.bankFolders.bulkPut(chunk), "写入文件夹");
      await writeChunks(state.questions, (chunk) => dbV7.questions.bulkPut(chunk), "写入题目");
      await writeChunks(memberships, (chunk) => dbV7.bankQuestionMemberships.bulkPut(chunk), "写入题库关系");
      await writeChunks(state.attempts, (chunk) => dbV7.attempts.bulkPut(chunk), "写入作答记录");
      await writeChunks(state.attemptStats, (chunk) => dbV7.attemptStats.bulkPut(chunk), "写入学习统计");
      await writeChunks(state.attemptDailyStats, (chunk) => dbV7.attemptDailyStats.bulkPut(chunk), "写入每日统计");
      await writeChunks(state.notes, (chunk) => dbV7.notes.bulkPut(chunk), "写入解析笔记");
      await writeChunks(state.practiceRuns, (chunk) => dbV7.practiceRuns.bulkPut(chunk), "写入练习记录");
      await writeChunks(state.practiceRunStats, (chunk) => dbV7.practiceRunStats.bulkPut(chunk), "写入练习统计");
      await writeChunks(state.questionGroups, (chunk) => dbV7.questionGroups.bulkPut(chunk), "写入题组");
      await writeChunks(state.reviewRounds, (chunk) => dbV7.reviewRounds.bulkPut(chunk), "写入复习轮次");
      await writeChunks(state.reviewRoundProgress, (chunk) => dbV7.reviewRoundProgress.bulkPut(chunk), "写入轮次进度");
      await writeChunks(state.tombstones, (chunk) => dbV7.tombstones.bulkPut(chunk), "写入删除标记");
      if (options.clearChangeSets) {
        await dbV7.changeSets.clear();
        touched();
      }
      options.onProgress?.({ completed: totalRows, total: totalRows, label: "本机数据库写入完成" });
      return true;
    } catch (error) {
      if (stalled) throw new Error("本机数据库写入长时间无响应，已安全取消本次写入。请保持应用在前台后重试同步。");
      throw error;
    } finally {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
    }
  });
}
