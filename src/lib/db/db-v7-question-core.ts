/** Question create/update/split and bank-membership operations. */
import {
  dbV7,
  getV7DeviceId,
  makeV7Id,
  nextV7Sequence,
  nowIso,
  tombstoneKey,
  uniqueStrings,
} from "./db-v7-core";
import { enqueueChangeSetV7 } from "./db-v7-change-sets";
import {
  getBankQuestionMembershipsV7,
  membershipKey,
  refreshBankQuestionCountInTx,
  saveMembershipInTx,
} from "./db-v7-bank";
import {
  findQuestionByFingerprint,
  questionFromDraft,
  type StructuredQuestionDraftV7,
} from "./db-v7-question-draft";
import type { BankQuestionMembership, NoteV7, QuestionV7 } from "./v7-types";

/** Create content and attach it to a bank, sharing an existing exact match. */
export async function createQuestionV7(bankId: string, draft: StructuredQuestionDraftV7): Promise<QuestionV7> {
  const bank = await dbV7.banks.get(bankId);
  if (!bank) throw new Error("题库不存在或已被删除。");
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const provisional = questionFromDraft(makeV7Id("question"), draft, timestamp, deviceId);
  const existing = await findQuestionByFingerprint(provisional.contentFingerprint);
  const question = existing ?? provisional;
  const currentMemberships = await getBankQuestionMembershipsV7(bankId);
  const membership: BankQuestionMembership = {
    key: membershipKey(bankId, question.id),
    bankId,
    questionId: question.id,
    sortOrder: (currentMemberships.at(-1)?.sortOrder ?? -1) + 1,
    addedAt: timestamp,
    updatedAt: timestamp,
    deviceId,
  };
  await dbV7.transaction("rw", [dbV7.questions, dbV7.bankQuestionMemberships, dbV7.banks, dbV7.tombstones, dbV7.changeSets, dbV7.syncMeta], async () => {
    if (!existing) await dbV7.questions.put(question);
    const currentMembership = await dbV7.bankQuestionMemberships.get(membership.key);
    await saveMembershipInTx(currentMembership ? { ...currentMembership, updatedAt: timestamp, deviceId } : membership);
    await refreshBankQuestionCountInTx(bankId);
    await enqueueChangeSetV7([
      ...(!existing ? [{ kind: "question.upsert" as const, question }] : []),
      { kind: "membership.save", membership },
    ], timestamp);
  });
  return question;
}

export async function updateQuestionV7(questionId: string, changes: Partial<StructuredQuestionDraftV7>): Promise<QuestionV7> {
  const current = await dbV7.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  const timestamp = nowIso();
  const draft: StructuredQuestionDraftV7 = {
    type: changes.type ?? current.type,
    content: changes.content ?? current.content,
    options: changes.options ?? current.options,
    optionIds: changes.optionIds ?? current.optionIds,
    solution: changes.solution ?? current.solution,
    tags: changes.tags ?? current.tags,
    favorite: changes.favorite ?? current.favorite,
  };
  const updated = questionFromDraft(current.id, draft, timestamp, getV7DeviceId());
  await dbV7.transaction("rw", [dbV7.questions, dbV7.changeSets, dbV7.syncMeta], async () => {
    await dbV7.questions.put(updated);
    await enqueueChangeSetV7([{ kind: "question.upsert", question: updated }], timestamp);
  });
  return updated;
}

export const updateSharedQuestionV7 = updateQuestionV7;

/**
 * Split selected memberships into one independent shared content object.
 * Historical attempts/statistics/round progress remain attached to the
 * original global question; only the editable note is copied to the clone.
 */
export function splitQuestionV7(questionId: string, selectedBankIds: readonly string[]): Promise<{ original: QuestionV7; clones: QuestionV7[] }>;
export function splitQuestionV7(input: { questionId: string; selectedBankIds: readonly string[] }): Promise<{ original: QuestionV7; clones: QuestionV7[] }>;
export async function splitQuestionV7(
  questionIdOrInput: string | { questionId: string; selectedBankIds: readonly string[] },
  selectedBankIdsArgument?: readonly string[],
): Promise<{ original: QuestionV7; clones: QuestionV7[] }> {
  const questionId = typeof questionIdOrInput === "string" ? questionIdOrInput : questionIdOrInput.questionId;
  const selectedBankIds = typeof questionIdOrInput === "string" ? selectedBankIdsArgument ?? [] : questionIdOrInput.selectedBankIds;
  const original = await dbV7.questions.get(questionId);
  if (!original) throw new Error("题目不存在或已被删除。");
  const wanted = new Set(uniqueStrings(selectedBankIds));
  const memberships = await dbV7.bankQuestionMemberships.where("questionId").equals(questionId).toArray();
  const selected = memberships.filter((membership) => wanted.has(membership.bankId));
  if (!selected.length) return { original, clones: [] };
  const sourceNote = await dbV7.notes.get(questionId);
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const clone: QuestionV7 = {
    ...original,
    id: makeV7Id("question"),
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
  const clonedNote: NoteV7 | undefined = sourceNote ? {
    ...sourceNote,
    questionId: clone.id,
    revision: 1,
    updatedAt: timestamp,
    deviceId,
  } : undefined;
  const splitSequence = await nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [
    dbV7.questions, dbV7.bankQuestionMemberships, dbV7.notes, dbV7.banks,
    dbV7.tombstones, dbV7.changeSets,
  ], async () => {
    await dbV7.questions.put(clone);
    for (const membership of selected) {
      await dbV7.bankQuestionMemberships.delete(membership.key);
      await dbV7.tombstones.put({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeV7Id("membership-split"), sequence: splitSequence,
      });
    }
    await dbV7.bankQuestionMemberships.bulkPut(movedMemberships);
    if (clonedNote) await dbV7.notes.put(clonedNote);
    await enqueueChangeSetV7([{ kind: "question.split", originalQuestionId: original.id, clone, memberships: movedMemberships, deletedMembershipKeys: selected.map((membership) => membership.key), note: clonedNote }], timestamp, { localSequence: splitSequence });
    for (const membership of selected) await refreshBankQuestionCountInTx(membership.bankId);
  });
  return { original, clones: [clone] };
}

export const splitQuestion = splitQuestionV7;

export function removeMembershipV7(bankId: string, questionId: string): Promise<boolean>;
export function removeMembershipV7(input: Pick<BankQuestionMembership, "bankId" | "questionId">): Promise<boolean>;
export async function removeMembershipV7(
  bankIdOrInput: string | Pick<BankQuestionMembership, "bankId" | "questionId">,
  questionIdArgument?: string,
): Promise<boolean> {
  const bankId = typeof bankIdOrInput === "string" ? bankIdOrInput : bankIdOrInput.bankId;
  const questionId = typeof bankIdOrInput === "string" ? questionIdArgument ?? "" : bankIdOrInput.questionId;
  if (!bankId || !questionId) return false;
  const key = membershipKey(bankId, questionId);
  const current = await dbV7.bankQuestionMemberships.get(key);
  if (!current) return false;
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const membershipDeleteSequence = await nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.bankQuestionMemberships, dbV7.banks, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.bankQuestionMemberships.delete(key);
    await dbV7.tombstones.put({
      key: tombstoneKey("membership", key), entityType: "membership", entityId: key,
      deletedAt: timestamp, deviceId, eventId: makeV7Id("membership-delete"), sequence: membershipDeleteSequence,
    });
    await enqueueChangeSetV7([{ kind: "membership.remove", bankId, questionId, key, removedAt: timestamp }], timestamp, { localSequence: membershipDeleteSequence });
    await refreshBankQuestionCountInTx(bankId);
  });
  return true;
}

export async function removeMembershipsV7(bankId: string, questionIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(questionIds.filter(Boolean))];
  if (!bankId || !uniqueIds.length) return 0;
  const keys = uniqueIds.map((questionId) => membershipKey(bankId, questionId));
  const memberships = (await dbV7.bankQuestionMemberships.bulkGet(keys)).filter((membership): membership is BankQuestionMembership => Boolean(membership));
  if (!memberships.length) return 0;
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const membershipBulkDeleteSequence = await nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.bankQuestionMemberships, dbV7.banks, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV7.tombstones.bulkPut(memberships.map((membership) => ({
      key: tombstoneKey("membership", membership.key), entityType: "membership" as const, entityId: membership.key,
      deletedAt: timestamp, deviceId, eventId: makeV7Id("membership-delete"), sequence: membershipBulkDeleteSequence,
    })));
    await enqueueChangeSetV7([{ kind: "membership.bulk.remove", keys: memberships.map((membership) => membership.key), bankId, removedAt: timestamp }], timestamp, { localSequence: membershipBulkDeleteSequence });
    await refreshBankQuestionCountInTx(bankId);
  });
  return memberships.length;
}

export async function toggleQuestionFavoriteV7(questionId: string): Promise<QuestionV7> {
  const current = await dbV7.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  return updateQuestionV7(questionId, { favorite: !current.favorite });
}
