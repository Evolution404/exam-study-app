import assert from "node:assert/strict";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import { type ChangeSetMutationV7 } from "../../src/lib/sync/change-set-v7-types";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7-codec";
import type { BankV7, QuestionV7, PracticeRunV7, ReviewRound, ReviewRoundProgress } from "../../src/lib/db/v7-types";

const AT = "2026-08-13T00:00:00.000Z";
const device = "device-test";
let seq = 0;
const next = () => createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: undefined as never }).catch(() => { throw new Error("never"); });
void next;

const bank = (id: string): BankV7 => ({ id, name: id, sortOrder: 0, questionCount: 0, importedAt: AT, updatedAt: AT, deviceId: device });
const question = (id: string): QuestionV7 => ({
  id, type: "单选",
  content: [{ id: "stem-0", type: "text", text: `题 ${id}` }],
  options: [[{ id: "o-a", type: "text", text: "A" }], [{ id: "o-b", type: "text", text: "B" }]],
  answer: "A", tags: [], contentFingerprint: `fp-${id}`, updatedAt: AT, deviceId: device,
});
const membership = (bankId: string, questionId: string) => ({ key: `${bankId}:${questionId}`, bankId, questionId, sortOrder: 0, addedAt: AT, updatedAt: AT, deviceId: device });
const run = (id: string, bankId: string, questionIds: string[]): PracticeRunV7 => ({
  id, bankId, bankIds: [bankId], bankName: bankId, mode: "sequential", modeLabel: "练习",
  questionIds, questionTypes: Object.fromEntries(questionIds.map((q) => [q, "单选"] as const)),
  answers: {}, shuffleOptions: false, optionOrders: {}, startedAt: AT, updatedAt: AT,
  status: "in_progress", revision: 0, deviceId: device,
});
const round = (id: string, bankIds: string[]): ReviewRound => ({
  id, name: id, bankIds, startedAt: AT, status: "active", createdAt: AT, updatedAt: AT, deviceId: device,
});
const roundProgress = (roundId: string, questionId: string): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}`, roundId, questionId, attempts: 1, correct: 1, wrong: 0,
  firstAttemptAt: AT, latestAttemptAt: AT,
});

async function reduce(base: ChangeSetProjectionV7, mutation: ChangeSetMutationV7) {
  const change = await createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation });
  return reduceChangeSetV7(base, change);
}

const empty: ChangeSetProjectionV7 = {
  banks: [], bankFolders: [], questions: [], memberships: [], imageAssets: [],
  attempts: [], attemptStats: [], attemptDailyStats: [], notes: [], practiceRuns: [],
  practiceRunStats: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [],
};

// ---------------------------------------------------------------------------
// bank delete
// ---------------------------------------------------------------------------
{
  const base = structuredClone(empty);
  base.banks.push(bank("b1"), bank("b2"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"), membership("b2", "q1"));
  base.practiceRuns.push(run("r1", "b1", ["q1"]));

  // 非级联删除仍有关系时失败
  await assert.rejects(
    () => createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "bank.delete", bankId: "b1", deletedAt: AT } })
      .then((change) => reduceChangeSetV7(base, change)),
    /必须 cascade/,
  );

  const after = await reduce(base, { kind: "bank.delete.cascade", bankId: "b1", deletedAt: AT });
  assert.equal(after.banks.some((b) => b.id === "b1"), false);
  assert.equal(after.banks.some((b) => b.id === "b2"), true);
  assert.equal(after.questions.length, 1, "共享题不删");
  assert.equal(after.memberships.length, 1, "仅 b1 关系被删");
  assert.equal(after.practiceRuns.some((r) => r.id === "r1"), false, "目标题库 run 被删");
  assert.ok(after.tombstones.some((t) => t.entityType === "practiceRun" && t.entityId === "r1"));
  assert.ok(after.tombstones.some((t) => t.entityType === "bank" && t.entityId === "b1"));
}

// ---------------------------------------------------------------------------
// question delete cascade
// ---------------------------------------------------------------------------
{
  const base = structuredClone(empty);
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"));
  base.practiceRuns.push(run("r1", "b1", ["q1"]));
  base.attempts.push({ id: "a1", runId: "r1", questionId: "q1", selected: "A", correct: true, elapsedMs: 1, createdAt: AT, deviceId: device });
  base.notes.push({ questionId: "q1", content: "note", revision: 1, updatedAt: AT, deviceId: device });
  base.questionGroups.push({ id: "g1", name: "组", type: "static", items: [{ questionId: "q1", note: "" }], createdAt: AT, updatedAt: AT, deviceId: device });
  base.reviewRounds.push(round("round1", ["b1"]));
  base.reviewRoundProgress.push(roundProgress("round1", "q1"));

  await assert.rejects(
    () => createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "question.delete", questionId: "q1", deletedAt: AT } })
      .then((change) => reduceChangeSetV7(base, change)),
    /必须 cascade/,
  );

  const after = await reduce(base, { kind: "question.delete.cascade", questionId: "q1", deletedAt: AT });
  assert.equal(after.questions.length, 0);
  assert.equal(after.memberships.length, 0);
  assert.equal(after.attempts.length, 0);
  assert.equal(after.notes.length, 0);
  assert.equal(after.questionGroups.length, 0, "组被裁空");
  assert.ok(after.tombstones.some((t) => t.entityType === "questionGroup" && t.entityId === "g1"), "裁空组写墓碑");
  assert.equal(after.reviewRoundProgress.length, 0);
  assert.equal(after.practiceRuns[0].questionIds.length, 0, "run 被裁剪");
  assert.ok(after.tombstones.some((t) => t.entityType === "question" && t.entityId === "q1"));
}

// ---------------------------------------------------------------------------
// bulk delete 重复 id 与 tombstone
// ---------------------------------------------------------------------------
{
  const base = structuredClone(empty);
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"), question("q2"));
  base.memberships.push(membership("b1", "q1"), membership("b1", "q2"));
  const after = await reduce(base, { kind: "question.bulk.delete", questionIds: ["q1", "q1", "q2"], deletedAt: AT, cascade: true });
  assert.equal(after.questions.length, 0);
  assert.equal(after.tombstones.filter((t) => t.entityType === "question").length, 2, "重复 id 只写一次墓碑");
}

// ---------------------------------------------------------------------------
// image asset conflict / delete
// ---------------------------------------------------------------------------
{
  const base = structuredClone(empty);
  const asset = { id: "a".repeat(64), mimeType: "image/png", size: 1, width: 1, height: 1 };
  const after = await reduce(base, { kind: "image.asset.save", asset });
  assert.equal(after.imageAssets.length, 1);
  await assert.rejects(
    () => createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "image.asset.save", asset: { ...asset, size: 2 } } })
      .then((change) => reduceChangeSetV7(after, change)),
    /不可变内容冲突/,
  );
  // 相同 descriptor 幂等
  const again = await reduce(after, { kind: "image.asset.save", asset });
  assert.equal(again.imageAssets.length, 1);

  // 被引用时不可删
  const withQuestion = structuredClone(again);
  withQuestion.questions.push({ ...question("q1"), content: [{ id: "img", type: "image", assetId: asset.id }] });
  await assert.rejects(
    () => createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "image.asset.delete", assetId: asset.id, deletedAt: AT } })
      .then((change) => reduceChangeSetV7(withQuestion, change)),
    /仍被题目引用/,
  );
}

// ---------------------------------------------------------------------------
// answer submitted / updated / deleted
// ---------------------------------------------------------------------------
{
  const base = structuredClone(empty);
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"));
  base.practiceRuns.push(run("r1", "b1", ["q1"]));
  const attempt = { id: "a1", runId: "r1", questionId: "q1", selected: "A", correct: true, elapsedMs: 1, createdAt: AT, deviceId: device };
  const answer = { selected: ["A"], submitted: true as const, correct: true, updatedAt: AT, deviceId: device, eventId: "e1" };
  const after = await reduce(base, { kind: "practice.answer.submitted", attempt, answer, runId: "r1", questionId: "q1" });
  assert.equal(after.attempts.length, 1);
  assert.equal(after.practiceRuns[0].answers.q1.submitted, true);

  await assert.rejects(
    () => createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "practice.answer.submitted", attempt, answer, runId: "r1", questionId: "q1" } })
      .then((change) => reduceChangeSetV7(after, change)),
    /已存在，提交必须使用新 id/,
  );

  const updated = await reduce(after, { kind: "practice.answer.updated", attempt: { ...attempt, correct: false, selected: "B" }, answer: { ...answer, correct: false, selected: ["B"] }, runId: "r1", questionId: "q1" });
  assert.equal(updated.attempts[0].correct, false);
  assert.equal(updated.practiceRuns[0].answers.q1.correct, false);

  const deleted = await reduce(updated, { kind: "practice.answer.deleted", attemptId: "a1", runId: "r1", questionId: "q1", deletedAt: AT });
  assert.equal(deleted.attempts.length, 0);
  assert.equal(deleted.practiceRuns[0].answers.q1, undefined);
  assert.ok(deleted.tombstones.some((t) => t.entityType === "attempt" && t.entityId === "a1"));
}

// ---------------------------------------------------------------------------
// practice run saved / tombstone / review round transitions
// ---------------------------------------------------------------------------
{
  const base = structuredClone(empty);
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"));
  const after = await reduce(base, { kind: "practice.run.saved", run: run("r1", "b1", ["q1"]) });
  assert.equal(after.practiceRuns.length, 1);

  const deleted = await reduce(after, { kind: "practice.run.deleted", runId: "r1", deletedAt: AT });
  assert.equal(deleted.practiceRuns.length, 0);
  await assert.rejects(
    () => createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "practice.run.saved", run: run("r1", "b1", ["q1"]) } })
      .then((change) => reduceChangeSetV7(deleted, change)),
    /已被删除/,
  );

  const withRound = structuredClone(empty);
  withRound.banks.push(bank("b1"));
  withRound.questions.push(question("q1"));
  withRound.memberships.push(membership("b1", "q1"));
  withRound.reviewRounds.push(round("round1", ["b1"]));
  const completedRound = await reduce(withRound, { kind: "review.round.completed", round: { ...round("round1", ["b1"]), status: "completed", completedAt: AT } });
  assert.equal(completedRound.reviewRounds[0].status, "completed");
  await assert.rejects(
    () => createChangeSetV7({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "review.round.completed", round: { ...round("round1", ["b1"]), status: "completed", completedAt: AT } } })
      .then((change) => reduceChangeSetV7(completedRound, change)),
    /不是进行中状态/,
  );
}

console.log("projection edge-case tests passed");
process.exit(0);
