import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { BankV7, QuestionV7 } from "../../src/lib/db/v7-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV7 = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 1, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: QuestionV7 = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "题目 1" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" };
const membership = { key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: at, updatedAt: at, deviceId: "device-a" };

const base: ChangeSetProjectionV7 = {
  banks: [bank],
  bankFolders: [],
  questions: [question],
  memberships: [membership],
  imageAssets: [],
  attempts: [],
  attemptStats: [],
  attemptDailyStats: [],
  notes: [],
  practiceRuns: [],
  practiceRunStats: [],
  questionGroups: [],
  reviewRounds: [],
  reviewRoundProgress: [],
  tombstones: [],
};

const removeEvent = await createChangeSetV7({ id: "remove-membership", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "membership.remove", bankId: "bank-1", questionId: "question-1", removedAt: at } });
const afterRemove = reduceChangeSetV7(base, removeEvent);
assert.equal(afterRemove.memberships.length, 0, "移除后题库关系应被删除");

// 陈旧设备未拉到移除事件，仍带着同 key 的 membership.save 同步回来。membership.save
// 没有检查 membership 墓碑，会复活已移除的题库关系。
const staleSave = await createChangeSetV7({ id: "stale-membership", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "membership.save", membership: { ...membership, deviceId: "device-b", sortOrder: 1 } } });
assert.throws(() => reduceChangeSetV7(afterRemove, staleSave), /已被删除|conflict|墓碑|不存在/, "陈旧 membership.save 不应复活已移除的题库关系");

console.log("sync membership tombstone tests passed");
