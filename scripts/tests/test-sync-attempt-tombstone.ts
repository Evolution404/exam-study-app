import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { BankV6, QuestionV6 } from "../../src/lib/db/v6-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV6 = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 1, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: QuestionV6 = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "题目 1" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" };
const attempt = { id: "attempt-1", runId: "run-1", questionId: question.id, selected: "A", correct: true, elapsedMs: 1000, createdAt: at, deviceId: "device-a" };

const base: ChangeSetProjectionV7 = {
  banks: [bank],
  bankFolders: [],
  questions: [question],
  memberships: [{ key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: at, updatedAt: at, deviceId: "device-a" }],
  imageAssets: [],
  attempts: [attempt],
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

const deleteEvent = await createChangeSetV7({ id: "delete-attempt", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "attempt.delete", attemptId: attempt.id, deletedAt: at } });
const afterDelete = reduceChangeSetV7(base, deleteEvent);
assert.equal(afterDelete.attempts.length, 0, "删除后作答记录应被移除");

// 陈旧设备未拉到删除事件，仍带着同 id 的 attempt.create 同步回来。attempt.delete
// 没有写墓碑，attempt.create 也不检查墓碑，这条陈旧变更会成功执行并复活已删除记录。
const staleCreate = await createChangeSetV7({ id: "stale-attempt", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "attempt.create", attempt: { ...attempt, deviceId: "device-b", elapsedMs: 900 } } });
assert.throws(() => reduceChangeSetV7(afterDelete, staleCreate), /已被删除|conflict|墓碑|不存在/, "陈旧 attempt.create 不应复活已删除的作答记录");

console.log("sync attempt tombstone tests passed");
