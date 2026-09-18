import { type ChangeSetMutation } from "./change-set-types";
import { createChangeSet } from "./change-set-codec";
import { dependentChangeSetIds } from "./change-set-planning";
import { replayChangeSetBatch } from "./change-set-projection";
import { studyDb, restoreLocalCheckpoint, type ChangeSetQueueRecord } from "../db/db";
import type { CanonicalState } from "../db/types";

async function queueBase(): Promise<CanonicalState> {
  const base = (await studyDb.syncMeta.get("sync:queue-base"))?.value as CanonicalState | undefined;
  if (!base) throw new Error("请先完成一次同步，建立可审查的队列基线后再修改事件。");
  return structuredClone(base);
}

export async function ensureChangeSetQueueBase(): Promise<void> {
  if (await studyDb.syncMeta.get("sync:queue-base")) return;
  if (await studyDb.changeSets.count()) return;
  const [
    banks, bankFolders, questions, memberships, imageAssets, attempts, notes,
    practiceRuns, practiceRunSources, practiceRunItems,
    questionGroups, questionGroupItems,
    reviewRounds, reviewRoundBanks, reviewRoundItems, tombstones,
  ] = await Promise.all([
    studyDb.banks.toArray(),
    studyDb.bankFolders.toArray(),
    studyDb.questions.toArray(),
    studyDb.bankQuestionMemberships.toArray(),
    studyDb.imageAssets.toArray(),
    studyDb.attempts.toArray(),
    studyDb.notes.toArray(),
    studyDb.practiceRuns.toArray(),
    studyDb.practiceRunSources.toArray(),
    studyDb.practiceRunItems.toArray(),
    studyDb.questionGroups.toArray(),
    studyDb.questionGroupItems.toArray(),
    studyDb.reviewRounds.toArray(),
    studyDb.reviewRoundBanks.toArray(),
    studyDb.reviewRoundItems.toArray(),
    studyDb.tombstones.toArray(),
  ]);
  const state: CanonicalState = {
    banks,
    bankFolders,
    questions,
    memberships,
    imageAssets,
    attempts,
    notes,
    practiceRuns,
    practiceRunSources,
    practiceRunItems,
    questionGroups,
    questionGroupItems,
    reviewRounds,
    reviewRoundBanks,
    reviewRoundItems,
    tombstones,
  };
  await studyDb.syncMeta.put({ key: "sync:queue-base", value: state, updatedAt: new Date().toISOString() });
}

async function pendingInOrder(): Promise<ChangeSetQueueRecord[]> {
  return (await studyDb.changeSets.where("state").anyOf(["pending", "blocked"]).toArray())
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.deviceId.localeCompare(right.deviceId)
      || left.localSequence - right.localSequence
      || left.id.localeCompare(right.id));
}

async function rebuild(records: readonly ChangeSetQueueRecord[]): Promise<CanonicalState> {
  const applicable = records.filter((record) => record.state !== "blocked");
  return replayChangeSetBatch(await queueBase(), applicable, undefined, { onConflict: "throw" }).state;
}

async function install(state: CanonicalState): Promise<void> {
  await restoreLocalCheckpoint(state);
}

export async function discardManagedChangeSet(id: string, options: { cascadeDependents?: boolean } = {}): Promise<void> {
  const records = await pendingInOrder();
  const target = records.find((record) => record.id === id);
  if (!target || (target.state !== "pending" && target.state !== "blocked")) throw new Error("该变更已锁定或不存在，不能删除。");
  const dependentIds = dependentChangeSetIds(target, records);
  if (dependentIds.length && !options.cascadeDependents) throw new Error(`还有 ${dependentIds.length} 组操作依赖该变更，请选择同时删除。`);
  const removedIds = new Set([id, ...(options.cascadeDependents ? dependentIds : [])]);
  const state = await rebuild(records.filter((record) => !removedIds.has(record.id)));
  await install(state);
  await studyDb.changeSets.bulkDelete([...removedIds]);
}

export async function reviseManagedChangeSet(id: string, mutations: readonly ChangeSetMutation[]): Promise<ChangeSetQueueRecord> {
  const records = await pendingInOrder();
  const target = records.find((record) => record.id === id);
  if (!target || (target.state !== "pending" && target.state !== "blocked")) throw new Error("该变更已锁定或不存在，不能修改。");
  const revised = await createChangeSet({
    id: target.id,
    deviceId: target.deviceId,
    localSequence: target.localSequence,
    createdAt: target.createdAt,
    mutations,
  });
  const next = records.map((record) => record.id === id ? { ...revised, state: "pending" as const } : record);
  const state = await rebuild(next);
  await install(state);
  const stored: ChangeSetQueueRecord = { ...revised, state: "pending" };
  await studyDb.changeSets.put(stored);
  return stored;
}
