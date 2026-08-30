import Dexie, { type Table } from "dexie";
import { dbV7 } from "./db-v7-core";
import type { V7RestoreState } from "./db-v7-core";
import type { V7ChangeSetQueueGuard } from "./db-v7-restore";

interface ReconcileV7ProjectionProgress {
  completed: number;
  total: number;
  label: string;
}

type ReconcileV7InstallMode = "full" | "fresh";

interface ReconcileV7Timing {
  phase: "plan" | "write";
  table: string;
  durationMs: number;
  scannedRows: number;
  comparedRows: number;
  putRows: number;
  deleteRows: number;
  mode: ReconcileV7InstallMode;
}

interface ReconcileV7ProjectionOptions {
  queueGuard?: readonly V7ChangeSetQueueGuard[];
  clearChangeSets?: boolean;
  onProgress?: (progress: ReconcileV7ProjectionProgress) => void;
  onTiming?: (timing: ReconcileV7Timing) => void;
}

interface ReconcilePlan<T> {
  puts: T[];
  deletes: string[];
  scannedRows: number;
  comparedRows: number;
}

interface ImageReconcilePlan {
  updates: V7RestoreState["imageAssets"];
  inserts: V7RestoreState["imageAssets"];
  deletes: string[];
  scannedRows: number;
  comparedRows: number;
}

const RECONCILE_BATCH_SIZE = 150;
const RECONCILE_PLAN_READ_BATCH_SIZE = 500;
const RECONCILE_STALL_TIMEOUT_MS = 30_000;

function clockMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function emitTiming(
  options: ReconcileV7ProjectionOptions,
  mode: ReconcileV7InstallMode,
  timing: Omit<ReconcileV7Timing, "mode">,
): void {
  options.onTiming?.({ ...timing, mode });
}

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
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!equivalent(left[index], right[index])) return false;
    }
    return true;
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key) || !equivalent(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

async function projectionIsEmpty(): Promise<boolean> {
  const counts = await Promise.all([
    dbV7.banks.count(), dbV7.bankFolders.count(), dbV7.questions.count(), dbV7.bankQuestionMemberships.count(),
    dbV7.imageAssets.count(), dbV7.attempts.count(), dbV7.attemptStats.count(), dbV7.attemptDailyStats.count(),
    dbV7.notes.count(), dbV7.practiceRuns.count(), dbV7.practiceRunStats.count(), dbV7.questionGroups.count(),
    dbV7.reviewRounds.count(), dbV7.reviewRoundProgress.count(), dbV7.tombstones.count(),
  ]);
  return counts.every((count) => count === 0);
}

function freshPlan<T>(incoming: readonly T[], keyOf: (row: T) => string | undefined, tableName: string): ReconcilePlan<T> {
  const keys = new Set<string>();
  const puts = incoming.map((row) => {
    const key = keyOf(row);
    if (key === undefined) throw new Error(`远端 ${tableName} 存在缺少主键的记录，无法安全首次安装。`);
    if (keys.has(key)) throw new Error(`远端 ${tableName} 存在重复主键 ${key}，无法安全首次安装。`);
    keys.add(key);
    return row;
  });
  return { puts, deletes: [], scannedRows: 0, comparedRows: 0 };
}

function freshPlanTimed<T>(
  table: Table<T, string>,
  incoming: readonly T[],
  keyOf: (row: T) => string | undefined,
  options: ReconcileV7ProjectionOptions,
): ReconcilePlan<T> {
  const started = clockMs();
  const plan = freshPlan(incoming, keyOf, table.name);
  emitTiming(options, "fresh", {
    phase: "plan",
    table: table.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: 0,
    comparedRows: 0,
    putRows: plan.puts.length,
    deleteRows: 0,
  });
  return plan;
}

async function planTable<T>(
  table: Table<T, string>,
  incoming: readonly T[],
  keyOf: (row: T) => string | undefined,
): Promise<ReconcilePlan<T>> {
  const rawCurrentKeys = await table.toCollection().primaryKeys();
  const currentKeys = rawCurrentKeys.map((key) => {
    if (typeof key !== "string") throw new Error(`本机 ${table.name} 存在非字符串主键，无法安全增量同步。`);
    return key;
  });
  const incomingKeys = new Set<string>();
  const puts: T[] = [];

  for (let index = 0; index < incoming.length; index += RECONCILE_PLAN_READ_BATCH_SIZE) {
    const rows = incoming.slice(index, index + RECONCILE_PLAN_READ_BATCH_SIZE);
    const keys = rows.map((row) => {
      const key = keyOf(row);
      if (key === undefined) throw new Error(`远端 ${table.name} 存在缺少主键的记录，无法安全增量同步。`);
      if (incomingKeys.has(key)) throw new Error(`远端 ${table.name} 存在重复主键 ${key}，无法安全增量同步。`);
      incomingKeys.add(key);
      return key;
    });
    const current = await table.bulkGet(keys);
    for (let offset = 0; offset < rows.length; offset += 1) {
      const old = current[offset];
      if (old === undefined || !equivalent(old, rows[offset])) puts.push(rows[offset]);
    }
  }

  const deletes = currentKeys.filter((key) => !incomingKeys.has(key));
  return {
    puts,
    deletes,
    scannedRows: currentKeys.length + incoming.length,
    comparedRows: incoming.length,
  };
}

async function planTableTimed<T>(
  table: Table<T, string>,
  incoming: readonly T[],
  keyOf: (row: T) => string | undefined,
  options: ReconcileV7ProjectionOptions,
): Promise<ReconcilePlan<T>> {
  const started = clockMs();
  const plan = await planTable(table, incoming, keyOf);
  emitTiming(options, "full", {
    phase: "plan",
    table: table.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: plan.scannedRows,
    comparedRows: plan.comparedRows,
    putRows: plan.puts.length,
    deleteRows: plan.deletes.length,
  });
  return plan;
}

function canonicalImageDescriptor(asset: {
  id: string; mimeType: string; size: number; width: number; height: number;
}): Record<string, unknown> {
  return { id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height };
}

function freshImagePlan(incoming: V7RestoreState["imageAssets"]): ImageReconcilePlan {
  const ids = new Set<string>();
  for (const asset of incoming) {
    if (ids.has(asset.id)) throw new Error(`远端 imageAssets 存在重复主键 ${asset.id}，无法安全首次安装。`);
    ids.add(asset.id);
  }
  return { updates: [], inserts: [...incoming], deletes: [], scannedRows: 0, comparedRows: 0 };
}

function freshImagePlanTimed(
  incoming: V7RestoreState["imageAssets"],
  options: ReconcileV7ProjectionOptions,
): ImageReconcilePlan {
  const started = clockMs();
  const plan = freshImagePlan(incoming);
  emitTiming(options, "fresh", {
    phase: "plan",
    table: dbV7.imageAssets.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: 0,
    comparedRows: 0,
    putRows: plan.inserts.length,
    deleteRows: 0,
  });
  return plan;
}

async function planImageAssets(incoming: V7RestoreState["imageAssets"]): Promise<ImageReconcilePlan> {
  const rawCurrentKeys = await dbV7.imageAssets.toCollection().primaryKeys();
  const currentKeys = rawCurrentKeys.map((key) => {
    if (typeof key !== "string") throw new Error("本机 imageAssets 存在非字符串主键，无法安全增量同步。");
    return key;
  });
  const currentIds = new Set(currentKeys);
  const incomingIds = new Set<string>();
  const updates: V7RestoreState["imageAssets"] = [];
  const inserts: V7RestoreState["imageAssets"] = [];
  const existing: V7RestoreState["imageAssets"] = [];

  for (const asset of incoming) {
    if (incomingIds.has(asset.id)) throw new Error(`远端 imageAssets 存在重复主键 ${asset.id}，无法安全增量同步。`);
    incomingIds.add(asset.id);
    if (currentIds.has(asset.id)) existing.push(asset);
    else inserts.push(asset);
  }

  for (let index = 0; index < existing.length; index += RECONCILE_PLAN_READ_BATCH_SIZE) {
    const rows = existing.slice(index, index + RECONCILE_PLAN_READ_BATCH_SIZE);
    const current = await dbV7.imageAssets.bulkGet(rows.map((asset) => asset.id));
    for (let offset = 0; offset < rows.length; offset += 1) {
      const old = current[offset];
      if (!old) inserts.push(rows[offset]);
      else if (!equivalent(canonicalImageDescriptor(old), canonicalImageDescriptor(rows[offset]))) updates.push(rows[offset]);
    }
  }

  return {
    updates,
    inserts,
    deletes: currentKeys.filter((id) => !incomingIds.has(id)),
    scannedRows: currentKeys.length + existing.length,
    comparedRows: existing.length,
  };
}

async function planImageAssetsTimed(
  incoming: V7RestoreState["imageAssets"],
  options: ReconcileV7ProjectionOptions,
): Promise<ImageReconcilePlan> {
  const started = clockMs();
  const plan = await planImageAssets(incoming);
  emitTiming(options, "full", {
    phase: "plan",
    table: dbV7.imageAssets.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: plan.scannedRows,
    comparedRows: plan.comparedRows,
    putRows: plan.inserts.length + plan.updates.length,
    deleteRows: plan.deletes.length,
  });
  return plan;
}

async function applyPlan<T>(
  table: Table<T, string>,
  plan: ReconcilePlan<T>,
  labels: { put: string; remove: string },
  progress: (count: number, label: string) => void,
  options: ReconcileV7ProjectionOptions,
  mode: ReconcileV7InstallMode,
): Promise<void> {
  const started = clockMs();
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
  emitTiming(options, mode, {
    phase: "write",
    table: table.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: 0,
    comparedRows: 0,
    putRows: plan.puts.length,
    deleteRows: plan.deletes.length,
  });
}

export async function reconcileV7Projection(
  state: V7RestoreState,
  options: ReconcileV7ProjectionOptions = {},
): Promise<boolean> {
  const memberships = state.memberships;
  const mode: ReconcileV7InstallMode = await projectionIsEmpty() ? "fresh" : "full";
  options.onProgress?.({ completed: 0, total: 1, label: mode === "fresh" ? "正在准备首次本机数据" : "正在比较本机数据" });

  const makePlan = <T>(table: Table<T, string>, incoming: readonly T[], keyOf: (row: T) => string | undefined) => mode === "fresh"
    ? Promise.resolve(freshPlanTimed(table, incoming, keyOf, options))
    : planTableTimed(table, incoming, keyOf, options);

  const bankPlan = await makePlan(dbV7.banks, state.banks, (row) => row.id);
  const folderPlan = await makePlan(dbV7.bankFolders, state.bankFolders, (row) => row.id);
  const questionPlan = await makePlan(dbV7.questions, state.questions, (row) => row.id);
  const membershipPlan = await makePlan(dbV7.bankQuestionMemberships, memberships, (row) => row.key);
  const attemptPlan = await makePlan(dbV7.attempts, state.attempts, (row) => row.id);
  const attemptStatsPlan = await makePlan(dbV7.attemptStats, state.attemptStats, (row) => row.questionId);
  const dailyStatsPlan = await makePlan(dbV7.attemptDailyStats, state.attemptDailyStats, (row) => row.key);
  const notePlan = await makePlan(dbV7.notes, state.notes, (row) => row.questionId);
  const practiceRunPlan = await makePlan(dbV7.practiceRuns, state.practiceRuns, (row) => row.id);
  const practiceStatsPlan = await makePlan(dbV7.practiceRunStats, state.practiceRunStats, (row) => row.key);
  const groupPlan = await makePlan(dbV7.questionGroups, state.questionGroups, (row) => row.id);
  const roundPlan = await makePlan(dbV7.reviewRounds, state.reviewRounds, (row) => row.id);
  const roundProgressPlan = await makePlan(dbV7.reviewRoundProgress, state.reviewRoundProgress, (row) => row.key);
  const tombstonePlan = await makePlan(dbV7.tombstones, state.tombstones, (row) => row.key);
  const imagePlan = mode === "fresh" ? freshImagePlanTimed(state.imageAssets, options) : await planImageAssetsTimed(state.imageAssets, options);

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
    + imagePlan.deletes.length + imagePlan.updates.length + imagePlan.inserts.length;
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
      // The out-of-transaction empty check only selects the fast path. Recheck
      // under the same rw transaction as the writes so a local edit/cache write
      // that landed during planning cannot be overwritten by a blind fresh put.
      if (mode === "fresh" && !await projectionIsEmpty()) return false;

      await applyPlan(dbV7.banks, bankPlan, { put: "更新题库", remove: "清理题库" }, progress, options, mode);
      await applyPlan(dbV7.bankFolders, folderPlan, { put: "更新文件夹", remove: "清理文件夹" }, progress, options, mode);
      await applyPlan(dbV7.questions, questionPlan, { put: "更新题目", remove: "清理题目" }, progress, options, mode);
      await applyPlan(dbV7.bankQuestionMemberships, membershipPlan, { put: "更新题库关系", remove: "清理题库关系" }, progress, options, mode);
      await applyPlan(dbV7.attempts, attemptPlan, { put: "更新作答记录", remove: "清理作答记录" }, progress, options, mode);
      await applyPlan(dbV7.attemptStats, attemptStatsPlan, { put: "更新学习统计", remove: "清理学习统计" }, progress, options, mode);
      await applyPlan(dbV7.attemptDailyStats, dailyStatsPlan, { put: "更新每日统计", remove: "清理每日统计" }, progress, options, mode);
      await applyPlan(dbV7.notes, notePlan, { put: "更新解析笔记", remove: "清理解析笔记" }, progress, options, mode);
      await applyPlan(dbV7.practiceRuns, practiceRunPlan, { put: "更新练习记录", remove: "清理练习记录" }, progress, options, mode);
      await applyPlan(dbV7.practiceRunStats, practiceStatsPlan, { put: "更新练习统计", remove: "清理练习统计" }, progress, options, mode);
      await applyPlan(dbV7.questionGroups, groupPlan, { put: "更新题组", remove: "清理题组" }, progress, options, mode);
      await applyPlan(dbV7.reviewRounds, roundPlan, { put: "更新复习轮次", remove: "清理复习轮次" }, progress, options, mode);
      await applyPlan(dbV7.reviewRoundProgress, roundProgressPlan, { put: "更新轮次进度", remove: "清理轮次进度" }, progress, options, mode);
      await applyPlan(dbV7.tombstones, tombstonePlan, { put: "更新删除标记", remove: "清理删除标记" }, progress, options, mode);

      const imageWriteStarted = clockMs();
      for (let index = 0; index < imagePlan.deletes.length; index += RECONCILE_BATCH_SIZE) {
        const chunk = imagePlan.deletes.slice(index, index + RECONCILE_BATCH_SIZE);
        await dbV7.imageAssets.bulkDelete(chunk);
        progress(chunk.length, "清理图片索引");
      }
      for (let index = 0; index < imagePlan.updates.length; index += RECONCILE_BATCH_SIZE) {
        const chunk = imagePlan.updates.slice(index, index + RECONCILE_BATCH_SIZE);
        await dbV7.imageAssets.bulkUpdate(chunk.map((asset) => ({
          key: asset.id,
          changes: {
            mimeType: asset.mimeType,
            size: asset.size,
            width: asset.width,
            height: asset.height,
          },
        })));
        progress(chunk.length, "更新图片索引");
      }
      for (let index = 0; index < imagePlan.inserts.length; index += RECONCILE_BATCH_SIZE) {
        const chunk = imagePlan.inserts.slice(index, index + RECONCILE_BATCH_SIZE);
        await dbV7.imageAssets.bulkPut(chunk);
        progress(chunk.length, "写入图片索引");
      }
      emitTiming(options, mode, {
        phase: "write",
        table: dbV7.imageAssets.name,
        durationMs: Math.max(0, clockMs() - imageWriteStarted),
        scannedRows: 0,
        comparedRows: 0,
        putRows: imagePlan.inserts.length + imagePlan.updates.length,
        deleteRows: imagePlan.deletes.length,
      });

      if (options.clearChangeSets) {
        await dbV7.changeSets.clear();
        armWatchdog();
      }
      options.onProgress?.({
        completed: totalOps,
        total: totalOps,
        label: rowOps ? (mode === "fresh" ? "首次本机数据写入完成" : "本机增量更新完成") : "本机数据无需改写",
      });
      return true;
    } catch (error) {
      if (stalled) throw new Error("本机数据库增量更新长时间无响应，已安全取消本次写入。请保持应用在前台后重试同步。");
      throw error;
    } finally {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
    }
  });
}
