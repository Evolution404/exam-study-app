import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { BankV6, QuestionV6 } from "../../src/lib/db/v6-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV6 = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 1, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: QuestionV6 = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "题目 1" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" };
const answer = { selected: ["A"], submitted: true, correct: true, updatedAt: at, deviceId: "device-a" };
const attempt = { id: "attempt-1", runId: "run-1", questionId: question.id, selected: "A", correct: true, elapsedMs: 1000, createdAt: at, deviceId: "device-a" };
const run = {
  id: "run-1",
  bankId: bank.id,
  bankIds: [bank.id],
  bankName: bank.name,
  mode: "sequential" as const,
  modeLabel: "全量顺序练习",
  questionIds: [question.id],
  questionTypes: { [question.id]: "单选" as const },
  answers: { [question.id]: answer },
  shuffleOptions: false,
  optionOrders: {},
  startedAt: at,
  updatedAt: at,
  status: "in_progress" as const,
  revision: 1,
};

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
  practiceRuns: [run],
  practiceRunStats: [],
  questionGroups: [],
  reviewRounds: [],
  reviewRoundProgress: [],
  tombstones: [],
};

const deleteAnswer = await createChangeSetV7({ id: "delete-answer", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "practice.answer.deleted", attemptId: attempt.id, runId: run.id, questionId: question.id, deletedAt: at } });
const afterDelete = reduceChangeSetV7(base, deleteAnswer);
assert.equal(afterDelete.attempts.length, 0, "删除答案后作答记录应被移除");

// 陈旧设备未拉到删除事件，仍带着同 attempt id 的 submitted 同步回来。
// practice.answer.deleted 没有写 attempt 墓碑，所以这条陈旧提交会复活作答记录。
const staleSubmit = await createChangeSetV7({ id: "stale-submit", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "practice.answer.submitted", attempt: { ...attempt, deviceId: "device-b" }, answer: { ...answer, deviceId: "device-b" }, runId: run.id, questionId: question.id } });
assert.throws(() => reduceChangeSetV7(afterDelete, staleSubmit), /已被删除|conflict|墓碑|不存在/, "陈旧 practice.answer.submitted 不应复活已删除的作答记录");

console.log("sync practice answer tombstone tests passed");
