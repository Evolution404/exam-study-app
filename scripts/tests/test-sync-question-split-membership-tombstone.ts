import assert from "node:assert/strict";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import { reduceChangeSet } from "../../src/lib/sync/change-set-projection";
import type { CanonicalState } from "../../src/lib/db/types";
import type { Bank, Question } from "../../src/lib/db/types";

const at = "2026-08-13T00:00:00.000Z";
const bank: Bank = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 2, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: Question = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "原始题" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" };
const clone: Question = { id: "question-2", type: "单选", content: [{ id: "stem-0", type: "text", text: "分裂题" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-2", updatedAt: at, deviceId: "device-a" };
const membership = { key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: at, updatedAt: at, deviceId: "device-a" };

const base: CanonicalState = {
  banks: [bank],
  bankFolders: [],
  questions: [question],
  memberships: [membership],
  imageAssets: [],
  attempts: [],
  notes: [],
  practiceRuns: [],
  practiceRunSources: [],
  practiceRunItems: [],
  questionGroups: [],
  questionGroupItems: [],
  reviewRounds: [],
  reviewRoundBanks: [],
  reviewRoundItems: [],
  tombstones: [],
};

const split = await createChangeSet({ id: "split", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "question.split", originalQuestionId: question.id, clone, memberships: [], deletedMembershipKeys: [membership.key] } });
const afterSplit = reduceChangeSet(base, split);
assert.equal(afterSplit.memberships.length, 0, "分裂后应移除原题库关系");

// 陈旧设备仍带着原 membership.save 同步回来。question.split 移除关系时没有写 membership 墓碑，
// 这条陈旧保存会重新把原题加回已移除的题库。
const staleSave = await createChangeSet({ id: "stale-save", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "membership.save", membership: { ...membership, deviceId: "device-b", sortOrder: 1 } } });
assert.throws(() => reduceChangeSet(afterSplit, staleSave), /已被删除|conflict|墓碑|不存在/, "question.split 移除的关系不应被陈旧 membership.save 复活");

console.log("sync question split membership tombstone tests passed");
