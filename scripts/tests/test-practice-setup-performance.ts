import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { readPracticeSetupHistoryForQuestionIdsV7 } from "../../src/lib/db/practice-setup-read-v7";
import type { AttemptStatsV7, AttemptV7, ReviewRoundProgress } from "../../src/lib/db/v7-types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetV7Database();
const at = "2026-08-27T00:00:00.000Z";
const targetIds = ["target-q-1", "target-q-2"];

const stats = (questionId: string): AttemptStatsV7 => ({
  questionId,
  total: 1,
  correct: 0,
  wrong: 1,
  giveUps: 0,
  totalElapsedMs: 10,
  firstAttemptAt: at,
  firstAttemptCorrect: false,
  latestAttemptAt: at,
  hasBeenWrong: true,
  correctStreakAfterWrong: 0,
  currentCorrectStreak: 0,
  recentOutcomes: [{ id: `outcome-${questionId}`, createdAt: at, correct: false, elapsedMs: 10 }],
});
const unrelatedStats = Array.from({ length: 20_000 }, (_, index) => stats(`unrelated-stats-${index}`));
await dbV7.attemptStats.bulkPut([...unrelatedStats, ...targetIds.map(stats)]);

const progress = (questionId: string, index: number): ReviewRoundProgress => ({
  key: `round-${index}:${questionId}`,
  roundId: `round-${index}`,
  questionId,
  attempts: 1,
  correct: 0,
  wrong: 1,
  firstAttemptAt: at,
  latestAttemptAt: at,
  giveUps: 0,
  totalElapsedMs: 10,
  firstAttemptCorrect: false,
  hasBeenWrong: true,
  currentCorrectStreak: 0,
  correctStreakAfterWrong: 0,
  recentOutcomes: [{ id: `round-outcome-${index}`, createdAt: at, correct: false, elapsedMs: 10 }],
});
const unrelatedProgress = Array.from({ length: 20_000 }, (_, index) => progress(`unrelated-progress-${index}`, index));
const targetProgress = [progress(targetIds[0], 20_001), progress(targetIds[1], 20_002), progress(targetIds[0], 20_003)];
await dbV7.reviewRoundProgress.bulkPut([...unrelatedProgress, ...targetProgress]);

const unrelatedAttempts: AttemptV7[] = Array.from({ length: 100_000 }, (_, index) => ({
  id: `attempt-${index}`,
  runId: "perf-run",
  questionId: `unrelated-attempt-q-${index % 1000}`,
  selected: "A",
  correct: true,
  elapsedMs: 1,
  createdAt: at,
  deviceId: "practice-perf-test",
}));
const targetAttempts: AttemptV7[] = Array.from({ length: 7 }, (_, index) => ({
  id: `target-attempt-${index}`,
  runId: "perf-run",
  questionId: targetIds[index % targetIds.length],
  selected: "A",
  correct: index % 2 === 0,
  elapsedMs: 1,
  createdAt: at,
  deviceId: "practice-perf-test",
}));
await dbV7.attempts.bulkPut([...unrelatedAttempts, ...targetAttempts]);

let statsReads = 0;
let progressReads = 0;
let attemptReads = 0;
const statsHook = (row: AttemptStatsV7) => { statsReads += 1; return row; };
const progressHook = (row: ReviewRoundProgress) => { progressReads += 1; return row; };
const attemptHook = (row: AttemptV7) => { attemptReads += 1; return row; };
dbV7.attemptStats.hook("reading", statsHook);
dbV7.reviewRoundProgress.hook("reading", progressHook);
dbV7.attempts.hook("reading", attemptHook);

const history = await readPracticeSetupHistoryForQuestionIdsV7([targetIds[0], targetIds[1], targetIds[0]]);

dbV7.attemptStats.hook("reading").unsubscribe(statsHook);
dbV7.reviewRoundProgress.hook("reading").unsubscribe(progressHook);
dbV7.attempts.hook("reading").unsubscribe(attemptHook);
assert.deepEqual(history.stats.map((row) => row.questionId).sort(), [...targetIds].sort());
assert.equal(history.roundsProgress.length, targetProgress.length, "大量无关轮次进度下必须完整读取当前题目记录");
assert.equal(history.attempts.length, targetAttempts.length, "100,000 attempts 场景必须完整读取当前小题集历史");
assert.equal(statsReads, targetIds.length, "20,000 unrelated attemptStats 不得被 Practice Setup materialize");
assert.equal(progressReads, targetProgress.length, "20,000 unrelated reviewRoundProgress 不得被 Practice Setup materialize");
assert.equal(attemptReads, targetAttempts.length, "100,000 unrelated attempts 不得被 Practice Setup materialize");
assert.ok(history.attempts.every((row) => targetIds.includes(row.questionId)));
assert.ok(history.roundsProgress.every((row) => targetIds.includes(row.questionId)));

let emptyReads = 0;
const emptyAttemptHook = (row: AttemptV7) => { emptyReads += 1; return row; };
dbV7.attempts.hook("reading", emptyAttemptHook);
assert.deepEqual(await readPracticeSetupHistoryForQuestionIdsV7([]), { stats: [], roundsProgress: [], attempts: [] }, "空题集必须直接返回空 read-model");
dbV7.attempts.hook("reading").unsubscribe(emptyAttemptHook);
assert.equal(emptyReads, 0, "空题集不得触发历史表读取");

await dbV7.close();
console.log("practice setup performance tests passed: targeted stats/progress reads and 100k attempt cardinality");
