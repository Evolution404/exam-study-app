import assert from "node:assert/strict";
import { reduceChangeSet, type ChangeSetProjection } from "../../src/lib/sync/change-set-projection";
import { normalizeProjection, runWithAnswer } from "../../src/lib/sync/change-set-projection-core";
import { type ChangeSetMutation } from "../../src/lib/sync/change-set-types";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import type { Attempt, AttemptStats, Bank, Question, PracticeRun, ReviewRound, ReviewRoundProgress } from "../../src/lib/db/types";
import { addAttemptToStats, addReviewRoundProgress } from "../../src/lib/db/db-attempt-projections";

const AT = "2026-08-13T00:00:00.000Z";
const device = "device-test";
let seq = 0;
const next = () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: undefined as never }).catch(() => { throw new Error("never"); });
void next;

const bank = (id: string): Bank => ({ id, name: id, sortOrder: 0, questionCount: 0, importedAt: AT, updatedAt: AT, deviceId: device });
const question = (id: string): Question => ({
  id, type: "单选",
  content: [{ id: "stem-0", type: "text", text: `题 ${id}` }],
  options: [[{ id: "o-a", type: "text", text: "A" }], [{ id: "o-b", type: "text", text: "B" }]],
  answer: "A", tags: [], contentFingerprint: `fp-${id}`, updatedAt: AT, deviceId: device,
});
const membership = (bankId: string, questionId: string) => ({ key: `${bankId}:${questionId}`, bankId, questionId, sortOrder: 0, addedAt: AT, updatedAt: AT, deviceId: device });
const run = (id: string, bankId: string, questionIds: string[]): PracticeRun => ({
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

async function reduce(base: ChangeSetProjection, mutation: ChangeSetMutation) {
  const change = await createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation });
  return reduceChangeSet(base, change);
}

const empty: ChangeSetProjection = {
  banks: [], bankFolders: [], questions: [], memberships: [], imageAssets: [],
  attempts: [], attemptStats: [], attemptDailyStats: [], notes: [], practiceRuns: [],
  practiceRunStats: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [],
};

// ---------------------------------------------------------------------------
// synced submitted-answer timestamp repair
// ---------------------------------------------------------------------------
{
  const ANSWER_AT = "2026-08-13T01:23:45.000Z";
  const base = structuredClone(empty);
  const legacyRun = run("r-sync", "b1", ["q1"]);
  legacyRun.answers.q1 = { selected: ["A"], submitted: true, correct: true };
  base.practiceRuns.push(legacyRun);
  base.attempts.push({
    id: "a-sync", runId: "r-sync", questionId: "q1", selected: "A", correct: true,
    elapsedMs: 1, createdAt: ANSWER_AT, deviceId: device,
  });

  const normalized = normalizeProjection(base);
  assert.equal(normalized.practiceRuns[0].answers.q1.updatedAt, ANSWER_AT, "checkpoint answer uses matching latest attempt timestamp");
  assert.equal(base.practiceRuns[0].answers.q1.updatedAt, undefined, "normalization must not mutate caller projection");

  const validRun = run("r-valid", "b1", ["q1"]);
  validRun.answers.q1 = { selected: ["A"], submitted: true, correct: true, updatedAt: ANSWER_AT };
  const validNormalized = normalizeProjection({ ...structuredClone(empty), practiceRuns: [validRun] });
  assert.equal(validNormalized.practiceRuns[0].answers.q1.updatedAt, ANSWER_AT, "valid answer timestamp stays unchanged");

  const replayed = runWithAnswer(
    run("r-wire", "b1", ["q1"]),
    "q1",
    { selected: ["A"], submitted: true, correct: true },
  );
  assert.equal(replayed.answers.q1.updatedAt, AT, "legacy wire answer falls back to the run clock");
}

// ---------------------------------------------------------------------------
// bank delete
// ---------------------------------------------------------------------------
{
  const base = structuredClone(empty);
  base.banks.push(bank("b1"), bank("b2"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"), membership("b2", "q1"));
  base.practiceRuns.push(run("r1", "b1", ["q1"]));
  base.reviewRounds.push(round("round-bank", ["b1", "b2"]));

  // 非级联删除仍有关系时失败
  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "bank.delete", bankId: "b1", deletedAt: AT } })
      .then((change) => reduceChangeSet(base, change)),
    /必须 cascade/,
  );

  const after = await reduce(base, { kind: "bank.delete.cascade", bankId: "b1", deletedAt: AT });
  assert.equal(after.banks.some((b) => b.id === "b1"), false);
  assert.equal(after.banks.some((b) => b.id === "b2"), true);
  assert.equal(after.questions.length, 1, "共享题不删");
  assert.equal(after.memberships.length, 1, "仅 b1 关系被删");
  assert.equal(after.practiceRuns.some((r) => r.id === "r1"), false, "目标题库 run 被删");
  assert.deepEqual(after.reviewRounds.find((item) => item.id === "round-bank")?.bankIds, ["b2"], "题库删除必须裁剪复习轮次 bankIds");
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
  base.reviewRounds.push({ ...round("round1", ["b1"]), status: "completed", completedAt: AT, finalQuestionIds: ["q1"] });
  base.reviewRoundProgress.push(roundProgress("round1", "q1"));

  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "question.delete", questionId: "q1", deletedAt: AT } })
      .then((change) => reduceChangeSet(base, change)),
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
  assert.deepEqual(after.reviewRounds.find((item) => item.id === "round1")?.finalQuestionIds, [], "题目删除必须裁剪已完成轮次 finalQuestionIds");
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
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "image.asset.save", asset: { ...asset, size: 2 } } })
      .then((change) => reduceChangeSet(after, change)),
    /不可变内容冲突/,
  );
  // 相同 descriptor 幂等
  const again = await reduce(after, { kind: "image.asset.save", asset });
  assert.equal(again.imageAssets.length, 1);

  // 被引用时不可删
  const withQuestion = structuredClone(again);
  withQuestion.questions.push({ ...question("q1"), content: [{ id: "img", type: "image", assetId: asset.id }] });
  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "image.asset.delete", assetId: asset.id, deletedAt: AT } })
      .then((change) => reduceChangeSet(withQuestion, change)),
    /仍被题目引用/,
  );
}

// ---------------------------------------------------------------------------
// answer submitted / immutable resubmission / deleted
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
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "practice.answer.submitted", attempt, answer, runId: "r1", questionId: "q1" } })
      .then((change) => reduceChangeSet(after, change)),
    /已存在，提交必须使用新 id/,
  );

  const secondAttempt = { ...attempt, id: "a2", correct: false, selected: "B" };
  const updated = await reduce(after, { kind: "practice.answer.submitted", attempt: secondAttempt, answer: { ...answer, eventId: "e2", correct: false, selected: ["B"] }, runId: "r1", questionId: "q1" });
  assert.equal(updated.attempts.length, 2);
  assert.equal(updated.attempts.find((item) => item.id === "a1")?.correct, true, "earlier immutable attempt must remain unchanged");
  assert.equal(updated.attempts.find((item) => item.id === "a2")?.correct, false);
  assert.equal(updated.practiceRuns[0].answers.q1.correct, false);

  const deletedLatest = await reduce(updated, { kind: "practice.answer.deleted", attemptId: "a2", runId: "r1", questionId: "q1", deletedAt: AT });
  const deleted = await reduce(deletedLatest, { kind: "practice.answer.deleted", attemptId: "a1", runId: "r1", questionId: "q1", deletedAt: AT });
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
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "practice.run.saved", run: run("r1", "b1", ["q1"]) } })
      .then((change) => reduceChangeSet(deleted, change)),
    /已被删除/,
  );

  const cleanRun = run("r-map", "b1", ["q1"]);
  const withRun = await reduce(base, { kind: "practice.run.saved", run: cleanRun });
  const dirtyRun = { ...cleanRun, answers: { ghost: { selected: ["A"], submitted: true, correct: true } }, revision: 1 };
  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "practice.run.status.changed", run: dirtyRun } })
      .then((change) => reduceChangeSet(withRun, change)),
    /answers.*outside questionIds/,
    "同步 run 状态事件不得写入 questionIds 范围外的答案",
  );

  const withRound = structuredClone(empty);
  withRound.banks.push(bank("b1"));
  withRound.questions.push(question("q1"));
  withRound.memberships.push(membership("b1", "q1"));
  withRound.reviewRounds.push(round("round1", ["b1"]));
  const completedRound = await reduce(withRound, { kind: "review.round.completed", round: { ...round("round1", ["b1"]), status: "completed", completedAt: AT } });
  assert.equal(completedRound.reviewRounds[0].status, "completed");
  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "review.round.completed", round: { ...round("round1", ["b1"]), status: "completed", completedAt: AT } } })
      .then((change) => reduceChangeSet(completedRound, change)),
    /不是进行中状态/,
  );
}

// ---------------------------------------------------------------------------
// exact streak counters must not be truncated by the 32-outcome display window
// ---------------------------------------------------------------------------
{
  const attempt = (id: string, index: number, correct: boolean): Attempt => ({
    id,
    runId: "run-streak",
    questionId: "q-streak",
    selected: correct ? "A" : "B",
    correct,
    elapsedMs: 1,
    createdAt: new Date(Date.parse(AT) + index * 1_000).toISOString(),
    deviceId: device,
  });

  let stats: AttemptStats | undefined;
  stats = addAttemptToStats(stats, attempt("wrong-0", 0, false));
  for (let index = 1; index <= 64; index += 1) {
    stats = addAttemptToStats(stats, attempt(`correct-${index}`, index, true));
  }
  assert.equal(stats.currentCorrectStreak, 64, "question currentCorrectStreak must stay exact beyond the 32-row recentOutcomes window");
  assert.equal(stats.correctStreakAfterWrong, 64, "question correctStreakAfterWrong must stay exact beyond the 32-row recentOutcomes window");
  assert.equal(stats.recentOutcomes.length, 32, "recentOutcomes remains a bounded display window");

  let reviewProgress: ReviewRoundProgress | undefined;
  reviewProgress = addReviewRoundProgress(reviewProgress, "round-streak", "q-streak", attempt("round-wrong-0", 0, false));
  for (let index = 1; index <= 64; index += 1) {
    reviewProgress = addReviewRoundProgress(reviewProgress, "round-streak", "q-streak", attempt(`round-correct-${index}`, index, true));
  }
  assert.equal(reviewProgress.currentCorrectStreak, 64, "review-round streak must stay exact beyond the 32-row recentOutcomes window");
  assert.equal(reviewProgress.correctStreakAfterWrong, 64, "review-round streak-after-wrong must stay exact beyond the 32-row recentOutcomes window");
  assert.equal(reviewProgress.recentOutcomes.length, 32, "review recentOutcomes remains a bounded display window");
}

console.log("projection edge-case tests passed");
process.exit(0);
