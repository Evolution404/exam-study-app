/** Personal note and question-group persistence operations. */
import {
  studyDb,
  getDeviceId,
  makeId,
  nextSequence,
  nowIso,
  tombstoneKey,
} from "./db-core";
import { enqueueChangeSet } from "./db-change-sets";
import type { Note, QuestionGroupItem, QuestionGroupRecord, QuestionGroup } from "./types";

export async function hydrateQuestionGroups(records: readonly QuestionGroupRecord[]): Promise<QuestionGroup[]> {
  if (!records.length) return [];
  const ids = records.map((record) => record.id);
  const items = await studyDb.questionGroupItems.where("groupId").anyOf(ids).toArray();
  const byGroup = new Map<string, QuestionGroupItem[]>();
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

export async function listQuestionGroups(): Promise<QuestionGroup[]> {
  return hydrateQuestionGroups(await studyDb.questionGroups.orderBy("updatedAt").reverse().toArray());
}

export async function saveNote(questionId: string, content: string): Promise<Note> {
  return studyDb.transaction("rw", [studyDb.notes, studyDb.changeSets, studyDb.syncMeta], async () => {
    const old = await studyDb.notes.get(questionId);
    if (old?.content === content) return old;
    const timestamp = nowIso();
    const note: Note = {
      questionId,
      content,
      revision: (old?.revision ?? 0) + 1,
      updatedAt: timestamp,
      deviceId: getDeviceId(),
    };
    await studyDb.notes.put(note);
    const pendingChange = await studyDb.changeSets.where("state").equals("pending").filter((record) => record.mutations.some((mutation) => mutation.kind === "note.upserted" && mutation.note.questionId === questionId)).first();
    if (pendingChange) await studyDb.changeSets.delete(pendingChange.id);
    await enqueueChangeSet([{ kind: "note.upserted", note }], timestamp);
    return note;
  });
}

export const upsertNote = saveNote;

export async function saveQuestionGroup(input: Pick<QuestionGroup, "name" | "type" | "description" | "items"> & { id?: string }): Promise<QuestionGroup> {
  const name = input.name.trim();
  if (!name) throw new Error("请输入题组名称。");
  const items = input.items
    .filter((item, index, rows) => rows.findIndex((candidate) => candidate.questionId === item.questionId) === index)
    .map((item) => ({ questionId: item.questionId, note: item.note.trim() }));
  if (!items.length) throw new Error("题组至少需要一道题。");
  return studyDb.transaction("rw", [studyDb.questions, studyDb.questionGroups, studyDb.questionGroupItems, studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta], async () => {
    const current = input.id ? await studyDb.questionGroups.get(input.id) : undefined;
    const existingQuestions = new Set((await studyDb.questions.bulkGet(items.map((item) => item.questionId))).filter(Boolean).map((question) => question!.id));
    if (items.some((item) => !existingQuestions.has(item.questionId))) throw new Error("题组包含不存在或已删除的题目。");
    const updatedAt = nowIso();
    const groupRecord = {
      id: input.id ?? makeId("group"),
      name,
      type: input.type,
      description: input.description.trim(),
      createdAt: current?.createdAt ?? updatedAt,
      updatedAt,
      deviceId: getDeviceId(),
    };
    const groupItems: QuestionGroupItem[] = items.map((item, position) => ({
      groupId: groupRecord.id,
      questionId: item.questionId,
      position,
      ...(item.note ? { note: item.note } : {}),
    }));
    await studyDb.questionGroups.put(groupRecord);
    await studyDb.questionGroupItems.where("groupId").equals(groupRecord.id).delete();
    await studyDb.questionGroupItems.bulkPut(groupItems);
    await studyDb.tombstones.delete(tombstoneKey("questionGroup", groupRecord.id));
    const group: QuestionGroup = { ...groupRecord, items };
    await enqueueChangeSet([{ kind: "questionGroup.saved", group }], updatedAt);
    return group;
  });
}

export async function deleteQuestionGroup(groupId: string): Promise<boolean> {
  return studyDb.transaction("rw", [studyDb.questionGroups, studyDb.questionGroupItems, studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta], async () => {
    const current = await studyDb.questionGroups.get(groupId);
    if (!current) return false;
    const deletedAt = nowIso();
    const deviceId = getDeviceId();
    const eventId = makeId("group-delete");
    const groupDeleteSequence = await nextSequence(deviceId);
    await studyDb.questionGroups.delete(groupId);
    await studyDb.questionGroupItems.where("groupId").equals(groupId).delete();
    await studyDb.tombstones.put({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt, deviceId, eventId, sequence: groupDeleteSequence });
    await enqueueChangeSet([{ kind: "questionGroup.deleted", groupId, deletedAt }], deletedAt, { localSequence: groupDeleteSequence });
    return true;
  });
}
