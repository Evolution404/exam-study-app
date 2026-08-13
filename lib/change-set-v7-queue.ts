import { createChangeSetV7, dependentChangeSetIdsV7, type ChangeSetMutationV7 } from "./change-set-v7";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import { dbV6, restoreV6CheckpointAndEvents, type ChangeSetQueueRecordV7 } from "./db-v6";

async function queueBase(): Promise<ChangeSetProjectionV7> {
  const base = (await dbV6.syncMeta.get("v7:queue-base"))?.value as ChangeSetProjectionV7 | undefined;
  if (!base) throw new Error("请先完成一次 v7 同步，建立可审查的队列基线后再修改事件。");
  return structuredClone(base);
}

export async function ensureChangeSetQueueBaseV7(): Promise<void> {
  if (await dbV6.syncMeta.get("v7:queue-base")) return;
  if (await dbV6.changeSets.count()) return;
  const [banks, bankFolders, questions, memberships, imageAssets, attempts, attemptStats, attemptDailyStats, notes, practiceRuns, practiceRunStats, questionGroups, reviewRounds, reviewRoundProgress, tombstones] = await Promise.all([
    dbV6.banks.toArray(), dbV6.bankFolders.toArray(), dbV6.questions.toArray(), dbV6.bankQuestionMemberships.toArray(),
    dbV6.imageAssets.toArray(), dbV6.attempts.toArray(), dbV6.attemptStats.toArray(), dbV6.attemptDailyStats.toArray(),
    dbV6.notes.toArray(), dbV6.practiceRuns.toArray(), dbV6.practiceRunStats.toArray(), dbV6.questionGroups.toArray(),
    dbV6.reviewRounds.toArray(), dbV6.reviewRoundProgress.toArray(), dbV6.tombstones.toArray(),
  ]);
  const projection: ChangeSetProjectionV7 = {
    banks, bankFolders, questions, memberships,
    imageAssets: imageAssets.map((asset) => ({ id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height, remote: asset.remote })),
    attempts, attemptStats, attemptDailyStats, notes, practiceRuns, practiceRunStats,
    questionGroups, reviewRounds, reviewRoundProgress, tombstones,
  };
  await dbV6.syncMeta.put({ key: "v7:queue-base", value: projection, updatedAt: new Date().toISOString() });
}

async function pendingInOrder(): Promise<ChangeSetQueueRecordV7[]> {
  return (await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).toArray())
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
}

async function rebuild(records: readonly ChangeSetQueueRecordV7[]): Promise<ChangeSetProjectionV7> {
  let projection = await queueBase();
  for (const record of records) {
    if (record.state === "blocked") continue;
    projection = reduceChangeSetV7(projection, record);
  }
  return projection;
}

async function install(projection: ChangeSetProjectionV7): Promise<void> {
  await restoreV6CheckpointAndEvents({ ...projection, memberships: projection.memberships }, [], { preservePending: false });
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
  await dbV6.changeSets.bulkDelete([...removedIds]);
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
  await dbV6.changeSets.put(stored);
  return stored;
}
