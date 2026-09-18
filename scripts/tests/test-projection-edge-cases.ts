import assert from "node:assert/strict";
import { reduceChangeSet } from "../../src/lib/sync/change-set-projection";
import type { ChangeSetMutation } from "../../src/lib/sync/change-set-types";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import type {
  Attempt,
  AttemptStats,
  Bank,
  CanonicalState,
  PracticeRunItem,
  PracticeRunRecord,
  PracticeRunSource,
  Question,
  ReviewRoundProgress,
  ReviewRoundRecord,
} from "../../src/lib/db/types";
import { addAttemptToStats, addReviewRoundProgress } from "../../src/lib/db/db-attempt-projections";

const AT = "2026-08-13T00:00:00.000Z";
const device = "device-test";
let seq = 0;

const bank = (id: string): Bank => ({ id, name: id, sortOrder: 0, questionCount: 0, importedAt: AT, updatedAt: AT, deviceId: device });
const question = (id: string): Question => ({
  id,
  type: "单选",
  content: [{ id: "stem-0", type: "text", text: `题 ${id}` }],
  options: [[{ id: "o-a", type: "text", text: "A" }], [{ id: "o-b", type: "text", text: "B" }]],
  solution: { kind: "choice", correctOptionIds: ["o-a"] },
  tags: [],
  contentFingerprint: `fp-${id}`,
  updatedAt: AT,
  deviceId: device,
});
const membership = (bankId: string, questionId: string) => ({
  key: `${bankId}:${questionId}`,
  bankId,
  questionId,
  sortOrder: 0,
  addedAt: AT,
  updatedAt: AT,
  deviceId: device,
});
const runRecord = (id: string, reviewRoundId?: string): PracticeRunRecord => ({
  id,
  mode: "sequential",
  modeLabel: "练习",
  shuffleOptions: false,
  startedAt: AT,
  updatedAt: AT,
  status: "in_progress",
  revision: 0,
  bankNameSnapshot: "题库",
  activityAt: AT,
  ...(reviewRoundId ? { reviewRoundId } : {}),
});
const runSource = (runId: string, bankId: string): PracticeRunSource => ({
  runId,
  bankId,
  bankNameSnapshot: bankId,
  position: 0,
});
const runItem = (runId: string, questionId: string): PracticeRunItem => ({
  runId,
  questionId,
  position: 0,
  questionTypeSnapshot: "单选",
  optionOrder: [],
});
const roundRecord = (id: string, status: ReviewRoundRecord["status"] = "active"): ReviewRoundRecord => ({
  id,
  name: id,
  startedAt: AT,
  status,
  ...(status === "completed" ? { completedAt: AT } : {}),
  createdAt: AT,
  updatedAt: AT,
  deviceId: device,
});

function emptyState(): CanonicalState {
  return {
    banks: [],
    bankFolders: [],
    questions: [],
    memberships: [],
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
}

async function reduce(base: CanonicalState, mutation: ChangeSetMutation) {
  const change = await createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation });
  return reduceChangeSet(base, change);
}

// bank delete cascades normalized run/round relations
{
  const base = emptyState();
  base.banks.push(bank("b1"), bank("b2"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"), membership("b2", "q1"));
  base.practiceRuns.push(runRecord("r1"));
  base.practiceRunSources.push(runSource("r1", "b1"));
  base.practiceRunItems.push(runItem("r1", "q1"));
  base.reviewRounds.push(roundRecord("round-bank"));
  base.reviewRoundBanks.push(
    { roundId: "round-bank", bankId: "b1", position: 0 },
    { roundId: "round-bank", bankId: "b2", position: 1 },
  );

  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "bank.delete", bankId: "b1", deletedAt: AT } })
      .then((change) => reduceChangeSet(base, change)),
    /必须 cascade/,
  );

  const after = await reduce(base, { kind: "bank.delete.cascade", bankId: "b1", deletedAt: AT });
  assert.equal(after.banks.some((b) => b.id === "b1"), false);
  assert.equal(after.questions.length, 1, "共享题不删");
  assert.equal(after.memberships.length, 1, "仅 b1 关系被删");
  assert.equal(after.practiceRuns.some((r) => r.id === "r1"), false, "目标题库 run 被删");
  assert.deepEqual(after.reviewRoundBanks.map((row) => row.bankId), ["b2"], "题库删除必须裁剪复习轮次 relation");
  assert.ok(after.tombstones.some((t) => t.entityType === "practiceRun" && t.entityId === "r1"));
  assert.ok(after.tombstones.some((t) => t.entityType === "bank" && t.entityId === "b1"));
}

// question delete cascades every canonical relation
{
  const base = emptyState();
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"));
  base.practiceRuns.push(runRecord("r1"));
  base.practiceRunSources.push(runSource("r1", "b1"));
  base.practiceRunItems.push(runItem("r1", "q1"));
  base.attempts.push({ id: "a1", runId: "r1", questionId: "q1", selected: "A", correct: true, elapsedMs: 1, createdAt: AT, deviceId: device });
  base.notes.push({ questionId: "q1", content: "note", revision: 1, updatedAt: AT, deviceId: device });
  base.questionGroups.push({ id: "g1", name: "组", type: "专题", description: "", createdAt: AT, updatedAt: AT, deviceId: device });
  base.questionGroupItems.push({ groupId: "g1", questionId: "q1", position: 0 });
  base.reviewRounds.push(roundRecord("round1", "completed"));
  base.reviewRoundBanks.push({ roundId: "round1", bankId: "b1", position: 0 });
  base.reviewRoundItems.push({ roundId: "round1", questionId: "q1", position: 0 });

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
  assert.equal(after.questionGroupItems.length, 0);
  assert.equal(after.reviewRoundItems.length, 0, "复习轮次题目 relation 被裁剪");
  assert.equal(after.practiceRunItems.length, 0, "run item 被裁剪");
  assert.ok(after.tombstones.some((t) => t.entityType === "questionGroup" && t.entityId === "g1"), "裁空组写墓碑");
  assert.ok(after.tombstones.some((t) => t.entityType === "question" && t.entityId === "q1"));
}

// bulk delete duplicate ids create one tombstone each
{
  const base = emptyState();
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"), question("q2"));
  base.memberships.push(membership("b1", "q1"), membership("b1", "q2"));
  const after = await reduce(base, { kind: "question.bulk.delete", questionIds: ["q1", "q1", "q2"], deletedAt: AT, cascade: true });
  assert.equal(after.questions.length, 0);
  assert.equal(after.tombstones.filter((t) => t.entityType === "question").length, 2, "重复 id 只写一次墓碑");
}

// image descriptor immutability
{
  const base = emptyState();
  const asset = { id: "a".repeat(64), mimeType: "image/png" as const, size: 1, width: 1, height: 1 };
  const after = await reduce(base, { kind: "image.asset.save", asset });
  assert.equal(after.imageAssets.length, 1);
  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "image.asset.save", asset: { ...asset, size: 2 } } })
      .then((change) => reduceChangeSet(after, change)),
    /不可变内容冲突/,
  );
  const again = await reduce(after, { kind: "image.asset.save", asset });
  assert.equal(again.imageAssets.length, 1);
  const withQuestion = structuredClone(again);
  withQuestion.questions.push({ ...question("q1"), content: [{ id: "img", type: "image", assetId: asset.id }] });
  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "image.asset.delete", assetId: asset.id, deletedAt: AT } })
      .then((change) => reduceChangeSet(withQuestion, change)),
    /仍被题目引用/,
  );
}

// normalized answer facts are immutable and deletions write attempt tombstones
{
  const base = emptyState();
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"));
  base.practiceRuns.push(runRecord("r1"));
  base.practiceRunSources.push(runSource("r1", "b1"));
  base.practiceRunItems.push(runItem("r1", "q1"));

  const attempt = { id: "a1", runId: "r1", questionId: "q1", selected: "A", correct: true, elapsedMs: 1, createdAt: AT, deviceId: device };
  const run1 = { ...base.practiceRuns[0], revision: 1 };
  const item1 = { ...base.practiceRunItems[0], submittedAttemptId: attempt.id };
  const after = await reduce(base, { kind: "practice.answer.submitted", attempt, runRecord: run1, item: item1 });
  assert.equal(after.attempts.length, 1);
  assert.equal(after.practiceRunItems[0].submittedAttemptId, "a1");

  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "practice.answer.submitted", attempt, runRecord: run1, item: item1 } })
      .then((change) => reduceChangeSet(after, change)),
    /已存在，提交必须使用新 id/,
  );

  const secondAttempt = { ...attempt, id: "a2", correct: false, selected: "B" };
  const run2 = { ...run1, revision: 2 };
  const item2 = { ...item1, submittedAttemptId: secondAttempt.id };
  const updated = await reduce(after, { kind: "practice.answer.submitted", attempt: secondAttempt, runRecord: run2, item: item2 });
  assert.equal(updated.attempts.length, 2);
  assert.equal(updated.attempts.find((item) => item.id === "a1")?.correct, true);
  assert.equal(updated.attempts.find((item) => item.id === "a2")?.correct, false);
  assert.equal(updated.practiceRunItems[0].submittedAttemptId, "a2");

  const cleared = { ...item2, submittedAttemptId: undefined };
  const deletedLatest = await reduce(updated, { kind: "practice.answer.deleted", attemptId: "a2", runRecord: { ...run2, revision: 3 }, item: cleared, deletedAt: AT });
  const deleted = await reduce(deletedLatest, { kind: "practice.answer.deleted", attemptId: "a1", runRecord: { ...run2, revision: 4 }, item: cleared, deletedAt: AT });
  assert.equal(deleted.attempts.length, 0);
  assert.equal(deleted.practiceRunItems[0].submittedAttemptId, undefined);
  assert.ok(deleted.tombstones.some((t) => t.entityType === "attempt" && t.entityId === "a1"));
}

// run tombstone and normalized relation validation
{
  const base = emptyState();
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"));
  const record = runRecord("r1");
  const sources = [runSource("r1", "b1")];
  const items = [runItem("r1", "q1")];
  const after = await reduce(base, { kind: "practice.run.saved", record, sources, items });
  assert.equal(after.practiceRuns.length, 1);

  const deleted = await reduce(after, { kind: "practice.run.deleted", runId: "r1", deletedAt: AT });
  assert.equal(deleted.practiceRuns.length, 0);
  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "practice.run.saved", record, sources, items } })
      .then((change) => reduceChangeSet(deleted, change)),
    /已被删除/,
  );

  await assert.rejects(
    () => createChangeSet({
      deviceId: device,
      localSequence: ++seq,
      createdAt: AT,
      mutation: { kind: "practice.run.saved", record: runRecord("bad"), sources: [runSource("other", "b1")], items: [] },
    }).then((change) => reduceChangeSet(base, change)),
    /runId 不一致/,
    "normalized relation rows must belong to the saved run",
  );
}

// review-round transition is canonical record + relations
{
  const base = emptyState();
  base.banks.push(bank("b1"));
  base.questions.push(question("q1"));
  base.memberships.push(membership("b1", "q1"));
  base.reviewRounds.push(roundRecord("round1"));
  base.reviewRoundBanks.push({ roundId: "round1", bankId: "b1", position: 0 });

  const completed = {
    record: roundRecord("round1", "completed"),
    banks: [{ roundId: "round1", bankId: "b1", position: 0 }],
    items: [{ roundId: "round1", questionId: "q1", position: 0 }],
  };
  const after = await reduce(base, { kind: "review.round.completed", ...completed });
  assert.equal(after.reviewRounds[0].status, "completed");
  assert.equal(after.reviewRoundItems[0].questionId, "q1");
  await assert.rejects(
    () => createChangeSet({ deviceId: device, localSequence: ++seq, createdAt: AT, mutation: { kind: "review.round.completed", ...completed } })
      .then((change) => reduceChangeSet(after, change)),
    /不是进行中状态/,
  );
}

// exact streak counters must not be truncated by the 32-outcome display window
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
  for (let index = 1; index <= 64; index += 1) stats = addAttemptToStats(stats, attempt(`correct-${index}`, index, true));
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

console.log("canonical reducer edge-case tests passed");
process.exit(0);
