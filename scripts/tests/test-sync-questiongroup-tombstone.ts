import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7-codec";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { BankV7, QuestionV7 } from "../../src/lib/db/v7-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV7 = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 1, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: QuestionV7 = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "题目 1" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" };
const group = { id: "group-1", name: "题组", description: "", items: [{ questionId: question.id }], sortOrder: 0, createdAt: at, updatedAt: at, deviceId: "device-a" };

const base: ChangeSetProjectionV7 = {
  banks: [bank], bankFolders: [], questions: [question],
  memberships: [{ key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: at, updatedAt: at, deviceId: "device-a" }],
  imageAssets: [], attempts: [], attemptStats: [], attemptDailyStats: [], notes: [], practiceRuns: [], practiceRunStats: [],
  questionGroups: [group], reviewRounds: [], reviewRoundProgress: [], tombstones: [],
};

const deleteGroup = await createChangeSetV7({ id: "delete-group", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "questionGroup.deleted", groupId: group.id, deletedAt: at } });
const afterDelete = reduceChangeSetV7(base, deleteGroup);
const staleSave = await createChangeSetV7({ id: "stale-group", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "questionGroup.saved", group: { ...group, deviceId: "device-b" } } });
assert.throws(() => reduceChangeSetV7(afterDelete, staleSave), /已被删除|conflict|墓碑|不存在/, "题组删除后陈旧保存不得复活");

console.log("sync questionGroup tombstone tests passed");
