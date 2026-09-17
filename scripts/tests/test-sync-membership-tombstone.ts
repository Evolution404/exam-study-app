import assert from "node:assert/strict";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import { reduceChangeSet, type ChangeSetProjection } from "../../src/lib/sync/change-set-projection";
import type { Bank, Question } from "../../src/lib/db/types";

const at = "2026-08-13T00:00:00.000Z";
const bank: Bank = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 1, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: Question = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "题目 1" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" };
const membership = { key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: at, updatedAt: at, deviceId: "device-a" };

const base: ChangeSetProjection = {
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

const removeEvent = await createChangeSet({ id: "remove-membership", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "membership.remove", bankId: "bank-1", questionId: "question-1", removedAt: at } });
const afterRemove = reduceChangeSet(base, removeEvent);
assert.equal(afterRemove.memberships.length, 0, "移除后题库关系应被删除");

// 陈旧设备未拉到移除事件，仍带着同 key 的 membership.save 同步回来。membership.save
// 没有检查 membership 墓碑，会复活已移除的题库关系。
const staleSave = await createChangeSet({ id: "stale-membership", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "membership.save", membership: { ...membership, deviceId: "device-b", sortOrder: 1 } } });
assert.throws(() => reduceChangeSet(afterRemove, staleSave), /已被删除|conflict|墓碑|不存在/, "陈旧 membership.save 不应复活已移除的题库关系");

console.log("sync membership tombstone tests passed");
