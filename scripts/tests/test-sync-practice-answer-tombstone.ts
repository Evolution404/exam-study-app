import assert from "node:assert/strict";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import { reduceChangeSet } from "../../src/lib/sync/change-set-projection";
import type { Bank, CanonicalState, PracticeRunItem, PracticeRunRecord, PracticeRunSource, Question } from "../../src/lib/db/types";

const at = "2026-08-13T00:00:00.000Z";
const bank: Bank = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 1, importedAt: at, updatedAt: at, deviceId: "seed" };
const question: Question = { id: "question-1", type: "单选", content: [{ id: "stem-0", type: "text", text: "题目 1" }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fingerprint-1", updatedAt: at, deviceId: "device-a" } as Question;
const attempt = { id: "attempt-1", runId: "run-1", questionId: question.id, selected: "A", correct: true, elapsedMs: 1000, createdAt: at, deviceId: "device-a" };
const runRecord: PracticeRunRecord = {
  id: "run-1",
  mode: "sequential",
  modeLabel: "全量顺序练习",
  shuffleOptions: false,
  startedAt: at,
  updatedAt: at,
  status: "in_progress",
  revision: 1,
  bankNameSnapshot: bank.name,
  activityAt: at,
};
const source: PracticeRunSource = { runId: runRecord.id, bankId: bank.id, bankNameSnapshot: bank.name, position: 0 };
const submittedItem: PracticeRunItem = {
  runId: runRecord.id,
  questionId: question.id,
  position: 0,
  questionTypeSnapshot: "单选",
  optionOrder: [],
  submittedAttemptId: attempt.id,
};

const base: CanonicalState = {
  banks: [bank],
  bankFolders: [],
  questions: [question],
  memberships: [{ key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: at, updatedAt: at, deviceId: "device-a" }],
  imageAssets: [],
  attempts: [attempt],
  notes: [],
  practiceRuns: [runRecord],
  practiceRunSources: [source],
  practiceRunItems: [submittedItem],
  questionGroups: [],
  questionGroupItems: [],
  reviewRounds: [],
  reviewRoundBanks: [],
  reviewRoundItems: [],
  tombstones: [],
};

const clearedItem: PracticeRunItem = { ...submittedItem, submittedAttemptId: undefined };
const afterDeleteRecord: PracticeRunRecord = { ...runRecord, revision: 2 };
const deleteAnswer = await createChangeSet({
  id: "delete-answer",
  deviceId: "device-a",
  localSequence: 1,
  createdAt: at,
  mutation: { kind: "practice.answer.deleted", attemptId: attempt.id, runRecord: afterDeleteRecord, item: clearedItem, deletedAt: at },
});
const afterDelete = reduceChangeSet(base, deleteAnswer);
assert.equal(afterDelete.attempts.length, 0, "删除答案后作答记录应被移除");
assert.equal(afterDelete.practiceRunItems[0]?.submittedAttemptId, undefined, "删除答案后 canonical item 不再引用已删除 attempt");

const staleSubmit = await createChangeSet({
  id: "stale-submit",
  deviceId: "device-b",
  localSequence: 1,
  createdAt: at,
  mutation: {
    kind: "practice.answer.submitted",
    attempt: { ...attempt, deviceId: "device-b" },
    runRecord: { ...runRecord, revision: 2 },
    item: { ...submittedItem },
  },
});
assert.throws(() => reduceChangeSet(afterDelete, staleSubmit), /已被删除|conflict|墓碑|不存在/, "陈旧 practice.answer.submitted 不应复活已删除的作答记录");

console.log("sync practice answer tombstone tests passed");
