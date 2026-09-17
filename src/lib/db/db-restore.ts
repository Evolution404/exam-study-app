/**
 * Atomic checkpoint restore.
 */
import Dexie from "dexie";
import { studyDb } from "./db-core";
import type { RestoreState } from "./db-core";
import { decomposePracticeRun } from "./practice-run-store";

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
   * When present, projection replacement is performed only if the complete
   * queue still has exactly these rows.  The comparison happens in the same
   * read-write transaction as the replacement, so a new local edit either
   * wins before the restore (causing a safe no-op) or commits after it.
   */
  queueGuard?: readonly ChangeSetQueueGuard[];
  /** Clear the queue as part of the guarded projection replacement. */
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
 * Replace every projection atomically. The `events` store stays dormant
 * (Phase 3) and pending change-sets are deliberately left in place: callers
 * clear `changeSets` separately when a remote tail is being replayed.
 */
export async function restoreLocalCheckpoint(state: RestoreState, options: RestoreLocalCheckpointOptions = {}): Promise<boolean> {
  const practiceRunBundles = state.practiceRuns.map((run) => decomposePracticeRun(run, state.attempts));
  // imageAssets is reconciled in place instead of clear+rewrite. imageBlobs is
  // a local-only cache and is never installed from checkpoint state.
  const replaceTables = [
    studyDb.banks, studyDb.bankFolders, studyDb.questions, studyDb.bankQuestionMemberships,
    studyDb.attempts, studyDb.questionProgress, studyDb.questionDailyProgress, studyDb.notes, studyDb.practiceRuns, studyDb.practiceRunSources, studyDb.practiceRunItems,
    studyDb.bankPracticeStats, studyDb.questionGroups, studyDb.questionGroupItems, studyDb.reviewRounds, studyDb.reviewRoundBanks, studyDb.reviewRoundItems, studyDb.reviewRoundProgress,
    studyDb.tombstones,
  ];
  const totalRows = Math.max(1, restoreRowCount(state));

  return studyDb.transaction("rw", [...replaceTables, studyDb.imageAssets, studyDb.imageBlobs, studyDb.changeSets], async () => {
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

      // Clear replaceable canonical/projection tables. imageAssets is reconciled
      // separately and imageBlobs stays local so cached bytes never round-trip
      // through checkpoint JSON or JavaScript memory on ordinary sync.
      for (const table of replaceTables) {
        await table.clear();
        touched();
      }

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
      await writeChunks(state.attemptStats, (chunk) => studyDb.questionProgress.bulkPut(chunk), "写入学习统计");
      await writeChunks(state.attemptDailyStats, (chunk) => studyDb.questionDailyProgress.bulkPut(chunk), "写入每日统计");
      await writeChunks(state.notes, (chunk) => studyDb.notes.bulkPut(chunk), "写入解析笔记");
      await writeChunks(practiceRunBundles.map((bundle) => bundle.record), (chunk) => studyDb.practiceRuns.bulkPut(chunk), "写入练习记录");
      await writeChunks(practiceRunBundles.flatMap((bundle) => bundle.sources), (chunk) => studyDb.practiceRunSources.bulkPut(chunk), "写入练习来源关系");
      await writeChunks(practiceRunBundles.flatMap((bundle) => bundle.items), (chunk) => studyDb.practiceRunItems.bulkPut(chunk), "写入练习题目关系");
      await writeChunks(state.practiceRunStats, (chunk) => studyDb.bankPracticeStats.bulkPut(chunk.map((stats) => ({
        bankId: stats.bankId,
        total: stats.total,
        completed: stats.completed,
        inProgress: stats.inProgress,
        abandoned: stats.abandoned,
        latestActivityAt: stats.latestUpdatedAt,
      }))), "写入练习统计");
      await writeChunks(state.questionGroups.map((group) => ({
        id: group.id,
        name: group.name,
        type: group.type,
        description: group.description,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        deviceId: group.deviceId,
        ...(group.syncEventId !== undefined ? { syncEventId: group.syncEventId } : {}),
      })), (chunk) => studyDb.questionGroups.bulkPut(chunk), "写入题组");
      await writeChunks(state.questionGroups.flatMap((group) => group.items.map((item, position) => ({
        groupId: group.id,
        questionId: item.questionId,
        position,
        ...(item.note ? { note: item.note } : {}),
      }))), (chunk) => studyDb.questionGroupItems.bulkPut(chunk), "写入题组关系");
      await writeChunks(state.reviewRounds.map((round) => ({
        id: round.id,
        name: round.name,
        startedAt: round.startedAt,
        status: round.status,
        createdAt: round.createdAt,
        updatedAt: round.updatedAt,
        deviceId: round.deviceId,
        ...(round.completedAt !== undefined ? { completedAt: round.completedAt } : {}),
      })), (chunk) => studyDb.reviewRounds.bulkPut(chunk), "写入复习轮次");
      await writeChunks(state.reviewRounds.flatMap((round) => round.bankIds.map((bankId, position) => ({
        roundId: round.id,
        bankId,
        position,
      }))), (chunk) => studyDb.reviewRoundBanks.bulkPut(chunk), "写入复习轮次题库关系");
      await writeChunks(state.reviewRounds.flatMap((round) => (round.finalQuestionIds ?? []).map((questionId, position) => ({
        roundId: round.id,
        questionId,
        position,
      }))), (chunk) => studyDb.reviewRoundItems.bulkPut(chunk), "写入复习轮次题目关系");
      await writeChunks(state.reviewRoundProgress, (chunk) => studyDb.reviewRoundProgress.bulkPut(chunk), "写入轮次进度");
      await writeChunks(state.tombstones, (chunk) => studyDb.tombstones.bulkPut(chunk), "写入删除标记");
      if (options.clearChangeSets) {
        await studyDb.changeSets.clear();
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
