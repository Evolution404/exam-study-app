import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { studyDb, resetDatabase } from "../../src/lib/db/db";
import { readPracticeSetupHistoryForQuestionIds, readPracticeSetupScopedHistoryForQuestionIds } from "../../src/lib/db/practice-setup-read";
import type { AttemptStats, Attempt, ReviewRoundProgress } from "../../src/lib/db/types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetDatabase();
const at = "2026-08-27T00:00:00.000Z";
const targetIds = ["target-q-1", "target-q-2"];

const stats = (questionId: string): AttemptStats => ({
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
await studyDb.questionProgress.bulkPut([...unrelatedStats, ...targetIds.map(stats)]);

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
await studyDb.reviewRoundProgress.bulkPut([...unrelatedProgress, ...targetProgress]);

const unrelatedAttempts: Attempt[] = Array.from({ length: 100_000 }, (_, index) => ({
  id: `attempt-${index}`,
  runId: "perf-run",
  questionId: `unrelated-attempt-q-${index % 1000}`,
  selected: "A",
  correct: true,
  elapsedMs: 1,
  createdAt: at,
  deviceId: "practice-perf-test",
}));
const targetAttempts: Attempt[] = Array.from({ length: 7 }, (_, index) => ({
  id: `target-attempt-${index}`,
  runId: "perf-run",
  questionId: targetIds[index % targetIds.length],
  selected: "A",
  correct: index % 2 === 0,
  elapsedMs: 1,
  createdAt: at,
  deviceId: "practice-perf-test",
}));
await studyDb.attempts.bulkPut([...unrelatedAttempts, ...targetAttempts]);

let statsReads = 0;
let progressReads = 0;
let attemptReads = 0;
const statsHook = (row: AttemptStats) => { statsReads += 1; return row; };
const progressHook = (row: ReviewRoundProgress) => { progressReads += 1; return row; };
const attemptHook = (row: Attempt) => { attemptReads += 1; return row; };
studyDb.questionProgress.hook("reading", statsHook);
studyDb.reviewRoundProgress.hook("reading", progressHook);
studyDb.attempts.hook("reading", attemptHook);

const history = await readPracticeSetupHistoryForQuestionIds([targetIds[0], targetIds[1], targetIds[0]]);

studyDb.questionProgress.hook("reading").unsubscribe(statsHook);
studyDb.reviewRoundProgress.hook("reading").unsubscribe(progressHook);
studyDb.attempts.hook("reading").unsubscribe(attemptHook);
assert.deepEqual(history.stats.map((row) => row.questionId).sort(), [...targetIds].sort());
assert.equal(history.roundsProgress.length, targetProgress.length, "大量无关轮次进度下必须完整读取当前题目记录");
assert.equal(history.attempts.length, targetAttempts.length, "100,000 attempts 场景必须完整读取当前小题集历史");
assert.equal(statsReads, targetIds.length, "20,000 unrelated questionProgress 不得被 Practice Setup materialize");
assert.equal(progressReads, targetProgress.length, "20,000 unrelated reviewRoundProgress 不得被 Practice Setup materialize");
assert.equal(attemptReads, targetAttempts.length, "100,000 unrelated attempts 不得被 Practice Setup materialize");
assert.ok(history.attempts.every((row) => targetIds.includes(row.questionId)));
assert.ok(history.roundsProgress.every((row) => targetIds.includes(row.questionId)));

const oldTargetAttempts: Attempt[] = Array.from({ length: 5_000 }, (_, index) => ({
  id: `old-target-attempt-${index}`,
  runId: "perf-run-old",
  questionId: targetIds[index % targetIds.length],
  selected: "B",
  correct: false,
  elapsedMs: 2,
  createdAt: "2025-01-01T00:00:00.000Z",
  deviceId: "practice-perf-test",
}));
await studyDb.attempts.bulkPut(oldTargetAttempts);

let scopedAttemptReads = 0;
const scopedAttemptHook = (row: Attempt) => { scopedAttemptReads += 1; return row; };
studyDb.attempts.hook("reading", scopedAttemptHook);
const rollingHistory = await readPracticeSetupScopedHistoryForQuestionIds(
  targetIds,
  { type: "rolling", days: 30 },
  Date.parse("2026-09-18T00:00:00.000Z"),
);
studyDb.attempts.hook("reading").unsubscribe(scopedAttemptHook);
assert.equal(rollingHistory.attempts.length, targetAttempts.length, "rolling read-model 只应返回窗口内当前题目 attempts");
assert.equal(scopedAttemptReads, targetAttempts.length, "5,000 条窗口外目标题历史不得被练习中心 materialize");

scopedAttemptReads = 0;
studyDb.attempts.hook("reading", scopedAttemptHook);
const lifetimeHistory = await readPracticeSetupScopedHistoryForQuestionIds(
  targetIds,
  { type: "lifetime" },
  Date.parse("2026-09-18T00:00:00.000Z"),
);
studyDb.attempts.hook("reading").unsubscribe(scopedAttemptHook);
assert.equal(lifetimeHistory.attempts.length, 0, "lifetime 练习中心应复用 questionProgress，而不是读取 immutable attempts");
assert.equal(scopedAttemptReads, 0, "lifetime 练习中心不得 materialize attempts");

let scopedRoundReads = 0;
const scopedRoundHook = (row: ReviewRoundProgress | undefined) => {
  if (row) scopedRoundReads += 1;
  return row;
};
studyDb.reviewRoundProgress.hook("reading", scopedRoundHook);
const roundHistory = await readPracticeSetupScopedHistoryForQuestionIds(
  targetIds,
  { type: "round", roundId: "round-20001" },
  Date.parse("2026-09-18T00:00:00.000Z"),
);
studyDb.reviewRoundProgress.hook("reading").unsubscribe(scopedRoundHook);
assert.equal(roundHistory.attempts.length, 0);
assert.equal(roundHistory.roundsProgress.length, 1, "round 练习中心只应读取目标轮次的当前题目 progress");
assert.equal(scopedRoundReads, 1, "其他轮次 progress 不得被 round 练习中心 materialize");

let skippedAttemptReads = 0;
const skippedAttemptHook = (row: Attempt) => { skippedAttemptReads += 1; return row; };
studyDb.attempts.hook("reading", skippedAttemptHook);
const lightweightHistory = await readPracticeSetupHistoryForQuestionIds(targetIds, { includeAttempts: false });
studyDb.attempts.hook("reading").unsubscribe(skippedAttemptHook);
assert.equal(lightweightHistory.attempts.length, 0, "无需逐条作答语义时 read-model 应返回空 attempts");
assert.equal(skippedAttemptReads, 0, "普通开始练习路径不得 materialize attempts");

let emptyReads = 0;
const emptyAttemptHook = (row: Attempt) => { emptyReads += 1; return row; };
studyDb.attempts.hook("reading", emptyAttemptHook);
assert.deepEqual(await readPracticeSetupHistoryForQuestionIds([]), { stats: [], roundsProgress: [], attempts: [] }, "空题集必须直接返回空 read-model");
studyDb.attempts.hook("reading").unsubscribe(emptyAttemptHook);
assert.equal(emptyReads, 0, "空题集不得触发历史表读取");

await studyDb.close();
console.log("practice setup performance tests passed: targeted stats/progress reads and 100k attempt cardinality");
