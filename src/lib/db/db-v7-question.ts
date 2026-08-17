/**
 * v7 question content, imports, question groups, notes and cascade deletes.
 */
import {
  dbV7,
  getV7DeviceId,
  makeV7Id,
  nextV7Sequence,
  nowIso,
  tombstoneKey,
  uniqueStrings,
} from "./db-v7-core";
import type { QuestionDraftV7 } from "./db-v7-core";
import { enqueueChangeSetV7, rewriteChangeSetMutationsV7, type ChangeSetMutationV7, type ChangeSetQueueRecordV7 } from "./db-v7-change-sets";
import {
  deleteBankV7,
  getBankQuestionMembershipsV7,
  membershipKey,
  refreshBankQuestionCountInTx,
  saveMembershipInTx,
  sha256Text,
} from "./db-v7-bank";
import {
  blocksFromPlaceholderText,
  deriveContentText,
  normalizeContentText,
  plainTextToContentBlocks,
  questionContentFingerprint,
  stripImagePlaceholders,
} from "../question/question-content";
import { normalizeCalculationAnswer } from "../question/question-utils";
import type {
  BankQuestionMembership,
  BankV7,
  ContentBlock,
  NoteV7,
  QuestionGroupV7,
  QuestionTypeV7,
  QuestionV7,
  TombstoneV7,
} from "./v7-types";

function normalizeAnswer(type: QuestionTypeV7, input: string | readonly string[]): string {
  const raw = Array.isArray(input) ? input.join("") : String(input);
  if (type === "计算") return normalizeCalculationAnswer(raw);
  return uniqueStrings([...raw.toUpperCase().replace(/[^A-Z]/g, "")]).sort().join("");
}

function normalizeBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map((block, index) => {
    if (block.type === "text") {
      return { ...block, id: block.id || `text-${index}`, text: normalizeContentText(block.text) };
    }
    return { ...block, id: block.id || `image-${index}` };
  });
}

function blocksFromOptions(options: QuestionDraftV7["options"]): ContentBlock[][] {
  return (options ?? []).map((option, optionIndex) => {
    if (Array.isArray(option) && option.every((item) => typeof item === "object")) {
      return normalizeBlocks(option as ContentBlock[]);
    }
    const text = normalizeContentText(String(option ?? ""));
    return plainTextToContentBlocks(text, `option-${optionIndex}-0`);
  });
}

function questionFromDraft(id: string, draft: QuestionDraftV7, timestamp: string, deviceId: string): QuestionV7 {
  const content = normalizeBlocks(draft.content ?? plainTextToContentBlocks(draft.stem ?? "", "stem-0"));
  const options = blocksFromOptions(draft.options);
  const answer = normalizeAnswer(draft.type, draft.answer);
  const contentFingerprint = questionContentFingerprint({ type: draft.type, content, options, answer });
  return {
    id,
    type: draft.type,
    content,
    options,
    answer,
    tags: uniqueStrings(draft.tags ?? []),
    favorite: Boolean(draft.favorite),
    contentFingerprint,
    updatedAt: timestamp,
    deviceId,
  };
}

async function findQuestionByFingerprint(fingerprint: string): Promise<QuestionV7 | undefined> {
  return dbV7.questions.where("contentFingerprint").equals(fingerprint).first();
}

/** Create content and attach it to a bank, sharing an existing exact match. */
export async function createQuestionV7(bankId: string, draft: QuestionDraftV7): Promise<QuestionV7> {
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
  await dbV7.transaction("rw", [dbV7.questions, dbV7.bankQuestionMemberships, dbV7.banks, dbV7.tombstones, dbV7.changeSets], async () => {
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

export async function updateQuestionV7(questionId: string, changes: Partial<QuestionDraftV7>): Promise<QuestionV7> {
  const current = await dbV7.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  const timestamp = nowIso();
  const draft: QuestionDraftV7 = {
    type: changes.type ?? current.type,
    content: changes.content ?? current.content,
    options: changes.options ?? current.options,
    answer: changes.answer ?? current.answer,
    tags: changes.tags ?? current.tags,
    favorite: changes.favorite ?? current.favorite,
  };
  const updated = questionFromDraft(current.id, draft, timestamp, getV7DeviceId());
  await dbV7.transaction("rw", [dbV7.questions, dbV7.changeSets], async () => {
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
  const splitSequence = nextV7Sequence(deviceId);
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
  const membershipDeleteSequence = nextV7Sequence(deviceId);
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
  const membershipBulkDeleteSequence = nextV7Sequence(deviceId);
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
  const deleteSequence = nextV7Sequence(deviceId);
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

interface ImportedQuestionRowV7 {
  stem: string;
  type?: string;
  options?: unknown;
  answer?: unknown;
  tags?: unknown;
}

function rawQuestionRows(raw: unknown): { name?: string; rows: ImportedQuestionRowV7[] } {
  if (typeof raw === "string") {
    try {
      return rawQuestionRows(JSON.parse(raw) as unknown);
    } catch {
      throw new Error("JSON 题库内容无效。");
    }
  }
  if (Array.isArray(raw)) return { rows: raw as ImportedQuestionRowV7[] };
  if (!raw || typeof raw !== "object") throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");
  const record = raw as Record<string, unknown>;
  const questions = record.questions ?? record.items ?? record.data;
  if (!Array.isArray(questions)) throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");
  return { name: typeof record.name === "string" ? record.name : undefined, rows: questions as ImportedQuestionRowV7[] };
}

function rowString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (row[key] === undefined || row[key] === null) continue;
    if (Array.isArray(row[key])) return row[key].join("");
    return String(row[key]);
  }
  return "";
}

function rowOptions(row: Record<string, unknown>): unknown {
  return row.options ?? row.a ?? row.choices ?? row["选项"];
}

const ASSET_ID_PATTERN = /^[0-9a-f]{64}$/;
const PLACEHOLDER_TEST = /【图[0-9]+】/;

/** Sanitise semi-trusted imported blocks: text blocks keep their text, image
 *  blocks must reference a materialised 64-hex asset id.  Anything else is
 *  dropped rather than trusted. */
function importedBlocks(value: unknown): ContentBlock[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const blocks: ContentBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ id: `text-${blocks.length}`, type: "text", text: normalizeContentText(block.text) });
    } else if (block.type === "image" && typeof block.assetId === "string" && ASSET_ID_PATTERN.test(block.assetId)) {
      blocks.push({ id: `image-${blocks.length}`, type: "image", assetId: block.assetId });
    } else return undefined;
  }
  return blocks;
}

function importDraft(row: ImportedQuestionRowV7): QuestionDraftV7 | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as unknown as Record<string, unknown>;
  const imageIds = Array.isArray(record.images)
    ? record.images.map(String).filter((id) => ASSET_ID_PATTERN.test(id))
    : [];
  // Structured content (zip bundle) wins; otherwise placeholder text (Excel
  // image columns) is split back into blocks, and plain stems stay plain.
  const structuredContent = importedBlocks(record.content);
  const rawStem = normalizeContentText(rowString(record, "stem", "question", "q", "题干"));
  const stem = rawStem || (structuredContent ? deriveContentText(structuredContent) : "");
  if (!stem && !structuredContent?.length) return undefined;
  const content = structuredContent ?? (imageIds.length ? blocksFromPlaceholderText(rawStem, imageIds, "stem") : undefined);
  const cleanStem = content ? undefined : (imageIds.length ? rawStem : stripImagePlaceholders(rawStem));
  const rawOptions = rowOptions(record);
  const blockOptions = Array.isArray(rawOptions) && rawOptions.length > 0 && rawOptions.every((item) => Array.isArray(item))
    ? rawOptions.map((item, index) => importedBlocks(item) ?? plainTextToContentBlocks("", `option-${index}-0`))
    : undefined;
  // Excel image columns ship option text with 【图N】 markers; those options
  // split into block arrays so the images land inside the option itself.
  const placeholderOption = (value: unknown, index: number) => {
    const optionText = String(value ?? "").trim();
    return imageIds.length && PLACEHOLDER_TEST.test(optionText) ? blocksFromPlaceholderText(optionText, imageIds, `option-${index}`) : optionText;
  };
  const options = blockOptions ?? (Array.isArray(rawOptions) ? rawOptions.map(placeholderOption) : []);
  const optionTexts = options.map((option) => typeof option === "string" ? option : deriveContentText(option));
  const rawType = rowString(record, "type", "questionType", "题型").trim();
  const rawAnswer = record.answer ?? record.ans ?? record.correctAnswer ?? record["答案"] ?? "";
  const answer = Array.isArray(rawAnswer) ? rawAnswer.map(String).join("") : String(rawAnswer);
  const type: QuestionTypeV7 = rawType === "判断" || rawType === "单选" || rawType === "多选" || rawType === "计算"
    ? rawType
    : optionTexts.length === 2 && optionTexts[0] === "正确" && optionTexts[1] === "错误"
      ? "判断"
      : answer.replace(/[^A-Z]/gi, "").length > 1 ? "多选" : "单选";
  if (!answer.trim() || (type !== "计算" && options.length < 2)) return undefined;
  const rawTags = record.tags ?? record["标签"];
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags ?? "").split(/[，,、\n]+/);
  const note = rowString(record, "note", "analysis", "解析").trim();
  return {
    type,
    ...(content ? { content } : { stem: cleanStem ?? stem }),
    options,
    answer,
    tags: uniqueStrings(tags),
    ...(note ? { note } : {}),
  };
}

/**
 * Import a plain JSON question list.  The bank id is deterministic for a
 * filename/name, while question identity is content-addressed globally.  Pass
 * `options.targetBankId` to append into an EXISTING bank instead of deriving
 * one from the file name (dedupe / sortOrder append / note ownership all keep
 * the same semantics).  The import is published as one atomic change-set; when
 * its body exceeds the v7 inline-event budget the sync layer offloads it to a
 * content-addressed immutable object, so imports of any size stay within the
 * protocol limits.
 */
export async function importQuestionBankV7(fileName: string, raw: unknown, options?: { targetBankId?: string }): Promise<BankV7 & { importedCount: number }> {
  const parsed = rawQuestionRows(raw);
  const rows = parsed.rows.map(importDraft).filter((row): row is QuestionDraftV7 => Boolean(row));
  if (!rows.length) throw new Error("题库中没有可导入的有效题目。");
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  let bank: BankV7;
  if (options?.targetBankId) {
    const existingBank = await dbV7.banks.get(options.targetBankId);
    if (!existingBank) throw new Error("目标题库不存在，可能已被删除，请刷新后重试。");
    bank = { ...existingBank, updatedAt: timestamp, deviceId };
  } else {
    const sourceName = (parsed.name?.trim() || fileName.replace(/\.(json|txt)$/i, "").trim());
    if (!sourceName) throw new Error("题库名称不能为空。");
    const bankId = `bank_${(await sha256Text(sourceName)).slice(0, 48)}`;
    const existingBank = await dbV7.banks.get(bankId);
    bank = existingBank ? {
      ...existingBank,
      name: existingBank.name || sourceName,
      updatedAt: timestamp,
      deviceId,
    } : {
      id: bankId,
      name: sourceName,
      sortOrder: await dbV7.banks.count(),
      questionCount: 0,
      importedAt: timestamp,
      updatedAt: timestamp,
      deviceId,
    };
  }
  const seenInImport = new Set<string>();
  const materialised: Array<{ question: QuestionV7; membership: BankQuestionMembership; isNewMembership: boolean }> = [];
  const materialisedNotes: NoteV7[] = [];
  let sortOrder = await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).count();
  for (const draft of rows) {
    const provisional = questionFromDraft(makeV7Id("question"), draft, timestamp, deviceId);
    const existing = await findQuestionByFingerprint(provisional.contentFingerprint);
    const question = existing ?? provisional;
    if (seenInImport.has(question.id)) continue;
    seenInImport.add(question.id);
    const existingMembership = await dbV7.bankQuestionMemberships.get(membershipKey(bank.id, question.id));
    const membership: BankQuestionMembership = existingMembership ?? {
      key: membershipKey(bank.id, question.id),
      bankId: bank.id,
      questionId: question.id,
      sortOrder: sortOrder++,
      addedAt: timestamp,
      updatedAt: timestamp,
      deviceId,
    };
    materialised.push({ question, membership: { ...membership, updatedAt: timestamp, deviceId }, isNewMembership: !existingMembership });
    // Imported 解析 becomes a personal note only when the question has none yet;
    // an existing note is user-owned and must not be overwritten by re-import.
    if (draft.note?.trim() && !(await dbV7.notes.get(question.id))) {
      materialisedNotes.push({ questionId: question.id, content: draft.note.trim(), revision: 1, updatedAt: timestamp, deviceId });
    }
  }
  await dbV7.transaction("rw", [dbV7.banks, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.tombstones, dbV7.changeSets, dbV7.notes], async () => {
    await dbV7.banks.put(bank);
    for (const item of materialised) {
      // Existing content is user-owned and already semantically identical;
      // preserving it avoids a second device overwriting tags/favourites.
      if (!(await dbV7.questions.get(item.question.id))) await dbV7.questions.put(item.question);
      await saveMembershipInTx(item.membership);
    }
    for (const note of materialisedNotes) await dbV7.notes.put(note);
    const refreshed = await refreshBankQuestionCountInTx(bank.id);
    if (refreshed) await dbV7.banks.put({ ...refreshed, updatedAt: timestamp, deviceId });
    const bankSnapshot = (await dbV7.banks.get(bank.id))!;
    // A single atomic import change-set. The sync layer offloads any body that
    // exceeds the v7 inline-event budget to a content-addressed immutable
    // object, so a large import no longer needs to be split into byte-bounded
    // chunks here; the whole import applies atomically on every device.
    await enqueueChangeSetV7([{ kind: "question.import", bank: bankSnapshot, questions: materialised.map((item) => item.question), memberships: materialised.map((item) => item.membership) }], timestamp);
    if (materialisedNotes.length) {
      // Imported notes publish as a follow-up batch; the queue planner orders
      // them after question.import because each note depends on its question.
      await enqueueChangeSetV7(materialisedNotes.map((note) => ({ kind: "note.upserted" as const, note })), timestamp);
    }
  });
  const imported = await dbV7.banks.get(bank.id);
  return { ...imported!, importedCount: materialised.filter((item) => item.isNewMembership).length };
}

export const importTextJsonBankV7 = importQuestionBankV7;
export const importBankV7 = importQuestionBankV7;

export async function saveNoteV7(questionId: string, content: string): Promise<NoteV7> {
  const old = await dbV7.notes.get(questionId);
  const timestamp = nowIso();
  const note: NoteV7 = {
    questionId,
    content,
    revision: (old?.revision ?? 0) + 1,
    updatedAt: timestamp,
    deviceId: getV7DeviceId(),
  };
  if (old?.content === content) return old;
  await dbV7.transaction("rw", [dbV7.notes, dbV7.changeSets], async () => {
    await dbV7.notes.put(note);
    const pendingChange = await dbV7.changeSets.where("state").equals("pending").filter((record) => record.mutations.some((mutation) => mutation.kind === "note.upserted" && mutation.note.questionId === questionId)).first();
    if (pendingChange) await dbV7.changeSets.delete(pendingChange.id);
    await enqueueChangeSetV7([{ kind: "note.upserted", note }], timestamp);
  });
  return note;
}

export const upsertNoteV7 = saveNoteV7;

export async function saveQuestionGroupV7(input: Pick<QuestionGroupV7, "name" | "type" | "description" | "items"> & { id?: string }): Promise<QuestionGroupV7> {
  const current = input.id ? await dbV7.questionGroups.get(input.id) : undefined;
  const name = input.name.trim();
  if (!name) throw new Error("请输入题组名称。");
  const items = input.items
    .filter((item, index, rows) => rows.findIndex((candidate) => candidate.questionId === item.questionId) === index)
    .map((item) => ({ questionId: item.questionId, note: item.note.trim() }));
  if (!items.length) throw new Error("题组至少需要一道题。");
  const existingQuestions = new Set((await dbV7.questions.bulkGet(items.map((item) => item.questionId))).filter(Boolean).map((question) => question!.id));
  if (items.some((item) => !existingQuestions.has(item.questionId))) throw new Error("题组包含不存在或已删除的题目。");
  const updatedAt = nowIso();
  const group: QuestionGroupV7 = {
    id: input.id ?? makeV7Id("group"),
    name,
    type: input.type,
    description: input.description.trim(),
    items,
    createdAt: current?.createdAt ?? updatedAt,
    updatedAt,
    deviceId: getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.questionGroups, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.questionGroups.put(group);
    await dbV7.tombstones.delete(tombstoneKey("questionGroup", group.id));
    await enqueueChangeSetV7([{ kind: "questionGroup.saved", group }], updatedAt);
  });
  return group;
}

export async function deleteQuestionGroupV7(groupId: string): Promise<boolean> {
  const current = await dbV7.questionGroups.get(groupId);
  if (!current) return false;
  const deletedAt = nowIso();
  const deviceId = getV7DeviceId();
  const eventId = makeV7Id("group-delete");
  const groupDeleteSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.questionGroups, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.questionGroups.delete(groupId);
    await dbV7.tombstones.put({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt, deviceId, eventId, sequence: groupDeleteSequence });
    await enqueueChangeSetV7([{ kind: "questionGroup.deleted", groupId, deletedAt }], deletedAt, { localSequence: groupDeleteSequence });
  });
  return true;
}

export async function toggleQuestionFavoriteV7(questionId: string): Promise<QuestionV7> {
  const current = await dbV7.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  return updateQuestionV7(questionId, { favorite: !current.favorite });
}
