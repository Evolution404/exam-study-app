import Dexie, { type Table } from "dexie";
import { dbV7 } from "./db-v7-core";
import type { V7RestoreState } from "./db-v7-core";
import type { V7ChangeSetQueueGuard } from "./db-v7-restore";

interface ReconcileV7ProjectionProgress {
  completed: number;
  total: number;
  label: string;
}

interface ReconcileV7ProjectionOptions {
  queueGuard?: readonly V7ChangeSetQueueGuard[];
  clearChangeSets?: boolean;
  onProgress?: (progress: ReconcileV7ProjectionProgress) => void;
}

interface ReconcilePlan<T> {
  puts: T[];
  deletes: string[];
}

const RECONCILE_BATCH_SIZE = 150;
const RECONCILE_STALL_TIMEOUT_MS = 30_000;

function queueRow(record: V7ChangeSetQueueGuard): string {
  return JSON.stringify([record.id, record.digest, record.state, record.claimId ?? null, record.claimedAt ?? null]);
}

function queueMatches(current: readonly V7ChangeSetQueueGuard[], expected: readonly V7ChangeSetQueueGuard[]): boolean {
  if (current.length !== expected.length) return false;
  const left = current.map(queueRow).sort();
  const right = expected.map(queueRow).sort();
  return left.every((value, index) => value === right[index]);
}

function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function planTable<T>(table: Table<T, string>, incoming: readonly T[], keyOf: (row: T) => string | undefined): Promise<ReconcilePlan<T>> {
  const current = await table.toArray();
  const currentByKey = new Map<string, T>();
  for (const row of current) {
    const key = keyOf(row);
    if (key === undefined) throw new Error(`本机 ${table.name} 存在缺少主键的记录，无法安全增量同步。`);
    currentByKey.set(key, row);
  }
  const incomingKeys = new Set<string>();
  const puts: T[] = [];

  for (const row of incoming) {
    const key = keyOf(row);
    if (key === undefined) throw new Error(`远端 ${table.name} 存在缺少主键的记录，无法安全增量同步。`);
    incomingKeys.add(key);
    const old = currentByKey.get(key);
    if (old === undefined || !equivalent(old, row)) puts.push(row);
  }

  const deletes = [...currentByKey.keys()].filter((key) => !incomingKeys.has(key));
  return { puts, deletes };
}

async function applyPlan<T>(
  table: Table<T, string>,
  plan: ReconcilePlan<T>,
  labels: { put: string; remove: string },
  progress: (count: number, label: string) => void,
): Promise<void> {
  for (let index = 0; index < plan.deletes.length; index += RECONCILE_BATCH_SIZE) {
    const chunk = plan.deletes.slice(index, index + RECONCILE_BATCH_SIZE);
    await table.bulkDelete(chunk);
    progress(chunk.length, labels.remove);
  }
  for (let index = 0; index < plan.puts.length; index += RECONCILE_BATCH_SIZE) {
    const chunk = plan.puts.slice(index, index + RECONCILE_BATCH_SIZE);
    await table.bulkPut(chunk);
    progress(chunk.length, labels.put);
  }
}

/**
 * Reconcile an already-installed local projection to the exact target state.
 *
 * Planning reads happen before the write transaction so iOS/WKWebView does not
 * hold one giant read-write transaction while comparing thousands of unchanged
 * records. The queue guard is checked atomically immediately before applying
 * the small delta: a local edit that lands during planning changes the queue and
 * makes this attempt return false, so the sync loop retries from a fresh base.
 *
 * Unlike checkpoint restore this path never clears projection stores. Ordinary
 * remote deltas therefore update only changed/deleted rows and avoid the Safari
 * clear + full index rebuild behaviour that made existing-device sync stall.
 */
export async function reconcileV7Projection(
  state: V7RestoreState,
  options: ReconcileV7ProjectionOptions = {},
): Promise<boolean> {
  const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];
  options.onProgress?.({ completed: 0, total: 1, label: "正在比较本机数据" });

  const bankPlan = await planTable(dbV7.banks, state.banks, (row) => row.id);
  const folderPlan = await planTable(dbV7.bankFolders, state.bankFolders, (row) => row.id);
  const questionPlan = await planTable(dbV7.questions, state.questions, (row) => row.id);
  const membershipPlan = await planTable(dbV7.bankQuestionMemberships, memberships, (row) => row.key);
  const attemptPlan = await planTable(dbV7.attempts, state.attempts, (row) => row.id);
  const attemptStatsPlan = await planTable(dbV7.attemptStats, state.attemptStats, (row) => row.questionId);
  const dailyStatsPlan = await planTable(dbV7.attemptDailyStats, state.attemptDailyStats, (row) => row.key);
  const notePlan = await planTable(dbV7.notes, state.notes, (row) => row.questionId);
  const practiceRunPlan = await planTable(dbV7.practiceRuns, state.practiceRuns, (row) => row.id);
  const practiceStatsPlan = await planTable(dbV7.practiceRunStats, state.practiceRunStats, (row) => row.key);
  const groupPlan = await planTable(dbV7.questionGroups, state.questionGroups, (row) => row.id);
  const roundPlan = await planTable(dbV7.reviewRounds, state.reviewRounds, (row) => row.id);
  const roundProgressPlan = await planTable(dbV7.reviewRoundProgress, state.reviewRoundProgress, (row) => row.key);
  const tombstonePlan = await planTable(dbV7.tombstones, state.tombstones, (row) => row.key);

  // Images keep cached Blob bytes. Inspect only keys while planning; descriptor
  // updates below use bulkUpdate and never round-trip every Blob through JS.
  const existingAssetKeys = await dbV7.imageAssets.toCollection().primaryKeys();
  const existingAssetIds = new Set(existingAssetKeys.filter((key): key is string => typeof key === "string"));
  const incomingAssetIds = new Set(state.imageAssets.map((asset) => asset.id));
  const removedAssetIds = [...existingAssetIds].filter((id) => !incomingAssetIds.has(id));
  const existingDescriptors = state.imageAssets.filter((asset) => existingAssetIds.has(asset.id));
  const newDescriptors = state.imageAssets.filter((asset) => !existingAssetIds.has(asset.id));

  const rowOps =
    bankPlan.puts.length + bankPlan.deletes.length
    + folderPlan.puts.length + folderPlan.deletes.length
    + questionPlan.puts.length + questionPlan.deletes.length
    + membershipPlan.puts.length + membershipPlan.deletes.length
    + attemptPlan.puts.length + attemptPlan.deletes.length
    + attemptStatsPlan.puts.length + attemptStatsPlan.deletes.length
    + dailyStatsPlan.puts.length + dailyStatsPlan.deletes.length
    + notePlan.puts.length + notePlan.deletes.length
    + practiceRunPlan.puts.length + practiceRunPlan.deletes.length
    + practiceStatsPlan.puts.length + practiceStatsPlan.deletes.length
    + groupPlan.puts.length + groupPlan.deletes.length
    + roundPlan.puts.length + roundPlan.deletes.length
    + roundProgressPlan.puts.length + roundProgressPlan.deletes.length
    + tombstonePlan.puts.length + tombstonePlan.deletes.length
    + removedAssetIds.length + existingDescriptors.length + newDescriptors.length;
  const totalOps = Math.max(1, rowOps);

  const transactionTables = [
    dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships,
    dbV7.imageAssets, dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats,
    dbV7.notes, dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.questionGroups,
    dbV7.reviewRounds, dbV7.reviewRoundProgress, dbV7.tombstones, dbV7.changeSets,
  ];

  return dbV7.transaction("rw", transactionTables, async () => {
    const transaction = Dexie.currentTransaction;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let completed = 0;

    const armWatchdog = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        try {
          if (transaction?.active) transaction.abort();
        } catch {
          // Transaction may have completed between timer firing and abort().
        }
      }, RECONCILE_STALL_TIMEOUT_MS);
    };
    const progress = (count: number, label: string) => {
      completed = Math.min(totalOps, completed + count);
      options.onProgress?.({ completed, total: totalOps, label });
      armWatchdog();
    };

    armWatchdog();
    try {
      if (options.queueGuard) {
        const current = await dbV7.changeSets.toArray();
        armWatchdog();
        if (!queueMatches(current, options.queueGuard)) return false;
      }

      await applyPlan(dbV7.banks, bankPlan, { put: "更新题库", remove: "清理题库" }, progress);
      await applyPlan(dbV7.bankFolders, folderPlan, { put: "更新文件夹", remove: "清理文件夹" }, progress);
      await applyPlan(dbV7.questions, questionPlan, { put: "更新题目", remove: "清理题目" }, progress);
      await applyPlan(dbV7.bankQuestionMemberships, membershipPlan, { put: "更新题库关系", remove: "清理题库关系" }, progress);
      await applyPlan(dbV7.attempts, attemptPlan, { put: "更新作答记录", remove: "清理作答记录" }, progress);
      await applyPlan(dbV7.attemptStats, attemptStatsPlan, { put: "更新学习统计", remove: "清理学习统计" }, progress);
      await applyPlan(dbV7.attemptDailyStats, dailyStatsPlan, { put: "更新每日统计", remove: "清理每日统计" }, progress);
      await applyPlan(dbV7.notes, notePlan, { put: "更新解析笔记", remove: "清理解析笔记" }, progress);
      await applyPlan(dbV7.practiceRuns, practiceRunPlan, { put: "更新练习记录", remove: "清理练习记录" }, progress);
      await applyPlan(dbV7.practiceRunStats, practiceStatsPlan, { put: "更新练习统计", remove: "清理练习统计" }, progress);
      await applyPlan(dbV7.questionGroups, groupPlan, { put: "更新题组", remove: "清理题组" }, progress);
      await applyPlan(dbV7.reviewRounds, roundPlan, { put: "更新复习轮次", remove: "清理复习轮次" }, progress);
      await applyPlan(dbV7.reviewRoundProgress, roundProgressPlan, { put: "更新轮次进度", remove: "清理轮次进度" }, progress);
      await applyPlan(dbV7.tombstones, tombstonePlan, { put: "更新删除标记", remove: "清理删除标记" }, progress);

      for (let index = 0; index < removedAssetIds.length; index += RECONCILE_BATCH_SIZE) {
        const chunk = removedAssetIds.slice(index, index + RECONCILE_BATCH_SIZE);
        await dbV7.imageAssets.bulkDelete(chunk);
        progress(chunk.length, "清理图片索引");
      }
      for (let index = 0; index < existingDescriptors.length; index += RECONCILE_BATCH_SIZE) {
        const chunk = existingDescriptors.slice(index, index + RECONCILE_BATCH_SIZE);
        await dbV7.imageAssets.bulkUpdate(chunk.map((asset) => ({
          key: asset.id,
          changes: {
            mimeType: asset.mimeType,
            size: asset.size,
            width: asset.width,
            height: asset.height,
            remote: asset.remote,
            ...(asset.blob ? { blob: asset.blob } : {}),
          },
        })));
        progress(chunk.length, "更新图片索引");
      }
      for (let index = 0; index < newDescriptors.length; index += RECONCILE_BATCH_SIZE) {
        const chunk = newDescriptors.slice(index, index + RECONCILE_BATCH_SIZE);
        await dbV7.imageAssets.bulkPut(chunk);
        progress(chunk.length, "写入图片索引");
      }

      if (options.clearChangeSets) {
        await dbV7.changeSets.clear();
        armWatchdog();
      }
      options.onProgress?.({ completed: totalOps, total: totalOps, label: rowOps ? "本机增量更新完成" : "本机数据无需改写" });
      return true;
    } catch (error) {
      if (stalled) throw new Error("本机数据库增量更新长时间无响应，已安全取消本次写入。请保持应用在前台后重试同步。");
      throw error;
    } finally {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
    }
  });
}
