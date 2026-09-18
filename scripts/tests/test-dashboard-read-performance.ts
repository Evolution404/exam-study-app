import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import { readDashboardScopedRows, summarizeDashboardLifetimeStats } from "../../src/app/shell/dashboard-read-data";
import { studyDb, resetDatabase } from "../../src/lib/db/db";
import type { AttemptStats, Attempt, ReviewRoundProgress } from "../../src/lib/db/types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

const dashboardOwnerSource = readFileSync(new URL("../../src/app/shell/use-dashboard-data.ts", import.meta.url), "utf8");
assert.equal(
  (dashboardOwnerSource.match(/bankQuestionMemberships\.where\("bankId"\)/g) ?? []).length,
  1,
  "Dashboard selected-bank scope must resolve memberships once for progress + stats",
);
assert.doesNotMatch(
  dashboardOwnerSource,
  /const scopeProgress = useLiveQuery/,
  "Dashboard progress must derive from the shared scoped query instead of owning a duplicate live query",
);

await resetDatabase();
const referenceTime = Date.parse("2026-09-16T12:00:00.000Z");
const recentAt = "2026-09-15T12:00:00.000Z";
const oldAt = "2025-09-15T12:00:00.000Z";
const attempt = (id: string, questionId: string, createdAt: string): Attempt => ({
  id,
  runId: "dashboard-perf",
  questionId,
  selected: "A",
  correct: true,
  elapsedMs: 1,
  createdAt,
  deviceId: "dashboard-perf",
});

await studyDb.attempts.bulkPut([
  ...Array.from({ length: 10_000 }, (_, index) => attempt(`old-${index}`, `q-${index % 500}`, oldAt)),
  attempt("recent-1", "q-1", recentAt),
  attempt("recent-2", "q-2", recentAt),
  attempt("recent-3", "q-3", recentAt),
]);

let attemptReads = 0;
const attemptHook = (row: Attempt) => { attemptReads += 1; return row; };
studyDb.attempts.hook("reading", attemptHook);
const rolling = await readDashboardScopedRows(["q-1", "q-2", "q-3"], { type: "rolling", days: 90 }, referenceTime, { allQuestions: true });
studyDb.attempts.hook("reading").unsubscribe(attemptHook);
assert.equal(rolling.attempts.length, 3, "全题库滚动统计只应读取时间窗口内 attempts");
assert.equal(attemptReads, 3, "10,000 条窗口外 attempts 不得被 Dashboard materialize");
assert.equal(rolling.roundProgress.length, 0, "非轮次统计不得读取 round progress");

const sameWindowNoise = Array.from({ length: 2_000 }, (_, index) => attempt(
  `same-window-noise-${index}`,
  `noise-q-${index}`,
  recentAt,
));
await studyDb.attempts.bulkPut(sameWindowNoise);

attemptReads = 0;
studyDb.attempts.hook("reading", attemptHook);
const scopedRolling = await readDashboardScopedRows(["q-1"], { type: "rolling", days: 90 }, referenceTime, { allQuestions: false });
studyDb.attempts.hook("reading").unsubscribe(attemptHook);
assert.equal(scopedRolling.attempts.length, 1, "指定题集滚动统计只需要窗口内且命中的 attempts");
assert.equal(attemptReads, 1, "指定题集滚动统计不得 materialize 同窗口 2,000 条无关题目 attempts");

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
await studyDb.reviewRoundProgress.bulkPut([
  ...Array.from({ length: 10_000 }, (_, index) => round(`other-${index}`, `round-${index}`, `q-${index % 500}`)),
  round("target-1", "round-target", "q-1"),
  round("target-2", "round-target", "q-2"),
]);

attemptReads = 0;
let roundReads = 0;
const roundHook = (row: ReviewRoundProgress) => { roundReads += 1; return row; };
studyDb.attempts.hook("reading", attemptHook);
studyDb.reviewRoundProgress.hook("reading", roundHook);
const roundRows = await readDashboardScopedRows(["q-1", "q-2"], { type: "round", roundId: "round-target" }, referenceTime, { allQuestions: true });
studyDb.attempts.hook("reading").unsubscribe(attemptHook);
studyDb.reviewRoundProgress.hook("reading").unsubscribe(roundHook);
assert.equal(attemptReads, 0, "轮次统计不得读取 attempts");
assert.equal(roundReads, 2, "轮次统计只应 materialize 指定 round 的 progress");
assert.equal(roundRows.roundProgress.length, 2);

// Lifetime Dashboard 只展示聚合值，不需要重新 materialize immutable attempts。
const lifetimeStats = (questionId: string, total: number, correct: number): AttemptStats => ({
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
await studyDb.questionProgress.bulkPut([
  lifetimeStats("q-1", 21, 20),
  lifetimeStats("q-2", 21, 19),
  lifetimeStats("q-3", 21, 18),
]);

attemptReads = 0;
let statsReads = 0;
const statsHook = (row: AttemptStats) => { statsReads += 1; return row; };
studyDb.attempts.hook("reading", attemptHook);
studyDb.questionProgress.hook("reading", statsHook);
const scoped = await readDashboardScopedRows(["q-1"], { type: "lifetime" }, referenceTime, { allQuestions: false });
studyDb.attempts.hook("reading").unsubscribe(attemptHook);
studyDb.questionProgress.hook("reading").unsubscribe(statsHook);
assert.equal(scoped.attempts.length, 0, "指定题库 lifetime Dashboard 不需要 immutable attempts");
assert.equal(attemptReads, 0, "指定题库 lifetime Dashboard 不得 materialize 历史 attempts");
assert.equal(statsReads, 1, "指定题库 lifetime Dashboard 只读取目标题目的 attemptStats");
assert.equal(scoped.attemptStats[0]?.total, 21);

attemptReads = 0;
statsReads = 0;
studyDb.attempts.hook("reading", attemptHook);
studyDb.questionProgress.hook("reading", statsHook);
const lifetime = await readDashboardScopedRows(["q-1", "q-2", "q-3"], { type: "lifetime" }, referenceTime, { allQuestions: true });
studyDb.attempts.hook("reading").unsubscribe(attemptHook);
studyDb.questionProgress.hook("reading").unsubscribe(statsHook);
assert.equal(attemptReads, 0, "全部时间 Dashboard 不得重新 materialize 全量 attempts");
assert.equal(statsReads, 3, "全部时间 Dashboard 只应读取题目级 attemptStats");
assert.equal(lifetime.attemptStats.length, 3);
assert.equal(lifetime.attemptStats.reduce((sum, row) => sum + row.total, 0), 63);
assert.deepEqual(summarizeDashboardLifetimeStats(lifetime.attemptStats), { attempts: 63, correct: 57, lastAttemptAt: recentAt });

await studyDb.close();
console.log("dashboard read performance tests passed: rolling/round/scoped reads avoid unrelated same-window and historical scans");
