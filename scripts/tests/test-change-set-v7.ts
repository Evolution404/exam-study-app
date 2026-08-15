import assert from "node:assert/strict";
import type { PracticeAnswerV6 } from "../../lib/db-v6";
import type { AttemptV6, BankFolderV6, BankQuestionMembership, BankV6, PracticeRunV6, QuestionV6, ReviewRound } from "../../lib/v6-types";
import {
  assertClaimedBatchDigestV7,
  createChangeSetV7,
  createClaimedBatchV7,
  digestChangeSetV7,
  planChangeSetQueueV7,
  summarizeChangeSetV7,
  validateChangeSetV7,
  verifyChangeSetDigestV7,
  type ChangeSetV7,
} from "../../lib/change-set-v7";
import {
  reduceChangeSetV7,
  recomputeChangeSetProjectionV7,
  type ChangeSetProjectionV7,
} from "../../lib/change-set-v7-projection";

const at = "2026-08-01T00:00:00.000Z";
const deviceId = "device-test";
const bank = (id: string, name = id): BankV6 => ({ id, name, sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId });
const question = (id: string): QuestionV6 => ({
  id, type: "单选", content: [{ id: `${id}-stem`, type: "text", text: `题目 ${id}` }], options: [[{ id: `${id}-a`, type: "text", text: "A" }]], answer: "A", tags: [], favorite: false, contentFingerprint: id, updatedAt: at, deviceId,
});
const membership = (bankId: string, questionId: string): BankQuestionMembership => ({ key: `${bankId}:${questionId}`, bankId, questionId, sortOrder: 0, addedAt: at, updatedAt: at, deviceId });
const folder: BankFolderV6 = { id: "folder-1", name: "文件夹", description: "", sortOrder: 0, createdAt: at, updatedAt: at, deviceId };
const emptyProjection = (): ChangeSetProjectionV7 => ({ banks: [], bankFolders: [], questions: [], memberships: [], imageAssets: [], attempts: [], attemptStats: [], attemptDailyStats: [], notes: [], practiceRuns: [], practiceRunStats: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [] });
let sequence = 0;
async function cs(mutations: Parameters<typeof createChangeSetV7>[0]["mutations"]): Promise<ChangeSetV7> {
  return createChangeSetV7({ deviceId, localSequence: ++sequence, createdAt: at, mutations });
}

let projection = emptyProjection();
const base = await cs([
  { kind: "bank.create", bank: bank("bank-1", "题库") },
  { kind: "question.upsert", question: question("question-1") },
  { kind: "membership.save", membership: membership("bank-1", "question-1") },
]);
assert.equal(base.kind, "batch");
assert.equal(validateChangeSetV7(base), true);
assert.equal(await verifyChangeSetDigestV7(base), true);
assert.match(summarizeChangeSetV7(base), /批量操作/);
projection = reduceChangeSetV7(projection, base);
assert.equal(projection.banks[0].questionCount, 1);

// Re-importing the same deterministic bank and sharing an existing global
// question must remain atomic and idempotent across devices.
let imported = emptyProjection();
imported = reduceChangeSetV7(imported, await cs([{ kind: "question.import", bank: bank("import-bank", "导入题库"), questions: [question("shared-question")], memberships: [membership("import-bank", "shared-question")] }]));
imported = reduceChangeSetV7(imported, await cs([{ kind: "question.import", bank: { ...bank("import-bank", "导入题库（更新）"), questionCount: 2 }, questions: [question("shared-question"), question("new-question")], memberships: [membership("import-bank", "shared-question"), membership("import-bank", "new-question")] }]));
assert.equal(imported.banks.length, 1);
assert.equal(imported.questions.length, 2);
assert.equal(imported.memberships.length, 2);
assert.equal(imported.banks[0].questionCount, 2);

// Folder/image/group/note/review/run families all have strict references.
projection = reduceChangeSetV7(projection, await cs([
  { kind: "bankFolder.save", folder },
  { kind: "bank.update", bank: { ...projection.banks[0], folderId: folder.id, updatedAt: at } },
  { kind: "image.asset.save", asset: { id: "a".repeat(64), mimeType: "image/png", size: 3, width: 1, height: 1 } },
  { kind: "note.upserted", note: { questionId: "question-1", content: "解析", revision: 1, updatedAt: at, deviceId } },
  { kind: "questionGroup.saved", group: { id: "group-1", name: "组", type: "专题", description: "", items: [{ questionId: "question-1", note: "" }], createdAt: at, updatedAt: at, deviceId } },
]));
const round: ReviewRound = { id: "round-1", name: "第一轮", bankIds: ["bank-1"], startedAt: at, status: "active", createdAt: at, updatedAt: at, deviceId };
const run: PracticeRunV6 = { id: "run-1", bankId: "bank-1", bankIds: ["bank-1"], bankName: "题库", mode: "sequential", modeLabel: "练习", questionIds: ["question-1"], questionTypes: { "question-1": "单选" }, answers: {}, shuffleOptions: false, optionOrders: {}, startedAt: at, updatedAt: at, status: "in_progress", revision: 0, reviewRoundId: round.id };
projection = reduceChangeSetV7(projection, await cs([{ kind: "review.round.saved", round }, { kind: "practice.run.saved", run }]));
const attempt = (id: string, correct: boolean): AttemptV6 => ({ id, runId: run.id, questionId: "question-1", selected: correct ? "A" : "B", correct, elapsedMs: 10, createdAt: at, deviceId });
const answer = (eventId: string, correct: boolean): PracticeAnswerV6 => ({ selected: [correct ? "A" : "B"], submitted: true, correct, updatedAt: at, deviceId, eventId });
projection = reduceChangeSetV7(projection, await cs([{ kind: "practice.answer.submitted", attempt: attempt("attempt-1", false), answer: answer("event-1", false), runId: run.id, questionId: "question-1", reviewRoundId: round.id }]));
assert.deepEqual(projection.attemptStats[0], { questionId: "question-1", total: 1, correct: 0, wrong: 1, giveUps: 0, totalElapsedMs: 10, firstAttemptAt: at, firstAttemptCorrect: false, latestAttemptAt: at, hasBeenWrong: true, correctStreakAfterWrong: 0, currentCorrectStreak: 0, recentOutcomes: [{ id: "attempt-1", createdAt: at, correct: false }] });
assert.equal(projection.reviewRoundProgress[0].wrong, 1);
projection = reduceChangeSetV7(projection, await cs([{ kind: "practice.answer.updated", attempt: attempt("attempt-1", true), answer: answer("event-2", true), runId: run.id, questionId: "question-1", reviewRoundId: round.id }]));
assert.equal(projection.attemptStats[0].correct, 1);
projection = reduceChangeSetV7(projection, await cs([{ kind: "practice.answer.deleted", attemptId: "attempt-1", runId: run.id, questionId: "question-1", reviewRoundId: round.id }]));
assert.equal(projection.attemptStats.length, 0);
assert.equal(projection.reviewRoundProgress.length, 0);

// Split, delete/cascade blockers and deterministic unordered bulk input.
const cloneQuestion = { ...question("question-2"), id: "question-2" };
projection = reduceChangeSetV7(projection, await cs([{ kind: "question.split", originalQuestionId: "question-1", clone: cloneQuestion, memberships: [membership("bank-1", "question-2")], deletedMembershipKeys: ["bank-1:question-1"] }]));
const conflictingSplit = await cs([{ kind: "question.split", originalQuestionId: "question-1", clone: cloneQuestion, memberships: [] }]);
await assert.rejects(async () => reduceChangeSetV7(projection, conflictingSplit), /已存在/);
const blockedDelete = await cs([{ kind: "question.delete", questionId: "question-2" }]);
await assert.rejects(async () => reduceChangeSetV7(projection, blockedDelete), /cascade/);
projection = reduceChangeSetV7(projection, await cs([{ kind: "question.delete.cascade", questionId: "question-2" }]));
assert.equal(projection.questions.some((item) => item.id === "question-2"), false);

const unorderedA = await cs([{ kind: "question.bulk.upsert", questions: [question("z"), question("a")] }]);
const unorderedB = await cs([{ kind: "question.bulk.upsert", questions: [question("a"), question("z")] }]);
assert.equal(await digestChangeSetV7({ ...unorderedA, id: "same", localSequence: 99 }), await digestChangeSetV7({ ...unorderedB, id: "same", localSequence: 99 }), "bulk ordering is canonical");
const plan = await planChangeSetQueueV7([base]);
assert.equal(plan.blockers.length, 0);
const danglingMembership = await cs([{ kind: "membership.save", membership: membership("missing-bank", "missing-question") }]);
const danglingPlan = await planChangeSetQueueV7([danglingMembership]);
assert.equal(danglingPlan.blockers.some((blocker) => blocker.code === "missing-dependency"), true);

const claim = await createClaimedBatchV7("claim-1", [base]);
await assert.rejects(() => assertClaimedBatchDigestV7({ ...claim, digest: "0".repeat(64) }, [base]), /mismatch/);
assert.equal(await verifyChangeSetDigestV7({ ...base, digest: "0".repeat(64) }), false, "digest tamper rejected");
assert.equal(recomputeChangeSetProjectionV7(projection).banks[0].questionCount, projection.banks[0].questionCount);

console.log("v7 change-set tests passed: mutations, projection recomputation, conflicts, queue dependencies and digest claims");
