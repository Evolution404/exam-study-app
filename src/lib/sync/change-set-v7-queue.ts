import { createChangeSetV7, dependentChangeSetIdsV7, type ChangeSetMutationV7 } from "./change-set-v7";
import { replayChangeSetBatchV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import { dbV7, restoreV7Checkpoint, type ChangeSetQueueRecordV7 } from "../db/db-v7";

async function queueBase(): Promise<ChangeSetProjectionV7> {
  const base = (await dbV7.syncMeta.get("v7:queue-base"))?.value as ChangeSetProjectionV7 | undefined;
  if (!base) throw new Error("请先完成一次 v8 同步，建立可审查的队列基线后再修改事件。");
  return structuredClone(base);
}

export async function ensureChangeSetQueueBaseV7(): Promise<void> {
  if (await dbV7.syncMeta.get("v7:queue-base")) return;
  if (await dbV7.changeSets.count()) return;
  const [banks, bankFolders, questions, memberships, imageAssets, attempts, attemptStats, attemptDailyStats, notes, practiceRuns, practiceRunStats, questionGroups, reviewRounds, reviewRoundProgress, tombstones] = await Promise.all([
    dbV7.banks.toArray(), dbV7.bankFolders.toArray(), dbV7.questions.toArray(), dbV7.bankQuestionMemberships.toArray(),
    dbV7.imageAssets.toArray(), dbV7.attempts.toArray(), dbV7.attemptStats.toArray(), dbV7.attemptDailyStats.toArray(),
    dbV7.notes.toArray(), dbV7.practiceRuns.toArray(), dbV7.practiceRunStats.toArray(), dbV7.questionGroups.toArray(),
    dbV7.reviewRounds.toArray(), dbV7.reviewRoundProgress.toArray(), dbV7.tombstones.toArray(),
  ]);
  const projection: ChangeSetProjectionV7 = {
    banks, bankFolders, questions, memberships,
    imageAssets: imageAssets.map((asset) => ({ id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height, remote: asset.remote })),
    attempts, attemptStats, attemptDailyStats, notes, practiceRuns, practiceRunStats,
    questionGroups, reviewRounds, reviewRoundProgress, tombstones,
  };
  await dbV7.syncMeta.put({ key: "v7:queue-base", value: projection, updatedAt: new Date().toISOString() });
}

async function pendingInOrder(): Promise<ChangeSetQueueRecordV7[]> {
  return (await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).toArray())
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
}

async function rebuild(records: readonly ChangeSetQueueRecordV7[]): Promise<ChangeSetProjectionV7> {
  // Strict batch replay: any failing record must throw (user-facing queue
  // surgery relies on rebuild failing loudly), but derived tables recompute once.
  const applicable = records.filter((record) => record.state !== "blocked");
  return replayChangeSetBatchV7(await queueBase(), applicable, undefined, { onConflict: "throw" }).projection;
}

async function install(projection: ChangeSetProjectionV7): Promise<void> {
  await restoreV7Checkpoint({ ...projection, memberships: projection.memberships });
}

export async function discardManagedChangeSetV7(id: string, options: { cascadeDependents?: boolean } = {}): Promise<void> {
  const records = await pendingInOrder();
  const target = records.find((record) => record.id === id);
  if (!target || (target.state !== "pending" && target.state !== "blocked")) throw new Error("该变更已锁定或不存在，不能删除。");
  const dependentIds = dependentChangeSetIdsV7(target, records);
  if (dependentIds.length && !options.cascadeDependents) throw new Error(`还有 ${dependentIds.length} 组操作依赖该变更，请选择同时删除。`);
  const removedIds = new Set([id, ...(options.cascadeDependents ? dependentIds : [])]);
  const projection = await rebuild(records.filter((record) => !removedIds.has(record.id)));
  await install(projection);
  await dbV7.changeSets.bulkDelete([...removedIds]);
}

export async function reviseManagedChangeSetV7(id: string, mutations: readonly ChangeSetMutationV7[]): Promise<ChangeSetQueueRecordV7> {
  const records = await pendingInOrder();
  const target = records.find((record) => record.id === id);
  if (!target || (target.state !== "pending" && target.state !== "blocked")) throw new Error("该变更已锁定或不存在，不能修改。");
  const revised = await createChangeSetV7({ id: target.id, deviceId: target.deviceId, localSequence: target.localSequence, createdAt: target.createdAt, mutations });
  const next = records.map((record) => record.id === id ? { ...revised, state: "pending" as const } : record);
  const projection = await rebuild(next);
  await install(projection);
  const stored: ChangeSetQueueRecordV7 = { ...revised, state: "pending" };
  await dbV7.changeSets.put(stored);
  return stored;
}
