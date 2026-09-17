import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBank,
  createPracticeRun,
  createQuestion,
  createReviewRound,
  recordPracticeAnswer,
  resetDatabase,
  studyDb,
} from "../../src/lib/db/db";
import { rebuildAllProjections } from "../../src/lib/db/projection-engine";

function stableRows<T extends { [key: string]: unknown }>(rows: T[]): T[] {
  return rows
    .map((row) => structuredClone(row))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function readProjectionSnapshot() {
  return {
    questionProgress: stableRows(await studyDb.questionProgress.toArray()),
    questionDailyProgress: stableRows(await studyDb.questionDailyProgress.toArray()),
    bankPracticeStats: stableRows(await studyDb.bankPracticeStats.toArray()),
    reviewRoundProgress: stableRows(await studyDb.reviewRoundProgress.toArray()),
  };
}

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

await recordPracticeAnswer({
  runId: run.id,
  questionId: first.id,
  selected: ["A"],
  correct: true,
  reviewRoundId: round.id,
  elapsedMs: 120,
});
await recordPracticeAnswer({
  runId: run.id,
  questionId: second.id,
  selected: ["A"],
  correct: false,
  reviewRoundId: round.id,
  elapsedMs: 240,
});

const incrementallyMaintained = await readProjectionSnapshot();
assert.equal(incrementallyMaintained.questionProgress.length, 2);
assert.equal(incrementallyMaintained.questionDailyProgress.length, 2);
assert.equal(incrementallyMaintained.reviewRoundProgress.length, 2);
assert.equal(incrementallyMaintained.bankPracticeStats.length, 1);

const changeSetsBeforeRebuild = await studyDb.changeSets.toArray();
await studyDb.transaction(
  "rw",
  studyDb.questionProgress,
  studyDb.questionDailyProgress,
  studyDb.bankPracticeStats,
  studyDb.reviewRoundProgress,
  async () => {
    await Promise.all([
      studyDb.questionProgress.clear(),
      studyDb.questionDailyProgress.clear(),
      studyDb.bankPracticeStats.clear(),
      studyDb.reviewRoundProgress.clear(),
    ]);
  },
);
assert.deepEqual(await readProjectionSnapshot(), {
  questionProgress: [],
  questionDailyProgress: [],
  bankPracticeStats: [],
  reviewRoundProgress: [],
});

await rebuildAllProjections();
assert.deepEqual(
  await readProjectionSnapshot(),
  incrementallyMaintained,
  "full projection rebuild must equal the incrementally maintained result",
);
assert.deepEqual(
  await studyDb.changeSets.toArray(),
  changeSetsBeforeRebuild,
  "projection rebuild must not enqueue or rewrite sync change sets",
);

await rebuildAllProjections();
assert.deepEqual(
  await readProjectionSnapshot(),
  incrementallyMaintained,
  "projection rebuild must be idempotent",
);
assert.deepEqual(await studyDb.changeSets.toArray(), changeSetsBeforeRebuild);

console.log("projection rebuild contract passed: incremental/full equivalence, clear+rebuild and sync silence");
