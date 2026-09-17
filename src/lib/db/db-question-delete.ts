/** Global question deletion and cascade cleanup. */
import {
  studyDb,
  getDeviceId,
  makeId,
  nextSequence,
  nowIso,
  tombstoneKey,
} from "./db-core";
import {
  enqueueChangeSet,
  rewriteChangeSetMutations,
  type ChangeSetMutation,
  type ChangeSetQueueRecord,
} from "./db-change-sets";
import { deleteBank, membershipPrimaryKey, refreshBankQuestionCountInTx } from "./db-bank";
import type { Question, Tombstone } from "./types";

export async function deleteQuestions(questionIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(questionIds.filter(Boolean))];
  if (!uniqueIds.length) return 0;
  return studyDb.transaction("rw", [
    studyDb.questions, studyDb.bankQuestionMemberships, studyDb.attempts, studyDb.questionProgress,
    studyDb.questionDailyProgress, studyDb.notes, studyDb.questionGroups, studyDb.questionGroupItems, studyDb.reviewRoundItems, studyDb.reviewRoundProgress,
    studyDb.practiceRuns, studyDb.practiceRunItems, studyDb.banks, studyDb.tombstones,
    studyDb.changeSets, studyDb.syncMeta,
  ], async () => {
    const questions = (await studyDb.questions.bulkGet(uniqueIds)).filter((question): question is Question => Boolean(question));
    if (!questions.length) return 0;
    const existingIds = questions.map((question) => question.id);
    const deletingIds = new Set(existingIds);
    const timestamp = nowIso();
    const deviceId = getDeviceId();
    const memberships = await studyDb.bankQuestionMemberships.where("questionId").anyOf(existingIds).toArray();
    const affectedBankIds = [...new Set(memberships.map((membership) => membership.bankId))];
    // H5 导入即删的抵消：被删题目的创建事件仍在本机 pending/blocked（从未推送）时，
    // 从这些 change-set 里滤掉相关 mutation（change-set 变空则整组撤销）。远端从未见过
    // 这些题目，因此它们既不需要墓碑也不需要删除事件——零墓碑零事件。
    const unpublishedIds = new Set<string>();
    const rewritable: Array<{ record: ChangeSetQueueRecord; mutations: ChangeSetMutation[] }> = [];
    const cancellableIds: string[] = [];
    for (const record of await studyDb.changeSets.where("state").anyOf(["pending", "blocked"]).toArray()) {
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
    const deleteSequence = await nextSequence(deviceId);
    for (const id of cancellableIds) await studyDb.changeSets.delete(id);
    for (const { record, mutations } of rewritable) {
      // 重写 digest 承载的 change-set：同 id/序号/时间，只裁剪 mutation。
      const rebuilt = await rewriteChangeSetMutations(record, mutations);
      await studyDb.changeSets.put(rebuilt);
    }
    await studyDb.questions.bulkDelete(existingIds);
    await studyDb.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membershipPrimaryKey(membership.bankId, membership.questionId)));
    await studyDb.tombstones.bulkPut(memberships.filter((membership) => publishedMembershipKeys.has(membership.key)).map((membership) => ({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeId("question-delete"), sequence: deleteSequence,
      })));
    await studyDb.attempts.where("questionId").anyOf(existingIds).delete();
    await studyDb.questionProgress.bulkDelete(existingIds);
    await studyDb.questionDailyProgress.where("questionId").anyOf(existingIds).delete();
    await studyDb.reviewRoundProgress.where("questionId").anyOf(existingIds).delete();
    await studyDb.reviewRoundItems.where("questionId").anyOf(existingIds).delete();
    await studyDb.notes.bulkDelete(existingIds);
    const groupItems = await studyDb.questionGroupItems.where("questionId").anyOf(existingIds).toArray();
    const affectedGroupIds = [...new Set(groupItems.map((item) => item.groupId))];
    if (groupItems.length) {
      await studyDb.questionGroupItems.bulkDelete(groupItems.map((item) => [item.groupId, item.questionId] as [string, string]));
    }
    const emptiedGroupIds: string[] = [];
    for (const groupId of affectedGroupIds) {
      if (await studyDb.questionGroupItems.where("groupId").equals(groupId).count()) continue;
      const group = await studyDb.questionGroups.get(groupId);
      if (group) {
        // E6: 删题把组裁空时，与显式 deleteQuestionGroup 一致地写墓碑。
        await studyDb.questionGroups.delete(groupId);
        emptiedGroupIds.push(groupId);
      }
    }
    await studyDb.practiceRunItems.where("questionId").anyOf(existingIds).delete();
    for (const bankId of affectedBankIds) await refreshBankQuestionCountInTx(bankId);
    const tombstones: Tombstone[] = publishedIds.map((questionId) => ({
      key: tombstoneKey("question", questionId),
      entityType: "question",
      entityId: questionId,
      deletedAt: timestamp,
      deviceId,
      eventId: makeId("question-delete"),
      sequence: deleteSequence,
    }));
    for (const groupId of emptiedGroupIds) {
      tombstones.push({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt: timestamp, deviceId, eventId: makeId("question-delete"), sequence: deleteSequence });
    }
    await studyDb.tombstones.bulkPut(tombstones);
    if (publishedIds.length) {
      await enqueueChangeSet([{ kind: "question.bulk.delete", questionIds: publishedIds, deletedAt: timestamp, cascade: true }], timestamp, { localSequence: deleteSequence });
    }
    return existingIds.length;
  });
}

export async function deleteQuestion(questionId: string): Promise<boolean> {
  return (await deleteQuestions([questionId])) > 0;
}

export const deleteQuestionGlobal = deleteQuestion;

export async function deleteBankWithExclusiveQuestions(bankId: string): Promise<{ bankDeleted: boolean; deletedQuestions: number }> {
  return studyDb.transaction("rw", [
    studyDb.questions, studyDb.bankQuestionMemberships, studyDb.attempts, studyDb.questionProgress,
    studyDb.questionDailyProgress, studyDb.notes, studyDb.questionGroups, studyDb.questionGroupItems, studyDb.reviewRoundItems,
    studyDb.reviewRoundProgress, studyDb.practiceRuns, studyDb.practiceRunItems,
    studyDb.bankPracticeStats, studyDb.banks, studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta,
  ], async () => {
    const memberships = await studyDb.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
    const questionIds = memberships.map((membership) => membership.questionId);
    const allMemberships = questionIds.length ? await studyDb.bankQuestionMemberships.where("questionId").anyOf(questionIds).toArray() : [];
    const membershipCounts = new Map<string, number>();
    for (const membership of allMemberships) membershipCounts.set(membership.questionId, (membershipCounts.get(membership.questionId) ?? 0) + 1);
    const exclusiveQuestionIds = questionIds.filter((questionId) => membershipCounts.get(questionId) === 1);
    const bankDeleted = await deleteBank(bankId);
    if (!bankDeleted) return { bankDeleted: false, deletedQuestions: 0 };
    return { bankDeleted: true, deletedQuestions: await deleteQuestions(exclusiveQuestionIds) };
  });
}
