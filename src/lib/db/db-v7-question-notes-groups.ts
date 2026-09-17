/** Personal note and question-group persistence operations. */
import {
  dbV7,
  getV7DeviceId,
  makeV7Id,
  nextV7Sequence,
  nowIso,
  tombstoneKey,
} from "./db-v7-core";
import { enqueueChangeSetV7 } from "./db-v7-change-sets";
import type { NoteV7, QuestionGroupItemV7, QuestionGroupRecordV7, QuestionGroupV7 } from "./v7-types";

export async function hydrateQuestionGroupsV7(records: readonly QuestionGroupRecordV7[]): Promise<QuestionGroupV7[]> {
  if (!records.length) return [];
  const ids = records.map((record) => record.id);
  const items = await dbV7.questionGroupItems.where("groupId").anyOf(ids).toArray();
  const byGroup = new Map<string, QuestionGroupItemV7[]>();
  for (const item of items) {
    const bucket = byGroup.get(item.groupId) ?? [];
    bucket.push(item);
    byGroup.set(item.groupId, bucket);
  }
  return records.map((record) => ({
    ...record,
    items: (byGroup.get(record.id) ?? [])
      .sort((left, right) => left.position - right.position || left.questionId.localeCompare(right.questionId))
      .map((item) => ({ questionId: item.questionId, note: item.note ?? "" })),
  }));
}

export async function listQuestionGroupsV7(): Promise<QuestionGroupV7[]> {
  return hydrateQuestionGroupsV7(await dbV7.questionGroups.orderBy("updatedAt").reverse().toArray());
}

export async function saveNoteV7(questionId: string, content: string): Promise<NoteV7> {
  return dbV7.transaction("rw", [dbV7.notes, dbV7.changeSets, dbV7.syncMeta], async () => {
    const old = await dbV7.notes.get(questionId);
    if (old?.content === content) return old;
    const timestamp = nowIso();
    const note: NoteV7 = {
      questionId,
      content,
      revision: (old?.revision ?? 0) + 1,
      updatedAt: timestamp,
      deviceId: getV7DeviceId(),
    };
    await dbV7.notes.put(note);
    const pendingChange = await dbV7.changeSets.where("state").equals("pending").filter((record) => record.mutations.some((mutation) => mutation.kind === "note.upserted" && mutation.note.questionId === questionId)).first();
    if (pendingChange) await dbV7.changeSets.delete(pendingChange.id);
    await enqueueChangeSetV7([{ kind: "note.upserted", note }], timestamp);
    return note;
  });
}

export const upsertNoteV7 = saveNoteV7;

export async function saveQuestionGroupV7(input: Pick<QuestionGroupV7, "name" | "type" | "description" | "items"> & { id?: string }): Promise<QuestionGroupV7> {
  const name = input.name.trim();
  if (!name) throw new Error("请输入题组名称。");
  const items = input.items
    .filter((item, index, rows) => rows.findIndex((candidate) => candidate.questionId === item.questionId) === index)
    .map((item) => ({ questionId: item.questionId, note: item.note.trim() }));
  if (!items.length) throw new Error("题组至少需要一道题。");
  return dbV7.transaction("rw", [dbV7.questions, dbV7.questionGroups, dbV7.questionGroupItems, dbV7.tombstones, dbV7.changeSets, dbV7.syncMeta], async () => {
    const current = input.id ? await dbV7.questionGroups.get(input.id) : undefined;
    const existingQuestions = new Set((await dbV7.questions.bulkGet(items.map((item) => item.questionId))).filter(Boolean).map((question) => question!.id));
    if (items.some((item) => !existingQuestions.has(item.questionId))) throw new Error("题组包含不存在或已删除的题目。");
    const updatedAt = nowIso();
    const groupRecord = {
      id: input.id ?? makeV7Id("group"),
      name,
      type: input.type,
      description: input.description.trim(),
      createdAt: current?.createdAt ?? updatedAt,
      updatedAt,
      deviceId: getV7DeviceId(),
    };
    const groupItems: QuestionGroupItemV7[] = items.map((item, position) => ({
      groupId: groupRecord.id,
      questionId: item.questionId,
      position,
      ...(item.note ? { note: item.note } : {}),
    }));
    await dbV7.questionGroups.put(groupRecord);
    await dbV7.questionGroupItems.where("groupId").equals(groupRecord.id).delete();
    await dbV7.questionGroupItems.bulkPut(groupItems);
    await dbV7.tombstones.delete(tombstoneKey("questionGroup", groupRecord.id));
    const group: QuestionGroupV7 = { ...groupRecord, items };
    await enqueueChangeSetV7([{ kind: "questionGroup.saved", group }], updatedAt);
    return group;
  });
}

export async function deleteQuestionGroupV7(groupId: string): Promise<boolean> {
  return dbV7.transaction("rw", [dbV7.questionGroups, dbV7.questionGroupItems, dbV7.tombstones, dbV7.changeSets, dbV7.syncMeta], async () => {
    const current = await dbV7.questionGroups.get(groupId);
    if (!current) return false;
    const deletedAt = nowIso();
    const deviceId = getV7DeviceId();
    const eventId = makeV7Id("group-delete");
    const groupDeleteSequence = await nextV7Sequence(deviceId);
    await dbV7.questionGroups.delete(groupId);
    await dbV7.questionGroupItems.where("groupId").equals(groupId).delete();
    await dbV7.tombstones.put({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt, deviceId, eventId, sequence: groupDeleteSequence });
    await enqueueChangeSetV7([{ kind: "questionGroup.deleted", groupId, deletedAt }], deletedAt, { localSequence: groupDeleteSequence });
    return true;
  });
}
