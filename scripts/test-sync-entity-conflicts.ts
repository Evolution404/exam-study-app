import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

type Bank = import("../lib/types").Bank;
type BankFolder = import("../lib/types").BankFolder;
type Note = import("../lib/types").Note;
type PracticeRun = import("../lib/types").PracticeRun;
type Question = import("../lib/types").Question;
type QuestionGroup = import("../lib/types").QuestionGroup;
type SyncEvent = import("../lib/types").SyncEvent;

const {
  applyRemoteEvents,
  createQuestion,
  db,
  deleteBank,
  deleteBankFolder,
  deleteQuestion,
  deleteQuestionGroup,
  resetLocalDatabase,
  saveBank,
  saveBankFolder,
  saveNote,
  saveQuestionGroup,
  updateQuestion,
} = await import("../lib/db");

const bank: Bank = {
  id: "conflict-bank",
  name: "送电线路工-初级工",
  displayName: "冲突测试题库",
  questionCount: 2,
  importedAt: "2026-01-01T00:00:00.000Z",
};
const folder: BankFolder = {
  id: "conflict-folder",
  name: "原始文件夹",
  description: "原始描述",
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deviceId: "seed-device",
};
const question: Question = {
  id: "conflict-question",
  bankId: bank.id,
  bankName: bank.name,
  stem: "原始题目",
  normalizedStem: "原始题目",
  answer: "A",
  options: ["甲", "乙"],
  type: "单选",
  tags: ["原始"],
};
const secondQuestion: Question = { ...question, id: "conflict-question-2", stem: "第二道题", normalizedStem: "第二道题" };

function event(input: Omit<SyncEvent, "sequence" | "synced">, sequence: number): SyncEvent {
  return { ...input, sequence, synced: 1 };
}

function bankUpdate(id: string, input: Partial<Bank>, updatedAt: string, deviceId: string, sequence: number): SyncEvent {
  return event({
    id,
    type: "bank.updated",
    payload: { ...bank, ...input, updatedAt, deviceId },
    deviceId,
    createdAt: updatedAt,
  }, sequence);
}

function folderSave(id: string, input: Partial<BankFolder>, updatedAt: string, deviceId: string, sequence: number): SyncEvent {
  return event({
    id,
    type: "bankFolder.saved",
    payload: { ...folder, ...input, updatedAt, deviceId },
    deviceId,
    createdAt: updatedAt,
  }, sequence);
}

function questionUpdate(id: string, input: Partial<Question>, updatedAt: string, deviceId: string, sequence: number, type: SyncEvent["type"] = "question.updated"): SyncEvent {
  return event({
    id,
    type,
    payload: { ...question, ...input, userUpdatedAt: updatedAt, userUpdatedBy: deviceId },
    deviceId,
    createdAt: updatedAt,
  }, sequence);
}

function noteUpdate(id: string, content: string, updatedAt: string, deviceId: string, sequence: number): SyncEvent {
  const payload: Note = { questionId: question.id, content, revision: 1, updatedAt, deviceId };
  return event({ id, type: "note.upserted", payload, deviceId, createdAt: updatedAt }, sequence);
}

function groupSave(id: string, input: Partial<QuestionGroup>, updatedAt: string, deviceId: string, sequence: number): SyncEvent {
  const payload: QuestionGroup = {
    id,
    name: "冲突题组",
    type: "自定义",
    description: "",
    items: [{ questionId: question.id, note: "原始" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    deviceId,
    ...input,
  };
  return event({ id, type: "questionGroup.saved", payload, deviceId, createdAt: updatedAt }, sequence);
}

function runSave(id: string, updatedAt: string, revision: number, deviceId: string, sequence: number): SyncEvent {
  const payload: PracticeRun = {
    id,
    bankId: bank.id,
    bankIds: [bank.id],
    bankName: bank.name,
    mode: "random30",
    modeLabel: "冲突练习",
    questionIds: [question.id],
    questionTypes: { [question.id]: question.type },
    answers: {},
    shuffleOptions: false,
    optionOrders: {},
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    status: "in_progress",
    revision,
  };
  return event({ id: `run-save-${id}-${revision}`, type: "practice.run.saved", payload, deviceId, createdAt: updatedAt }, sequence);
}

async function seed() {
  await resetLocalDatabase();
  await db.banks.put(bank);
  await db.questions.bulkPut([question, secondQuestion]);
}

const old = "2026-02-01T10:00:00.000Z";
const current = "2026-02-02T10:00:00.000Z";
const newer = "2026-02-03T10:00:00.000Z";
const newest = "2026-02-04T10:00:00.000Z";
const sameTime = "2026-02-05T10:00:00.000Z";
const sameEventTime = "2026-02-06T10:00:00.000Z";

// Local CRUD emits the expected entity events and updates the related local state.
await seed();
await db.bankFolders.put(folder);
const localFolder = await saveBankFolder({ id: folder.id, name: "本地文件夹", description: "已更新" });
assert.equal(localFolder.name, "本地文件夹");
assert.ok((await db.events.where("synced").equals(0).toArray()).some((row) => row.type === "bankFolder.saved"));
const localBank = await saveBank(bank.id, { displayName: "本地题库", description: "已更新", color: "#123456", folderId: folder.id, sortOrder: 2 });
assert.equal(localBank.displayName, "本地题库");
assert.equal((await db.questions.get(question.id))?.bankName, "本地题库");
const createdQuestion = await createQuestion(bank.id, { stem: "本地新题", options: ["甲", "乙"], answer: "A", type: "单选", tags: ["新增"] });
assert.equal(createdQuestion.stem, "本地新题");
assert.equal((await db.banks.get(bank.id))?.questionCount, 3);
assert.ok((await db.events.where("synced").equals(0).toArray()).some((row) => row.type === "question.created"));
const localQuestion = await updateQuestion(question.id, { stem: "本地更新题", options: ["甲", "乙"], answer: "A", type: "单选", tags: ["本地"] });
assert.equal(localQuestion.stem, "本地更新题");
const localNote = await saveNote(question.id, "本地解析");
assert.equal(localNote.content, "本地解析");
const localGroup = await saveQuestionGroup({ name: "本地题组", type: "自定义", description: "", items: [{ questionId: question.id, note: "记忆" }] });
assert.equal((await db.questionGroups.get(localGroup.id))?.items.length, 1);
await deleteQuestionGroup(localGroup.id);
assert.equal(await db.questionGroups.get(localGroup.id), undefined);
await deleteBankFolder(folder.id);
assert.equal(await db.bankFolders.get(folder.id), undefined);
assert.equal((await db.banks.get(bank.id))?.folderId, undefined);
await deleteQuestion(question.id);
assert.equal(await db.questions.get(question.id), undefined);
await deleteBank(bank.id);
assert.equal(await db.banks.get(bank.id), undefined);

// Bank updates are LWW by updatedAt, then deviceId, then event id. Arrival order
// must not matter for older writes or same-time ties.
await seed();
await applyRemoteEvents([bankUpdate("bank-new", { displayName: "较新" }, newer, "device-a", 1)]);
await applyRemoteEvents([bankUpdate("bank-old", { displayName: "较旧" }, old, "device-z", 2)]);
assert.equal((await db.banks.get(bank.id))?.displayName, "较新");
await applyRemoteEvents([
  bankUpdate("bank-tie-z", { displayName: "设备 z" }, sameTime, "device-z", 3),
  bankUpdate("bank-tie-a", { displayName: "设备 a" }, sameTime, "device-a", 4),
]);
assert.equal((await db.banks.get(bank.id))?.displayName, "设备 z", "same-time bank update must use deviceId tie-break");
await applyRemoteEvents([
  bankUpdate("bank-id-z", { displayName: "事件 z" }, sameEventTime, "device-same", 5),
  bankUpdate("bank-id-a", { displayName: "事件 a" }, sameEventTime, "device-same", 6),
]);
assert.equal((await db.banks.get(bank.id))?.displayName, "事件 z", "same-device bank update must use event id tie-break");

// A newer delete blocks older data, but a strictly newer update clears its tombstone.
await seed();
await applyRemoteEvents([event({ id: "bank-delete", type: "bank.deleted", payload: { id: bank.id, deletedAt: current }, deviceId: "delete-device", createdAt: current }, 10)]);
await applyRemoteEvents([bankUpdate("bank-stale-after-delete", { displayName: "旧复活" }, old, "device-old", 11)]);
assert.equal(await db.banks.get(bank.id), undefined, "older bank data must not revive a deleted bank");
assert.ok(await db.tombstones.get(`bank:${bank.id}`));
await applyRemoteEvents([bankUpdate("bank-revive", { displayName: "新版本" }, newer, "device-new", 12)]);
assert.equal((await db.banks.get(bank.id))?.displayName, "新版本");
assert.equal(await db.tombstones.get(`bank:${bank.id}`), undefined, "newer bank data must clear an old tombstone");

// A stale delete arriving after a newer bank update must not remove that update.
await seed();
await applyRemoteEvents([bankUpdate("bank-later-state", { displayName: "保留版本" }, newest, "device-new", 13)]);
await applyRemoteEvents([event({ id: "bank-stale-delete", type: "bank.deleted", payload: { id: bank.id, deletedAt: current }, deviceId: "device-old", createdAt: current }, 14)]);
assert.equal((await db.banks.get(bank.id))?.displayName, "保留版本", "stale bank deletion must not remove newer data");

// Folder CRUD and conflict resolution, including clearing a folder tombstone.
await seed();
await db.bankFolders.put(folder);
await db.banks.update(bank.id, { folderId: folder.id });
await applyRemoteEvents([folderSave("folder-new", { name: "新文件夹" }, newer, "device-a", 20)]);
await applyRemoteEvents([folderSave("folder-old", { name: "旧文件夹" }, old, "device-z", 21)]);
assert.equal((await db.bankFolders.get(folder.id))?.name, "新文件夹");
// Start the delete/revival sequence from the original folder version so the
// delete at `current` is actually newer than the data it removes.
await seed();
await db.bankFolders.put(folder);
await db.banks.update(bank.id, { folderId: folder.id });
await applyRemoteEvents([event({ id: "folder-delete", type: "bankFolder.deleted", payload: { id: folder.id, deletedAt: current }, deviceId: "delete-device", createdAt: current }, 22)]);
assert.equal(await db.bankFolders.get(folder.id), undefined);
assert.equal((await db.banks.get(bank.id))?.folderId, undefined);
await applyRemoteEvents([folderSave("folder-old-save", { name: "旧保存" }, old, "device-old", 23)]);
assert.equal(await db.bankFolders.get(folder.id), undefined, "older folder save must not revive deleted folder");
await applyRemoteEvents([folderSave("folder-revive", { name: "新保存" }, newest, "device-new", 24)]);
assert.equal((await db.bankFolders.get(folder.id))?.name, "新保存");
assert.equal(await db.tombstones.get(`bankFolder:${folder.id}`), undefined);
await applyRemoteEvents([event({ id: "folder-stale-delete", type: "bankFolder.deleted", payload: { id: folder.id, deletedAt: current }, deviceId: "device-old", createdAt: current }, 25)]);
assert.equal((await db.bankFolders.get(folder.id))?.name, "新保存", "stale folder deletion must not remove newer data");

// Question LWW, deletion/revival, and related bank count.
await seed();
await applyRemoteEvents([questionUpdate("question-new", { stem: "较新题", normalizedStem: "较新题" }, newer, "device-a", 30)]);
await applyRemoteEvents([questionUpdate("question-old", { stem: "较旧题", normalizedStem: "较旧题" }, old, "device-z", 31)]);
assert.equal((await db.questions.get(question.id))?.stem, "较新题");
await applyRemoteEvents([
  questionUpdate("question-tie-z", { stem: "设备 z 题", normalizedStem: "设备 z 题" }, sameTime, "device-z", 32),
  questionUpdate("question-tie-a", { stem: "设备 a 题", normalizedStem: "设备 a 题" }, sameTime, "device-a", 33),
]);
assert.equal((await db.questions.get(question.id))?.stem, "设备 z 题");
// Start the delete/revival sequence from the original question version so the
// delete at `current` is actually newer than the data it removes.
await seed();
await applyRemoteEvents([event({ id: "question-delete", type: "question.deleted", payload: { id: question.id, deletedAt: current }, deviceId: "delete-device", createdAt: current }, 34)]);
assert.equal(await db.questions.get(question.id), undefined);
assert.equal((await db.banks.get(bank.id))?.questionCount, 1);
await applyRemoteEvents([questionUpdate("question-old-revive", { stem: "旧复活题", normalizedStem: "旧复活题" }, old, "device-old", 35, "question.created")]);
assert.equal(await db.questions.get(question.id), undefined, "older question data must not revive a deleted question");
await applyRemoteEvents([questionUpdate("question-new-revive", { stem: "新复活题", normalizedStem: "新复活题" }, newest, "device-new", 36, "question.created")]);
assert.equal((await db.questions.get(question.id))?.stem, "新复活题");
assert.equal((await db.banks.get(bank.id))?.questionCount, 2, "newer question recreation must restore bank.questionCount");
assert.equal(await db.tombstones.get(`question:${question.id}`), undefined);
await applyRemoteEvents([questionUpdate("question-stale-delete", {}, current, "device-old", 37, "question.deleted")]);
assert.equal((await db.questions.get(question.id))?.stem, "新复活题", "stale question deletion must not remove newer data");

// Notes have no delete operation; empty content is a valid upsert. Their LWW
// ordering uses updatedAt, deviceId, and event id.
await seed();
await applyRemoteEvents([noteUpdate("note-new", "新解析", newer, "device-a", 40)]);
await applyRemoteEvents([noteUpdate("note-old", "旧解析", old, "device-z", 41)]);
assert.equal((await db.notes.get(question.id))?.content, "新解析");
await applyRemoteEvents([
  noteUpdate("note-tie-z", "设备 z 解析", sameTime, "device-z", 42),
  noteUpdate("note-tie-a", "设备 a 解析", sameTime, "device-a", 43),
]);
assert.equal((await db.notes.get(question.id))?.content, "设备 z 解析");
await applyRemoteEvents([noteUpdate("note-empty", "", sameEventTime, "device-new", 44)]);
assert.equal((await db.notes.get(question.id))?.content, "", "empty note content must remain a valid newest upsert");

// Question groups LWW and tombstone behavior. Missing question references are
// filtered, while a group with no remaining valid items is not materialized.
await seed();
await applyRemoteEvents([groupSave("group-new", { name: "新题组" }, newer, "device-a", 50)]);
await applyRemoteEvents([groupSave("group-old", { name: "旧题组" }, old, "device-z", 51)]);
assert.equal((await db.questionGroups.get("group-new"))?.name, "新题组");
await applyRemoteEvents([
  groupSave("group-tie-z", { name: "设备 z 题组" }, sameTime, "device-z", 52),
  groupSave("group-tie-a", { name: "设备 a 题组" }, sameTime, "device-a", 53),
]);
assert.equal((await db.questionGroups.get("group-new"))?.name, "新题组", "different event ids must not change a different group id");
const tieGroup = groupSave("group-new-z", { name: "设备 z 题组" }, sameTime, "device-z", 54);
const tieGroupA = groupSave("group-new-a", { name: "设备 a 题组" }, sameTime, "device-a", 55);
// Reuse the same entity id so this is an actual same-time tie.
tieGroup.payload = { ...(tieGroup.payload as QuestionGroup), id: "group-tie" };
tieGroupA.payload = { ...(tieGroupA.payload as QuestionGroup), id: "group-tie" };
await applyRemoteEvents([tieGroup, tieGroupA]);
assert.equal((await db.questionGroups.get("group-tie"))?.name, "设备 z 题组");
// Start the delete/revival sequence from an original group version so the
// delete at `current` is actually newer than the data it removes.
await seed();
await db.questionGroups.put({
  id: "group-tie", name: "原始题组", type: "自定义", description: "",
  items: [{ questionId: question.id, note: "原始" }], createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z", deviceId: "seed-device",
});
await applyRemoteEvents([event({ id: "group-delete", type: "questionGroup.deleted", payload: { id: "group-tie", deletedAt: current }, deviceId: "delete-device", createdAt: current }, 56)]);
assert.equal(await db.questionGroups.get("group-tie"), undefined);
await applyRemoteEvents([groupSave("group-old-revive", { id: "group-tie", name: "旧复活题组" }, old, "device-old", 57)]);
assert.equal(await db.questionGroups.get("group-tie"), undefined, "older question group data must not revive a deletion");
await applyRemoteEvents([groupSave("group-new-revive", { id: "group-tie", name: "新复活题组" }, newest, "device-new", 58)]);
assert.equal((await db.questionGroups.get("group-tie"))?.name, "新复活题组");
assert.equal(await db.tombstones.get("questionGroup:group-tie"), undefined);
await applyRemoteEvents([event({ id: "group-stale-delete", type: "questionGroup.deleted", payload: { id: "group-tie", deletedAt: current }, deviceId: "device-old", createdAt: current }, 59)]);
assert.equal((await db.questionGroups.get("group-tie"))?.name, "新复活题组", "stale question group deletion must not remove newer data");
await applyRemoteEvents([groupSave("group-missing-question", { id: "group-missing", items: [{ questionId: "missing", note: "" }] }, newest, "device-new", 60)]);
assert.equal(await db.questionGroups.get("group-missing"), undefined, "group with no valid question references must not be materialized");

// A newer practice-run save must survive an older delete event, just like the
// other LWW entities. A later delete remains destructive.
await seed();
await applyRemoteEvents([runSave("run-conflict", newer, 1, "device-a", 70)]);
await applyRemoteEvents([runSave("run-conflict", newest, 2, "device-a", 71)]);
await applyRemoteEvents([event({
  id: "run-stale-delete", type: "practice.run.deleted", payload: { id: "run-conflict", deletedAt: current },
  deviceId: "device-old", createdAt: current,
}, 72)]);
assert.equal((await db.practiceRuns.get("run-conflict"))?.revision, 2, "stale practice-run deletion must not remove newer data");
await applyRemoteEvents([event({
  id: "run-new-delete", type: "practice.run.deleted", payload: { id: "run-conflict", deletedAt: sameEventTime },
  deviceId: "device-new", createdAt: sameEventTime,
}, 73)]);
assert.equal(await db.practiceRuns.get("run-conflict"), undefined);

await db.delete();
console.log("sync entity-conflict tests passed: CRUD, LWW ties, tombstones, stale-delete protection and entity revival");
