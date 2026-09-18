import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBank,
  createPracticeRun,
  createQuestion,
  createReviewRound,
  deletePracticeRun,
  recordPracticeAnswer,
  resetDatabase,
  studyDb,
} from "../../src/lib/db/db";
import { applyAttemptProjectionInTx, rebuildAllProjections } from "../../src/lib/db/projection-engine";
import type { Attempt } from "../../src/lib/db/types";

function stableRows<T extends { [key: string]: unknown }>(rows: T[]): T[] {
  return rows
    .map((row) => structuredClone(row))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function readProjectionSnapshot() {
  return {
    bankQuestionStats: stableRows(await studyDb.bankQuestionStats.toArray()),
    questionProgress: stableRows(await studyDb.questionProgress.toArray()),
    questionDailyProgress: stableRows(await studyDb.questionDailyProgress.toArray()),
    bankPracticeStats: stableRows(await studyDb.bankPracticeStats.toArray()),
    bankPracticeRunIndex: stableRows(await studyDb.bankPracticeRunIndex.toArray()),
    reviewRoundProgress: stableRows(await studyDb.reviewRoundProgress.toArray()),
  };
}

async function clearProjections() {
  await studyDb.transaction(
    "rw",
    studyDb.bankQuestionStats,
    studyDb.questionProgress,
    studyDb.questionDailyProgress,
    studyDb.bankPracticeStats,
    studyDb.bankPracticeRunIndex,
    studyDb.reviewRoundProgress,
    async () => {
      await Promise.all([
        studyDb.bankQuestionStats.clear(),
        studyDb.questionProgress.clear(),
        studyDb.questionDailyProgress.clear(),
        studyDb.bankPracticeStats.clear(),
        studyDb.bankPracticeRunIndex.clear(),
        studyDb.reviewRoundProgress.clear(),
      ]);
    },
  );
}

async function assertRebuildEqualsIncremental(label: string) {
  const incrementallyMaintained = await readProjectionSnapshot();
  const changeSetsBeforeRebuild = await studyDb.changeSets.toArray();

  await clearProjections();
  assert.deepEqual(await readProjectionSnapshot(), {
    bankQuestionStats: [],
    questionProgress: [],
    questionDailyProgress: [],
    bankPracticeStats: [],
    bankPracticeRunIndex: [],
    reviewRoundProgress: [],
  });

  await rebuildAllProjections();
  assert.deepEqual(
    await readProjectionSnapshot(),
    incrementallyMaintained,
    `${label}: full projection rebuild must equal the incrementally maintained result`,
  );
  assert.deepEqual(
    await studyDb.changeSets.toArray(),
    changeSetsBeforeRebuild,
    `${label}: projection rebuild must not enqueue or rewrite sync change sets`,
  );

  await rebuildAllProjections();
  assert.deepEqual(
    await readProjectionSnapshot(),
    incrementallyMaintained,
    `${label}: projection rebuild must be idempotent`,
  );
  assert.deepEqual(await studyDb.changeSets.toArray(), changeSetsBeforeRebuild);
}

// Small readable contract fixture.
await resetDatabase();
const bank = await createBank("projection rebuild");
const first = await createQuestion(bank.id, {
  type: "单选",
  stem: "first",
  options: ["A", "B"],
  optionIds: ["a", "b"],
  solution: { kind: "choice", correctOptionIds: ["a"] },
});
const second = await createQuestion(bank.id, {
  type: "单选",
  stem: "second",
  options: ["A", "B"],
  optionIds: ["a", "b"],
  solution: { kind: "choice", correctOptionIds: ["b"] },
});
const round = await createReviewRound({ name: "projection round", bankIds: [bank.id] });
const run = await createPracticeRun({
  bankIds: [bank.id],
  questionIds: [first.id, second.id],
  reviewRoundId: round.id,
});
await recordPracticeAnswer({ runId: run.id, questionId: first.id, selected: ["A"], correct: true, reviewRoundId: round.id, elapsedMs: 120 });
await recordPracticeAnswer({ runId: run.id, questionId: second.id, selected: ["A"], correct: false, reviewRoundId: round.id, elapsedMs: 240 });

const smallSnapshot = await readProjectionSnapshot();
assert.equal(smallSnapshot.bankQuestionStats.length, 1);
assert.equal(smallSnapshot.bankQuestionStats[0]?.questionCount, 2);
assert.equal(smallSnapshot.questionProgress.length, 2);
assert.equal(smallSnapshot.questionDailyProgress.length, 2);
assert.equal(smallSnapshot.reviewRoundProgress.length, 2);
assert.equal(smallSnapshot.bankPracticeStats.length, 1);
assert.equal(smallSnapshot.bankPracticeRunIndex.length, 1);
await assertRebuildEqualsIncremental("small fixture");

// Deleting the newest run must lower latestActivityAt to the exact previous
// surviving canonical run rather than leaving a monotonic stale maximum.
await resetDatabase();
const activityBank = await createBank("activity exactness");
const activityQuestion = await createQuestion(activityBank.id, {
  type: "单选",
  stem: "activity",
  options: ["A", "B"],
  optionIds: ["a", "b"],
  solution: { kind: "choice", correctOptionIds: ["a"] },
});
const olderRun = await createPracticeRun({
  bankId: activityBank.id,
  questionIds: [activityQuestion.id],
  startedAt: "2026-09-01T00:00:00.000Z",
});
const newerRun = await createPracticeRun({
  bankId: activityBank.id,
  questionIds: [activityQuestion.id],
  startedAt: "2026-09-02T00:00:00.000Z",
});
assert.equal((await studyDb.bankPracticeStats.get(activityBank.id))?.latestActivityAt, newerRun.startedAt);
await deletePracticeRun(newerRun.id);
assert.equal(
  (await studyDb.bankPracticeStats.get(activityBank.id))?.latestActivityAt,
  olderRun.startedAt,
  "deleting the latest run must reveal the previous exact activity timestamp",
);
await assertRebuildEqualsIncremental("latest run deletion");

// Out-of-order old attempts must repair exact streak counters even when the
// affected wrong answer falls outside the bounded 32-row recentOutcomes view.
await resetDatabase();
const outOfOrderQuestionId = "q-out-of-order";
const outOfOrderRoundId = "round-out-of-order";
const baseTime = Date.parse("2026-09-03T00:00:00.000Z");
const writeProjectedAttempt = async (attempt: Attempt) => {
  await studyDb.transaction(
    "rw",
    studyDb.attempts,
    studyDb.questionProgress,
    studyDb.questionDailyProgress,
    studyDb.reviewRoundProgress,
    async () => {
      await studyDb.attempts.put(attempt);
      await applyAttemptProjectionInTx(attempt);
    },
  );
};
for (let index = 1; index <= 64; index += 1) {
  await writeProjectedAttempt({
    id: `ordered-${index}`,
    runId: "run-out-of-order",
    questionId: outOfOrderQuestionId,
    reviewRoundId: outOfOrderRoundId,
    selected: "A",
    correct: true,
    elapsedMs: 1,
    createdAt: new Date(baseTime + index * 1_000).toISOString(),
    deviceId: "projection-order-device",
  });
}
await writeProjectedAttempt({
  id: "late-old-wrong",
  runId: "run-out-of-order",
  questionId: outOfOrderQuestionId,
  reviewRoundId: outOfOrderRoundId,
  selected: "B",
  correct: false,
  elapsedMs: 1,
  createdAt: new Date(baseTime + 20_500).toISOString(),
  deviceId: "projection-order-device",
});
const repairedQuestion = await studyDb.questionProgress.get(outOfOrderQuestionId);
const repairedRound = await studyDb.reviewRoundProgress.get([outOfOrderRoundId, outOfOrderQuestionId]);
assert.equal(repairedQuestion?.currentCorrectStreak, 44);
assert.equal(repairedQuestion?.correctStreakAfterWrong, 44);
assert.equal(repairedQuestion?.recentOutcomes.length, 32);
assert.equal(repairedRound?.currentCorrectStreak, 44);
assert.equal(repairedRound?.correctStreakAfterWrong, 44);
assert.equal(repairedRound?.recentOutcomes.length, 32);
await assertRebuildEqualsIncremental("out-of-order exact streak");

// Deterministic randomized differential fixture. This deliberately spans
// multiple banks/runs and mixed outcomes so the full rebuild is compared with
// incremental maintenance across a much wider state surface than one example.
await resetDatabase();
let seed = 0x5eed1234;
const nextRandom = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
};

const banks = [];
const questionsByBank: Array<Array<{ id: string; answer: "A" | "B" }>> = [];
for (let bankIndex = 0; bankIndex < 4; bankIndex += 1) {
  const seededBank = await createBank(`seeded bank ${bankIndex}`);
  banks.push(seededBank);
  const questions = [];
  for (let questionIndex = 0; questionIndex < 8; questionIndex += 1) {
    const answer: "A" | "B" = nextRandom() < 0.5 ? "A" : "B";
    const question = await createQuestion(seededBank.id, {
      type: "单选",
      stem: `seeded ${bankIndex}-${questionIndex}`,
      options: ["A", "B"],
      optionIds: ["a", "b"],
      solution: { kind: "choice", correctOptionIds: [answer === "A" ? "a" : "b"] },
    });
    questions.push({ id: question.id, answer });
  }
  questionsByBank.push(questions);
}

const seededRound = await createReviewRound({ name: "seeded differential round", bankIds: banks.map((item) => item.id) });
let expectedAttempts = 0;
for (let runIndex = 0; runIndex < 8; runIndex += 1) {
  const bankIndex = runIndex % banks.length;
  const candidates = questionsByBank[bankIndex];
  const selectedQuestions = candidates.filter(() => nextRandom() > 0.28);
  const seededRun = await createPracticeRun({
    bankIds: [banks[bankIndex].id],
    questionIds: selectedQuestions.map((item) => item.id),
    ...(runIndex % 2 === 0 ? { reviewRoundId: seededRound.id } : {}),
  });
  for (const item of selectedQuestions) {
    const shouldBeCorrect = nextRandom() > 0.37;
    const selected = shouldBeCorrect ? item.answer : (item.answer === "A" ? "B" : "A");
    await recordPracticeAnswer({
      runId: seededRun.id,
      questionId: item.id,
      selected: [selected],
      correct: shouldBeCorrect,
      ...(runIndex % 2 === 0 ? { reviewRoundId: seededRound.id } : {}),
      elapsedMs: 50 + Math.floor(nextRandom() * 4_950),
    });
    expectedAttempts += 1;
  }
}

const seededSnapshot = await readProjectionSnapshot();
assert.equal(seededSnapshot.bankQuestionStats.length, 4);
assert.ok(seededSnapshot.bankQuestionStats.every((row) => row.questionCount === 8));
assert.ok(expectedAttempts > 20, "seeded fixture must contain enough attempts to exercise differential rebuilds");
assert.ok(seededSnapshot.questionProgress.length > 10);
assert.equal(seededSnapshot.bankPracticeStats.length, 4);
assert.equal(seededSnapshot.bankPracticeRunIndex.length, 8);
assert.ok(seededSnapshot.reviewRoundProgress.length > 0);
await assertRebuildEqualsIncremental("seeded differential fixture");

console.log("projection rebuild contract passed: seeded differential equivalence, clear+rebuild, idempotence and sync silence");
