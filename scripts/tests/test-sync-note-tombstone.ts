import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7-codec";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { BankV7, QuestionV7 } from "../../src/lib/db/v7-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV7 = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 1, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: QuestionV7 = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "题目 1" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" };
const note = { questionId: question.id, content: "初始解析", revision: 1, updatedAt: at, deviceId: "device-a" };

const base: ChangeSetProjectionV7 = {
  banks: [bank],
  bankFolders: [],
  questions: [question],
  memberships: [{ key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: at, updatedAt: at, deviceId: "device-a" }],
  imageAssets: [],
  attempts: [],
  attemptStats: [],
  attemptDailyStats: [],
  notes: [note],
  practiceRuns: [],
  practiceRunStats: [],
  questionGroups: [],
  reviewRounds: [],
  reviewRoundProgress: [],
  tombstones: [],
};

const deleteEvent = await createChangeSetV7({ id: "delete-note", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "note.deleted", questionId: question.id, deletedAt: at } });
const afterDelete = reduceChangeSetV7(base, deleteEvent);
assert.equal(afterDelete.notes.length, 0, "删除后解析应被移除");

// 陈旧设备未拉到删除事件，仍带着旧解析同步回来。note.deleted 当前没有写墓碑，
// 这条陈旧 upsert 会成功执行，让已删除解析复活——这是一个 bug。
const staleUpsert = await createChangeSetV7({ id: "stale-note", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "note.upserted", note: { ...note, content: "陈旧解析", revision: 2, deviceId: "device-b" } } });
assert.throws(() => reduceChangeSetV7(afterDelete, staleUpsert), /已被删除|conflict|墓碑|不存在/, "陈旧解析不应复活已删除的解析");

console.log("sync note tombstone tests passed");
