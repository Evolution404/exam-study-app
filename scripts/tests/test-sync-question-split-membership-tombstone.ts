import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7-codec";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { BankV7, QuestionV7 } from "../../src/lib/db/v7-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV7 = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 2, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: QuestionV7 = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "原始题" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" };
const clone: QuestionV7 = { id: "question-2", type: "单选", content: [{ id: "stem-0", type: "text", text: "分裂题" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-2", updatedAt: at, deviceId: "device-a" };
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

const split = await createChangeSetV7({ id: "split", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "question.split", originalQuestionId: question.id, clone, memberships: [], deletedMembershipKeys: [membership.key] } });
const afterSplit = reduceChangeSetV7(base, split);
assert.equal(afterSplit.memberships.length, 0, "分裂后应移除原题库关系");

// 陈旧设备仍带着原 membership.save 同步回来。question.split 移除关系时没有写 membership 墓碑，
// 这条陈旧保存会重新把原题加回已移除的题库。
const staleSave = await createChangeSetV7({ id: "stale-save", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "membership.save", membership: { ...membership, deviceId: "device-b", sortOrder: 1 } } });
assert.throws(() => reduceChangeSetV7(afterSplit, staleSave), /已被删除|conflict|墓碑|不存在/, "question.split 移除的关系不应被陈旧 membership.save 复活");

console.log("sync question split membership tombstone tests passed");
