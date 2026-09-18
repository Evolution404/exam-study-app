import assert from "node:assert/strict";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import { reduceChangeSet } from "../../src/lib/sync/change-set-projection";
import type { Bank, CanonicalState, Question, QuestionGroupItem, QuestionGroupRecord } from "../../src/lib/db/types";

const at = "2026-08-13T00:00:00.000Z";
const bank: Bank = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 1, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: Question = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "题目 1" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" } as Question;
const record: QuestionGroupRecord = { id: "group-1", name: "题组", type: "专题", description: "", createdAt: at, updatedAt: at, deviceId: "device-a" };
const item: QuestionGroupItem = { groupId: record.id, questionId: question.id, position: 0 };

const base: CanonicalState = {
  banks: [bank],
  bankFolders: [],
  questions: [question],
  memberships: [{ key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: at, updatedAt: at, deviceId: "device-a" }],
  imageAssets: [],
  attempts: [],
  notes: [],
  practiceRuns: [],
  practiceRunSources: [],
  practiceRunItems: [],
  questionGroups: [record],
  questionGroupItems: [item],
  reviewRounds: [],
  reviewRoundBanks: [],
  reviewRoundItems: [],
  tombstones: [],
};

const deleteGroup = await createChangeSet({ id: "delete-group", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "questionGroup.deleted", groupId: record.id, deletedAt: at } });
const afterDelete = reduceChangeSet(base, deleteGroup);
const staleSave = await createChangeSet({
  id: "stale-group",
  deviceId: "device-b",
  localSequence: 1,
  createdAt: at,
  mutation: { kind: "questionGroup.saved", record: { ...record, deviceId: "device-b" }, items: [{ ...item }] },
});
assert.throws(() => reduceChangeSet(afterDelete, staleSave), /已被删除|conflict|墓碑|不存在/, "题组删除后陈旧保存不得复活");

console.log("sync questionGroup tombstone tests passed");
