import { type ChangeSetMutation } from "./change-set-types";
import { createChangeSet } from "./change-set-codec";
import { dependentChangeSetIds } from "./change-set-planning";
import { replayChangeSetBatch, type ChangeSetProjection } from "./change-set-projection";
import { canonicalStateFromProjection } from "./sync-checkpoint-bridge";
import { studyDb, restoreLocalCheckpoint, type ChangeSetQueueRecord } from "../db/db";
import { assemblePracticeRunRecords } from "../db/practice-run-store";

async function queueBase(): Promise<ChangeSetProjection> {
  const base = (await studyDb.syncMeta.get("sync:queue-base"))?.value as ChangeSetProjection | undefined;
  if (!base) throw new Error("请先完成一次同步，建立可审查的队列基线后再修改事件。");
  return structuredClone(base);
}

export async function ensureChangeSetQueueBase(): Promise<void> {
  if (await studyDb.syncMeta.get("sync:queue-base")) return;
  if (await studyDb.changeSets.count()) return;
  const [banks, bankFolders, questions, memberships, imageAssets, attempts, attemptStats, attemptDailyStats, notes, practiceRunRecords, practiceRunSources, practiceRunItems, practiceRunStats, questionGroupRecords, questionGroupItems, reviewRoundRecords, reviewRoundBanks, reviewRoundItems, reviewRoundProgress, tombstones] = await Promise.all([
    studyDb.banks.toArray(), studyDb.bankFolders.toArray(), studyDb.questions.toArray(), studyDb.bankQuestionMemberships.toArray(),
    studyDb.imageAssets.toArray(), studyDb.attempts.toArray(), studyDb.questionProgress.toArray(), studyDb.questionDailyProgress.toArray(),
    studyDb.notes.toArray(), studyDb.practiceRuns.toArray(), studyDb.practiceRunSources.toArray(), studyDb.practiceRunItems.toArray(), studyDb.bankPracticeStats.toArray(), studyDb.questionGroups.toArray(), studyDb.questionGroupItems.toArray(),
    studyDb.reviewRounds.toArray(), studyDb.reviewRoundBanks.toArray(), studyDb.reviewRoundItems.toArray(), studyDb.reviewRoundProgress.toArray(), studyDb.tombstones.toArray(),
  ]);
  const practiceRuns = assemblePracticeRunRecords(practiceRunRecords, practiceRunSources, practiceRunItems, attempts);
  const projection: ChangeSetProjection = {
    banks, bankFolders, questions, memberships,
    imageAssets: imageAssets.map((asset) => ({ id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height })),
    attempts, attemptStats, attemptDailyStats, notes, practiceRuns,
    practiceRunStats: practiceRunStats.map((stats) => ({
      key: stats.bankId,
      bankId: stats.bankId,
      total: stats.total,
      completed: stats.completed,
      inProgress: stats.inProgress,
      abandoned: stats.abandoned,
      latestUpdatedAt: stats.latestActivityAt,
    })),
    questionGroups: questionGroupRecords.map((group) => ({
      ...group,
      items: questionGroupItems
        .filter((item) => item.groupId === group.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => ({ questionId: item.questionId, note: item.note ?? "" })),
    })),
    reviewRounds: reviewRoundRecords.map((round) => {
      const finalQuestionIds = reviewRoundItems
        .filter((item) => item.roundId === round.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => item.questionId);
      return {
        ...round,
        bankIds: reviewRoundBanks
          .filter((bank) => bank.roundId === round.id)
          .sort((left, right) => left.position - right.position)
          .map((bank) => bank.bankId),
        ...(finalQuestionIds.length ? { finalQuestionIds } : {}),
      };
    }),
    reviewRoundProgress, tombstones,
  };
  await studyDb.syncMeta.put({ key: "sync:queue-base", value: projection, updatedAt: new Date().toISOString() });
}

async function pendingInOrder(): Promise<ChangeSetQueueRecord[]> {
  return (await studyDb.changeSets.where("state").anyOf(["pending", "blocked"]).toArray())
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
}

async function rebuild(records: readonly ChangeSetQueueRecord[]): Promise<ChangeSetProjection> {
  // Strict batch replay: any failing record must throw (user-facing queue
  // surgery relies on rebuild failing loudly), but derived tables recompute once.
  const applicable = records.filter((record) => record.state !== "blocked");
  return replayChangeSetBatch(await queueBase(), applicable, undefined, { onConflict: "throw" }).projection;
}

async function install(projection: ChangeSetProjection): Promise<void> {
  await restoreLocalCheckpoint(canonicalStateFromProjection(projection));
}

export async function discardManagedChangeSet(id: string, options: { cascadeDependents?: boolean } = {}): Promise<void> {
  const records = await pendingInOrder();
  const target = records.find((record) => record.id === id);
  if (!target || (target.state !== "pending" && target.state !== "blocked")) throw new Error("该变更已锁定或不存在，不能删除。");
  const dependentIds = dependentChangeSetIds(target, records);
  if (dependentIds.length && !options.cascadeDependents) throw new Error(`还有 ${dependentIds.length} 组操作依赖该变更，请选择同时删除。`);
  const removedIds = new Set([id, ...(options.cascadeDependents ? dependentIds : [])]);
  const projection = await rebuild(records.filter((record) => !removedIds.has(record.id)));
  await install(projection);
  await studyDb.changeSets.bulkDelete([...removedIds]);
}

export async function reviseManagedChangeSet(id: string, mutations: readonly ChangeSetMutation[]): Promise<ChangeSetQueueRecord> {
  const records = await pendingInOrder();
  const target = records.find((record) => record.id === id);
  if (!target || (target.state !== "pending" && target.state !== "blocked")) throw new Error("该变更已锁定或不存在，不能修改。");
  const revised = await createChangeSet({ id: target.id, deviceId: target.deviceId, localSequence: target.localSequence, createdAt: target.createdAt, mutations });
  const next = records.map((record) => record.id === id ? { ...revised, state: "pending" as const } : record);
  const projection = await rebuild(next);
  await install(projection);
  const stored: ChangeSetQueueRecord = { ...revised, state: "pending" };
  await studyDb.changeSets.put(stored);
  return stored;
}
