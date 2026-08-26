/** Global question deletion and cascade cleanup. */
import {
  dbV7,
  getV7DeviceId,
  makeV7Id,
  nextV7Sequence,
  nowIso,
  tombstoneKey,
} from "./db-v7-core";
import {
  enqueueChangeSetV7,
  rewriteChangeSetMutationsV7,
  type ChangeSetMutationV7,
  type ChangeSetQueueRecordV7,
} from "./db-v7-change-sets";
import { deleteBankV7, refreshBankQuestionCountInTx } from "./db-v7-bank";
import type { QuestionV7, TombstoneV7 } from "./v7-types";

export async function deleteQuestionsV7(questionIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(questionIds.filter(Boolean))];
  if (!uniqueIds.length) return 0;
  const questions = (await dbV7.questions.bulkGet(uniqueIds)).filter((question): question is QuestionV7 => Boolean(question));
  if (!questions.length) return 0;
  const existingIds = questions.map((question) => question.id);
  const deletingIds = new Set(existingIds);
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const memberships = await dbV7.bankQuestionMemberships.where("questionId").anyOf(existingIds).toArray();
  const affectedBankIds = [...new Set(memberships.map((membership) => membership.bankId))];
  // H5 导入即删的抵消：被删题目的创建事件仍在本机 pending/blocked（从未推送）时，
  // 从这些 change-set 里滤掉相关 mutation（change-set 变空则整组撤销）。远端从未见过
  // 这些题目，因此它们既不需要墓碑也不需要删除事件——零墓碑零事件。
  const unpublishedIds = new Set<string>();
  const rewritable: Array<{ record: ChangeSetQueueRecordV7; mutations: ChangeSetMutationV7[] }> = [];
  const cancellableIds: string[] = [];
  for (const record of await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).toArray()) {
    let touched = false;
    const mutations = record.mutations.flatMap((mutation) => {
      const created: string[] = mutation.kind === "question.upsert" ? [mutation.question.id]
        : mutation.kind === "question.import" ? mutation.questions.map((item) => item.id)
        : mutation.kind === "question.split" && deletingIds.has(mutation.clone.id) ? [mutation.clone.id]
        : [];
      const references = mutation.kind === "membership.save" ? [mutation.membership.questionId]
        : mutation.kind === "membership.remove" ? [mutation.questionId]
        : mutation.kind === "note.upserted" ? [mutation.note.questionId]
        : mutation.kind === "note.deleted" ? [mutation.questionId]
        : mutation.kind === "attempt.create" || mutation.kind === "attempt.update" ? [mutation.attempt.questionId]
        : mutation.kind === "attempt.delete" && mutation.questionId ? [mutation.questionId]
        : [];
      if (created.some((id) => deletingIds.has(id))) {
        touched = true;
        created.forEach((id) => deletingIds.has(id) && unpublishedIds.add(id));
        if (mutation.kind === "question.import") {
          // 题库创建保留（空题库合法），只滤掉题目与关系。
          const keptQuestions = mutation.questions.filter((item) => !deletingIds.has(item.id));
          const keptMemberships = mutation.memberships.filter((item) => !deletingIds.has(item.questionId));
          if (!keptQuestions.length && !keptMemberships.length) return [];
          return [{ ...mutation, questions: keptQuestions, memberships: keptMemberships }];
        }
        if (mutation.kind === "question.bulk.upsert") {
          const kept = mutation.questions.filter((item) => !deletingIds.has(item.id));
          return kept.length ? [{ ...mutation, questions: kept }] : [];
        }
        return [];
      }
      if (references.some((id) => deletingIds.has(id))) {
        touched = true;
        return [];
      }
      return [mutation];
    });
    if (!touched) continue;
    if (mutations.length) rewritable.push({ record, mutations });
    else cancellableIds.push(record.id);
  }
  // 只对「远端可能已经见过」的题目写墓碑/删除事件（未被抵消的创建）。
  const publishedIds = existingIds.filter((id) => !unpublishedIds.has(id));
  const publishedMembershipKeys = new Set(memberships.filter((membership) => !unpublishedIds.has(membership.questionId)).map((membership) => membership.key));
  const deleteSequence = await nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [
    dbV7.questions, dbV7.bankQuestionMemberships, dbV7.attempts, dbV7.attemptStats,
    dbV7.attemptDailyStats, dbV7.notes, dbV7.questionGroups, dbV7.reviewRoundProgress,
    dbV7.practiceRuns, dbV7.banks, dbV7.tombstones,
    dbV7.changeSets,
  ], async () => {
    for (const id of cancellableIds) await dbV7.changeSets.delete(id);
    for (const { record, mutations } of rewritable) {
      // 重写 digest 承载的 change-set：同 id/序号/时间，只裁剪 mutation。
      const rebuilt = await rewriteChangeSetMutationsV7(record, mutations);
      await dbV7.changeSets.put(rebuilt);
    }
    await dbV7.questions.bulkDelete(existingIds);
    await dbV7.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV7.tombstones.bulkPut(memberships.filter((membership) => publishedMembershipKeys.has(membership.key)).map((membership) => ({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeV7Id("question-delete"), sequence: deleteSequence,
      })));
    await dbV7.attempts.where("questionId").anyOf(existingIds).delete();
    await dbV7.attemptStats.bulkDelete(existingIds);
    await dbV7.attemptDailyStats.where("questionId").anyOf(existingIds).delete();
    await dbV7.reviewRoundProgress.where("questionId").anyOf(existingIds).delete();
    await dbV7.notes.bulkDelete(existingIds);
    const groups = await dbV7.questionGroups.toArray();
    const emptiedGroupIds: string[] = [];
    for (const group of groups) {
      const items = group.items.filter((item) => !deletingIds.has(item.questionId));
      if (items.length !== group.items.length) {
        if (items.length) await dbV7.questionGroups.put({ ...group, items, updatedAt: timestamp });
        else {
          // E6: 删题把组裁空时，与显式 deleteQuestionGroupV7 一致地写墓碑——本地 tombstone 表
          // 与投影（question.bulk.delete 回放时 updateQuestionDeleteCascade 也写墓碑）保持一致，
          // 使后续到达的陈旧 questionGroup.saved 在本机 rebase 时被 rejectTombstoned 拦截。
          await dbV7.questionGroups.delete(group.id);
          emptiedGroupIds.push(group.id);
        }
      }
    }
    const runs = await dbV7.practiceRuns.toArray();
    for (const run of runs) {
      if (!run.questionIds.some((questionId) => deletingIds.has(questionId))) continue;
      const answers = Object.fromEntries(Object.entries(run.answers).filter(([questionId]) => !deletingIds.has(questionId)));
      const questionTypes = Object.fromEntries(Object.entries(run.questionTypes).filter(([questionId]) => !deletingIds.has(questionId)));
      await dbV7.practiceRuns.put({ ...run, questionIds: run.questionIds.filter((id) => !deletingIds.has(id)), answers, questionTypes, updatedAt: timestamp });
    }
    for (const bankId of affectedBankIds) await refreshBankQuestionCountInTx(bankId);
    const tombstones: TombstoneV7[] = publishedIds.map((questionId) => ({
      key: tombstoneKey("question", questionId),
      entityType: "question",
      entityId: questionId,
      deletedAt: timestamp,
      deviceId,
      eventId: makeV7Id("question-delete"),
      sequence: deleteSequence,
    }));
    for (const groupId of emptiedGroupIds) {
      tombstones.push({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt: timestamp, deviceId, eventId: makeV7Id("question-delete"), sequence: deleteSequence });
    }
    await dbV7.tombstones.bulkPut(tombstones);
    if (publishedIds.length) {
      await enqueueChangeSetV7([{ kind: "question.bulk.delete", questionIds: publishedIds, deletedAt: timestamp, cascade: true }], timestamp, { localSequence: deleteSequence });
    }
  });
  return existingIds.length;
}

export async function deleteQuestionV7(questionId: string): Promise<boolean> {
  return (await deleteQuestionsV7([questionId])) > 0;
}

export const deleteQuestionGlobalV7 = deleteQuestionV7;

export async function deleteBankWithExclusiveQuestionsV7(bankId: string): Promise<{ bankDeleted: boolean; deletedQuestions: number }> {
  const memberships = await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  const questionIds = memberships.map((membership) => membership.questionId);
  const allMemberships = questionIds.length ? await dbV7.bankQuestionMemberships.where("questionId").anyOf(questionIds).toArray() : [];
  const membershipCounts = new Map<string, number>();
  for (const membership of allMemberships) membershipCounts.set(membership.questionId, (membershipCounts.get(membership.questionId) ?? 0) + 1);
  const exclusiveQuestionIds = questionIds.filter((questionId) => membershipCounts.get(questionId) === 1);
  const bankDeleted = await deleteBankV7(bankId);
  if (!bankDeleted) return { bankDeleted: false, deletedQuestions: 0 };
  return { bankDeleted: true, deletedQuestions: await deleteQuestionsV7(exclusiveQuestionIds) };
}
