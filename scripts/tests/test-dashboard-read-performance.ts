import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { readDashboardScopedRowsV7, summarizeDashboardLifetimeStatsV7 } from "../../src/app/shell/dashboard-read-data";
import { dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import type { AttemptStatsV7, AttemptV7, ReviewRoundProgress } from "../../src/lib/db/v7-types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetV7Database();
const referenceTime = Date.parse("2026-09-16T12:00:00.000Z");
const recentAt = "2026-09-15T12:00:00.000Z";
const oldAt = "2025-09-15T12:00:00.000Z";
const attempt = (id: string, questionId: string, createdAt: string): AttemptV7 => ({
  id,
  runId: "dashboard-perf",
  questionId,
  selected: "A",
  correct: true,
  elapsedMs: 1,
  createdAt,
  deviceId: "dashboard-perf",
});

await dbV7.attempts.bulkPut([
  ...Array.from({ length: 10_000 }, (_, index) => attempt(`old-${index}`, `q-${index % 500}`, oldAt)),
  attempt("recent-1", "q-1", recentAt),
  attempt("recent-2", "q-2", recentAt),
  attempt("recent-3", "q-3", recentAt),
]);

let attemptReads = 0;
const attemptHook = (row: AttemptV7) => { attemptReads += 1; return row; };
dbV7.attempts.hook("reading", attemptHook);
const rolling = await readDashboardScopedRowsV7(["q-1", "q-2", "q-3"], { type: "rolling", days: 90 }, referenceTime, { allQuestions: true });
dbV7.attempts.hook("reading").unsubscribe(attemptHook);
assert.equal(rolling.attempts.length, 3, "全题库滚动统计只应读取时间窗口内 attempts");
assert.equal(attemptReads, 3, "10,000 条窗口外 attempts 不得被 Dashboard materialize");
assert.equal(rolling.roundProgress.length, 0, "非轮次统计不得读取 round progress");

attemptReads = 0;
dbV7.attempts.hook("reading", attemptHook);
const scopedRolling = await readDashboardScopedRowsV7(["q-1"], { type: "rolling", days: 90 }, referenceTime, { allQuestions: false });
dbV7.attempts.hook("reading").unsubscribe(attemptHook);
assert.equal(scopedRolling.attempts.length, 1, "指定题集滚动统计只需要窗口内且命中的 attempts");
assert.equal(attemptReads, 3, "指定题集滚动统计可扫描窗口内行，但不得 materialize 10,000 条窗口外历史");

const round = (id: string, roundId: string, questionId: string): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}:${id}`,
  roundId,
  questionId,
  attempts: 1,
  correct: 1,
  wrong: 0,
  firstAttemptAt: recentAt,
  latestAttemptAt: recentAt,
  giveUps: 0,
  totalElapsedMs: 1,
  firstAttemptCorrect: true,
  hasBeenWrong: false,
  currentCorrectStreak: 1,
  correctStreakAfterWrong: 0,
  recentOutcomes: [{ id, createdAt: recentAt, correct: true, elapsedMs: 1 }],
});
await dbV7.reviewRoundProgress.bulkPut([
  ...Array.from({ length: 10_000 }, (_, index) => round(`other-${index}`, `round-${index}`, `q-${index % 500}`)),
  round("target-1", "round-target", "q-1"),
  round("target-2", "round-target", "q-2"),
]);

attemptReads = 0;
let roundReads = 0;
const roundHook = (row: ReviewRoundProgress) => { roundReads += 1; return row; };
dbV7.attempts.hook("reading", attemptHook);
dbV7.reviewRoundProgress.hook("reading", roundHook);
const roundRows = await readDashboardScopedRowsV7(["q-1", "q-2"], { type: "round", roundId: "round-target" }, referenceTime, { allQuestions: true });
dbV7.attempts.hook("reading").unsubscribe(attemptHook);
dbV7.reviewRoundProgress.hook("reading").unsubscribe(roundHook);
assert.equal(attemptReads, 0, "轮次统计不得读取 attempts");
assert.equal(roundReads, 2, "轮次统计只应 materialize 指定 round 的 progress");
assert.equal(roundRows.roundProgress.length, 2);

// Lifetime Dashboard 只展示聚合值，不需要重新 materialize immutable attempts。
const lifetimeStats = (questionId: string, total: number, correct: number): AttemptStatsV7 => ({
  questionId,
  total,
  correct,
  wrong: total - correct,
  giveUps: 0,
  totalElapsedMs: total,
  firstAttemptAt: oldAt,
  firstAttemptCorrect: true,
  latestAttemptAt: recentAt,
  hasBeenWrong: correct !== total,
  correctStreakAfterWrong: correct !== total ? 1 : 0,
  currentCorrectStreak: 1,
  recentOutcomes: [],
});
await dbV7.attemptStats.bulkPut([
  lifetimeStats("q-1", 21, 20),
  lifetimeStats("q-2", 21, 19),
  lifetimeStats("q-3", 21, 18),
]);

attemptReads = 0;
let statsReads = 0;
const statsHook = (row: AttemptStatsV7) => { statsReads += 1; return row; };
dbV7.attempts.hook("reading", attemptHook);
dbV7.attemptStats.hook("reading", statsHook);
const scoped = await readDashboardScopedRowsV7(["q-1"], { type: "lifetime" }, referenceTime, { allQuestions: false });
dbV7.attempts.hook("reading").unsubscribe(attemptHook);
dbV7.attemptStats.hook("reading").unsubscribe(statsHook);
assert.equal(scoped.attempts.length, 0, "指定题库 lifetime Dashboard 不需要 immutable attempts");
assert.equal(attemptReads, 0, "指定题库 lifetime Dashboard 不得 materialize 历史 attempts");
assert.equal(statsReads, 1, "指定题库 lifetime Dashboard 只读取目标题目的 attemptStats");
assert.equal(scoped.attemptStats[0]?.total, 21);

attemptReads = 0;
statsReads = 0;
dbV7.attempts.hook("reading", attemptHook);
dbV7.attemptStats.hook("reading", statsHook);
const lifetime = await readDashboardScopedRowsV7(["q-1", "q-2", "q-3"], { type: "lifetime" }, referenceTime, { allQuestions: true });
dbV7.attempts.hook("reading").unsubscribe(attemptHook);
dbV7.attemptStats.hook("reading").unsubscribe(statsHook);
assert.equal(attemptReads, 0, "全部时间 Dashboard 不得重新 materialize 全量 attempts");
assert.equal(statsReads, 3, "全部时间 Dashboard 只应读取题目级 attemptStats");
assert.equal(lifetime.attemptStats.length, 3);
assert.equal(lifetime.attemptStats.reduce((sum, row) => sum + row.total, 0), 63);
assert.deepEqual(summarizeDashboardLifetimeStatsV7(lifetime.attemptStats), { attempts: 63, correct: 57, lastAttemptAt: recentAt });

await dbV7.close();
console.log("dashboard read performance tests passed: rolling/round/scoped reads avoid unrelated history scans");
