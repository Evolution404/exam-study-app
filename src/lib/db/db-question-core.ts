/** Question create/update/split and bank-membership operations. */
import {
  studyDb,
  getDeviceId,
  makeId,
  nextSequence,
  nowIso,
  tombstoneKey,
  uniqueStrings,
} from "./db-core";
import { enqueueChangeSet } from "./db-change-sets";
import {
  getBankQuestionMemberships,
  membershipKey,
  membershipPrimaryKey,
  refreshBankQuestionCountInTx,
  saveMembershipInTx,
} from "./db-bank";
import {
  findQuestionByFingerprint,
  questionFromDraft,
  type StructuredQuestionDraft,
} from "./db-question-draft";
import type { BankQuestionMembership, Note, Question } from "./types";

/** Create content and attach it to a bank, sharing an existing exact match. */
export async function createQuestion(bankId: string, draft: StructuredQuestionDraft): Promise<Question> {
  const timestamp = nowIso();
  const deviceId = getDeviceId();
  const provisional = questionFromDraft(makeId("question"), draft, timestamp, deviceId);
  return studyDb.transaction("rw", [studyDb.questions, studyDb.bankQuestionMemberships, studyDb.banks, studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta], async () => {
    const bank = await studyDb.banks.get(bankId);
    if (!bank) throw new Error("题库不存在或已被删除。");
    const existing = await findQuestionByFingerprint(provisional.contentFingerprint);
    const question = existing ?? provisional;
    const currentMemberships = await getBankQuestionMemberships(bankId);
    const membership: BankQuestionMembership = {
      key: membershipKey(bankId, question.id),
      bankId,
      questionId: question.id,
      sortOrder: (currentMemberships.at(-1)?.sortOrder ?? -1) + 1,
      addedAt: timestamp,
      updatedAt: timestamp,
      deviceId,
    };
    if (!existing) await studyDb.questions.put(question);
    const currentMembership = await studyDb.bankQuestionMemberships.get(membershipPrimaryKey(bankId, question.id));
    await saveMembershipInTx(currentMembership ? { ...currentMembership, updatedAt: timestamp, deviceId } : membership);
    await refreshBankQuestionCountInTx(bankId);
    await enqueueChangeSet([
      ...(!existing ? [{ kind: "question.upsert" as const, question }] : []),
      { kind: "membership.save", membership },
    ], timestamp);
    return question;
  });
}

export async function updateQuestion(questionId: string, changes: Partial<StructuredQuestionDraft>): Promise<Question> {
  return studyDb.transaction("rw", [studyDb.questions, studyDb.changeSets, studyDb.syncMeta], async () => {
    return updateQuestionInTx(questionId, () => changes);
  });
}

async function updateQuestionInTx(
  questionId: string,
  changes: (current: Question) => Partial<StructuredQuestionDraft>,
): Promise<Question> {
  const current = await studyDb.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  const timestamp = nowIso();
  const updated = questionFromDraft(current.id, questionDraftWithChanges(current, changes(current)), timestamp, getDeviceId());
  await studyDb.questions.put(updated);
  await enqueueChangeSet([{ kind: "question.upsert", question: updated }], timestamp);
  return updated;
}

function questionDraftWithChanges(current: Question, changes: Partial<StructuredQuestionDraft>): StructuredQuestionDraft {
  return {
    type: changes.type ?? current.type,
    content: changes.content ?? current.content,
    options: changes.options ?? current.options,
    optionIds: changes.optionIds ?? current.optionIds,
    solution: changes.solution ?? current.solution,
    tags: changes.tags ?? current.tags,
    favorite: changes.favorite ?? current.favorite,
  };
}

export async function updateQuestions(
  questionIds: readonly string[],
  changes: Partial<StructuredQuestionDraft> | ((question: Question) => Partial<StructuredQuestionDraft>),
): Promise<Question[]> {
  const uniqueIds = uniqueStrings(questionIds);
  if (!uniqueIds.length) return [];
  return studyDb.transaction("rw", [studyDb.questions, studyDb.changeSets, studyDb.syncMeta], async () => {
    const currentQuestions = await studyDb.questions.bulkGet(uniqueIds);
    if (currentQuestions.some((question) => !question)) throw new Error("部分题目不存在或已被删除。");
    const timestamp = nowIso();
    const deviceId = getDeviceId();
    const updated = currentQuestions.map((current) => {
      const question = current!;
      const patch = typeof changes === "function" ? changes(question) : changes;
      return questionFromDraft(question.id, questionDraftWithChanges(question, patch), timestamp, deviceId);
    });
    await studyDb.questions.bulkPut(updated);
    await enqueueChangeSet([{ kind: "question.bulk.upsert", questions: updated }], timestamp);
    return updated;
  });
}

export const updateSharedQuestion = updateQuestion;

/**
 * Split selected memberships into one independent shared content object.
 * Historical attempts/statistics/round progress remain attached to the
 * original global question; only the editable note is copied to the clone.
 */
export function splitQuestion(questionId: string, selectedBankIds: readonly string[]): Promise<{ original: Question; clones: Question[] }>;
export function splitQuestion(input: { questionId: string; selectedBankIds: readonly string[] }): Promise<{ original: Question; clones: Question[] }>;
export async function splitQuestion(
  questionIdOrInput: string | { questionId: string; selectedBankIds: readonly string[] },
  selectedBankIdsArgument?: readonly string[],
): Promise<{ original: Question; clones: Question[] }> {
  const questionId = typeof questionIdOrInput === "string" ? questionIdOrInput : questionIdOrInput.questionId;
  const selectedBankIds = typeof questionIdOrInput === "string" ? selectedBankIdsArgument ?? [] : questionIdOrInput.selectedBankIds;
  return studyDb.transaction("rw", [
    studyDb.questions, studyDb.bankQuestionMemberships, studyDb.notes, studyDb.banks,
    studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta,
  ], async () => {
    const original = await studyDb.questions.get(questionId);
    if (!original) throw new Error("题目不存在或已被删除。");
    const wanted = new Set(uniqueStrings(selectedBankIds));
    const memberships = await studyDb.bankQuestionMemberships.where("questionId").equals(questionId).toArray();
    const selected = memberships.filter((membership) => wanted.has(membership.bankId));
    if (!selected.length) return { original, clones: [] };
    const sourceNote = await studyDb.notes.get(questionId);
    const timestamp = nowIso();
    const deviceId = getDeviceId();
    const clone: Question = {
      ...original,
      id: makeId("question"),
      content: original.content.map((block) => ({ ...block })),
      options: original.options.map((option) => option.map((block) => ({ ...block }))),
      tags: [...original.tags],
      favorite: original.favorite,
      updatedAt: timestamp,
      deviceId,
    };
    const movedMemberships = selected.map((membership) => ({
      ...membership,
      key: membershipKey(membership.bankId, clone.id),
      questionId: clone.id,
      updatedAt: timestamp,
      deviceId,
    }));
    const clonedNote: Note | undefined = sourceNote ? {
      ...sourceNote,
      questionId: clone.id,
      revision: 1,
      updatedAt: timestamp,
      deviceId,
    } : undefined;
    const splitSequence = await nextSequence(deviceId);
    await studyDb.questions.put(clone);
    for (const membership of selected) {
      await studyDb.bankQuestionMemberships.delete(membershipPrimaryKey(membership.bankId, membership.questionId));
      await studyDb.tombstones.put({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeId("membership-split"), sequence: splitSequence,
      });
    }
    await studyDb.bankQuestionMemberships.bulkPut(movedMemberships);
    if (clonedNote) await studyDb.notes.put(clonedNote);
    await enqueueChangeSet([{ kind: "question.split", originalQuestionId: original.id, clone, memberships: movedMemberships, deletedMembershipKeys: selected.map((membership) => membership.key), note: clonedNote }], timestamp, { localSequence: splitSequence });
    for (const membership of selected) await refreshBankQuestionCountInTx(membership.bankId);
    return { original, clones: [clone] };
  });
}

/** Attach existing canonical questions to another bank without cloning content. */
export async function addMemberships(bankId: string, questionIds: readonly string[]): Promise<number> {
  const uniqueIds = uniqueStrings(questionIds);
  if (!bankId || !uniqueIds.length) return 0;
  return studyDb.transaction("rw", [
    studyDb.bankQuestionMemberships, studyDb.banks, studyDb.questions,
    studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta,
  ], async () => {
    const [bank, questions, existingMemberships, currentMemberships] = await Promise.all([
      studyDb.banks.get(bankId),
      studyDb.questions.bulkGet(uniqueIds),
      studyDb.bankQuestionMemberships.bulkGet(uniqueIds.map((questionId) => membershipPrimaryKey(bankId, questionId))),
      studyDb.bankQuestionMemberships.where("bankId").equals(bankId).toArray(),
    ]);
    if (!bank) throw new Error("题库不存在或已被删除。");
    if (questions.some((question) => !question)) throw new Error("部分题目不存在或已被删除。");
    const existingIds = new Set(existingMemberships.filter(Boolean).map((membership) => membership!.questionId));
    const missingIds = uniqueIds.filter((questionId) => !existingIds.has(questionId));
    if (!missingIds.length) return 0;
    const timestamp = nowIso();
    const deviceId = getDeviceId();
    const sequence = await nextSequence(deviceId);
    let sortOrder = currentMemberships.reduce((max, membership) => Math.max(max, membership.sortOrder), -1) + 1;
    const memberships: BankQuestionMembership[] = missingIds.map((questionId) => ({
      key: membershipKey(bankId, questionId),
      bankId,
      questionId,
      sortOrder: sortOrder++,
      addedAt: timestamp,
      updatedAt: timestamp,
      deviceId,
    }));
    for (const membership of memberships) await saveMembershipInTx(membership);
    await refreshBankQuestionCountInTx(bankId);
    await enqueueChangeSet([{ kind: "membership.bulk.save", memberships }], timestamp, { localSequence: sequence });
    return memberships.length;
  });
}

export async function addMembership(bankId: string, questionId: string): Promise<boolean> {
  return (await addMemberships(bankId, [questionId])) > 0;
}

/** Atomically replace one question's bank memberships; an empty list means unfiled. */
export async function setQuestionMemberships(questionId: string, bankIds: readonly string[]): Promise<{ added: number; removed: number }> {
  const targetBankIds = uniqueStrings(bankIds);
  return studyDb.transaction("rw", [
    studyDb.questions, studyDb.bankQuestionMemberships, studyDb.banks,
    studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta,
  ], async () => {
    const [question, currentMemberships, targetBanks] = await Promise.all([
      studyDb.questions.get(questionId),
      studyDb.bankQuestionMemberships.where("questionId").equals(questionId).toArray(),
      studyDb.banks.bulkGet(targetBankIds),
    ]);
    if (!question) throw new Error("题目不存在或已被删除。");
    if (targetBanks.some((bank) => !bank)) throw new Error("部分题库不存在或已被删除。");
    const currentBankIds = new Set(currentMemberships.map((membership) => membership.bankId));
    const targetBankIdSet = new Set(targetBankIds);
    const removedMemberships = currentMemberships.filter((membership) => !targetBankIdSet.has(membership.bankId));
    const addedBankIds = targetBankIds.filter((bankId) => !currentBankIds.has(bankId));
    if (!removedMemberships.length && !addedBankIds.length) return { added: 0, removed: 0 };

    const existingByAddedBank = await Promise.all(addedBankIds.map((bankId) => studyDb.bankQuestionMemberships.where("bankId").equals(bankId).toArray()));
    const timestamp = nowIso();
    const deviceId = getDeviceId();
    const sequence = await nextSequence(deviceId);
    const addedMemberships: BankQuestionMembership[] = addedBankIds.map((bankId, index) => {
      const sortOrder = existingByAddedBank[index].reduce((max, membership) => Math.max(max, membership.sortOrder), -1) + 1;
      return {
        key: membershipKey(bankId, questionId),
        bankId,
        questionId,
        sortOrder,
        addedAt: timestamp,
        updatedAt: timestamp,
        deviceId,
      };
    });
    const affectedBankIds = uniqueStrings([...addedBankIds, ...removedMemberships.map((membership) => membership.bankId)]);
    if (removedMemberships.length) {
      await studyDb.bankQuestionMemberships.bulkDelete(removedMemberships.map((membership) => membershipPrimaryKey(membership.bankId, membership.questionId)));
      await studyDb.tombstones.bulkPut(removedMemberships.map((membership) => ({
        key: tombstoneKey("membership", membership.key), entityType: "membership" as const, entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeId("membership-delete"), sequence,
      })));
    }
    for (const membership of addedMemberships) await saveMembershipInTx(membership);
    const mutations = [
      ...(addedMemberships.length ? [{ kind: "membership.bulk.save" as const, memberships: addedMemberships }] : []),
      ...(removedMemberships.length ? [{ kind: "membership.bulk.remove" as const, keys: removedMemberships.map((membership) => membership.key), removedAt: timestamp }] : []),
    ];
    await enqueueChangeSet(mutations, timestamp, { localSequence: sequence });
    for (const bankId of affectedBankIds) await refreshBankQuestionCountInTx(bankId);
    return { added: addedMemberships.length, removed: removedMemberships.length };
  });
}

export function removeMembership(bankId: string, questionId: string): Promise<boolean>;
export function removeMembership(input: Pick<BankQuestionMembership, "bankId" | "questionId">): Promise<boolean>;
export async function removeMembership(
  bankIdOrInput: string | Pick<BankQuestionMembership, "bankId" | "questionId">,
  questionIdArgument?: string,
): Promise<boolean> {
  const bankId = typeof bankIdOrInput === "string" ? bankIdOrInput : bankIdOrInput.bankId;
  const questionId = typeof bankIdOrInput === "string" ? questionIdArgument ?? "" : bankIdOrInput.questionId;
  if (!bankId || !questionId) return false;
  const key = membershipKey(bankId, questionId);
  return studyDb.transaction("rw", [studyDb.bankQuestionMemberships, studyDb.banks, studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta], async () => {
    const current = await studyDb.bankQuestionMemberships.get(membershipPrimaryKey(bankId, questionId));
    if (!current) return false;
    const timestamp = nowIso();
    const deviceId = getDeviceId();
    const membershipDeleteSequence = await nextSequence(deviceId);
    await studyDb.bankQuestionMemberships.delete(membershipPrimaryKey(bankId, questionId));
    await studyDb.tombstones.put({
      key: tombstoneKey("membership", key), entityType: "membership", entityId: key,
      deletedAt: timestamp, deviceId, eventId: makeId("membership-delete"), sequence: membershipDeleteSequence,
    });
    await enqueueChangeSet([{ kind: "membership.remove", bankId, questionId, key, removedAt: timestamp }], timestamp, { localSequence: membershipDeleteSequence });
    await refreshBankQuestionCountInTx(bankId);
    return true;
  });
}

export async function removeMemberships(bankId: string, questionIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(questionIds.filter(Boolean))];
  if (!bankId || !uniqueIds.length) return 0;
  const primaryKeys = uniqueIds.map((questionId) => membershipPrimaryKey(bankId, questionId));
  return studyDb.transaction("rw", [studyDb.bankQuestionMemberships, studyDb.banks, studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta], async () => {
    const memberships = (await studyDb.bankQuestionMemberships.bulkGet(primaryKeys)).filter((membership): membership is BankQuestionMembership => Boolean(membership));
    if (!memberships.length) return 0;
    const timestamp = nowIso();
    const deviceId = getDeviceId();
    const membershipBulkDeleteSequence = await nextSequence(deviceId);
    await studyDb.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membershipPrimaryKey(membership.bankId, membership.questionId)));
    await studyDb.tombstones.bulkPut(memberships.map((membership) => ({
      key: tombstoneKey("membership", membership.key), entityType: "membership" as const, entityId: membership.key,
      deletedAt: timestamp, deviceId, eventId: makeId("membership-delete"), sequence: membershipBulkDeleteSequence,
    })));
    await enqueueChangeSet([{ kind: "membership.bulk.remove", keys: memberships.map((membership) => membership.key), bankId, removedAt: timestamp }], timestamp, { localSequence: membershipBulkDeleteSequence });
    await refreshBankQuestionCountInTx(bankId);
    return memberships.length;
  });
}

export async function toggleQuestionFavorite(questionId: string): Promise<Question> {
  return studyDb.transaction("rw", [studyDb.questions, studyDb.changeSets, studyDb.syncMeta], async () => {
    return updateQuestionInTx(questionId, (current) => ({ favorite: !current.favorite }));
  });
}
