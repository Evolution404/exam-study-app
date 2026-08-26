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
import type { NoteV7, QuestionGroupV7 } from "./v7-types";

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
  await dbV7.transaction("rw", [dbV7.notes, dbV7.changeSets, dbV7.syncMeta], async () => {
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
  await dbV7.transaction("rw", [dbV7.questionGroups, dbV7.tombstones, dbV7.changeSets, dbV7.syncMeta], async () => {
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
  const groupDeleteSequence = await nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.questionGroups, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.questionGroups.delete(groupId);
    await dbV7.tombstones.put({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt, deviceId, eventId, sequence: groupDeleteSequence });
    await enqueueChangeSetV7([{ kind: "questionGroup.deleted", groupId, deletedAt }], deletedAt, { localSequence: groupDeleteSequence });
  });
  return true;
}
