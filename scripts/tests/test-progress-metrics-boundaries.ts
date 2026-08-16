import assert from "node:assert/strict";
import {
  addAttemptToDailyStats,
  buildAttemptStats,
  calculateDifficulty,
  needsWrongReview,
  statsNeedWrongReview,
  summarizeAttempts,
} from "../../src/lib/practice/practice-metrics";
import {
  buildScopedQuestionStats,
  calculateProgressCompletion,
  isQuestionDoneInScope,
  normalizeProgressScope,
  progressScopeCutoff,
  progressScopeKey,
  progressScopeLabel,
  scopedStatsToLegacyAttemptStats,
  summarizeScopedQuestionStats,
  type ProgressScope,
} from "../../src/lib/practice/progress-scope";
import type { AttemptV7, ReviewRoundProgress } from "../../src/lib/db/v7-types";

const T0 = "2026-08-16T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const at = (dayOffset: number, hour = 0): string => new Date(Date.parse(T0) + dayOffset * DAY + hour * 3600_000).toISOString();
const attempt = (id: string, questionId: string, createdAt: string, correct: boolean, selected = "A"): AttemptV7 => ({
  id,
  runId: "run",
  questionId,
  selected,
  correct,
  elapsedMs: 10,
  createdAt,
  deviceId: "device",
});
const round = (roundId: string, questionId: string, attempts: number, correct: number, wrong: number): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}`,
  roundId,
  questionId,
  attempts,
  correct,
  wrong,
  firstAttemptAt: T0,
  latestAttemptAt: T0,
});

// ---------------------------------------------------------------------------
// normalizeProgressScope / label / key / cutoff
// ---------------------------------------------------------------------------
{
  assert.deepEqual(normalizeProgressScope(null), { type: "rolling", days: 90 });
  assert.deepEqual(normalizeProgressScope({ type: "rolling", days: 0 }), { type: "rolling", days: 90 });
  assert.deepEqual(normalizeProgressScope({ type: "rolling", days: -1 }), { type: "rolling", days: 90 });
  assert.deepEqual(normalizeProgressScope({ type: "rolling", days: 1.5 }), { type: "rolling", days: 90 });
  assert.deepEqual(normalizeProgressScope({ type: "rolling", days: 30 }), { type: "rolling", days: 30 });
  assert.deepEqual(normalizeProgressScope({ type: "round", roundId: "  r1  " }), { type: "round", roundId: "r1" });
  assert.deepEqual(normalizeProgressScope({ type: "round", roundId: "   " }), { type: "rolling", days: 90 });
  assert.equal(progressScopeKey({ type: "rolling", days: 30 }), "rolling:30");
  assert.equal(progressScopeLabel({ type: "rolling", days: 30 }), "近 30 天");
  assert.equal(progressScopeCutoff({ type: "rolling", days: 3 }, T0), Date.parse(T0) - 3 * DAY);
  assert.equal(progressScopeCutoff({ type: "lifetime" }, T0), null);
  assert.throws(() => progressScopeCutoff({ type: "rolling", days: 3 }, "bad-date"), /valid date/);
}

// ---------------------------------------------------------------------------
// isQuestionDoneInScope
// ---------------------------------------------------------------------------
{
  const scope: ProgressScope = { type: "rolling", days: 2 };
  const stats = [{ questionId: "q1", total: 1, latestAttemptAt: at(-2) }];
  assert.equal(isQuestionDoneInScope("q1", scope, stats, [], T0), true, "恰好 2 天前（包含下界）应算完成");
  const cutoff = Date.parse(T0) - 2 * DAY;
  assert.equal(isQuestionDoneInScope("q1", scope, [{ questionId: "q1", total: 1, latestAttemptAt: new Date(cutoff - 1).toISOString() }], [], T0), false, "比下界早 1ms 应超出窗口");
  assert.equal(isQuestionDoneInScope("q1", scope, stats, [], new Date(Date.parse(T0) - 1)), true, "参考时间回拨 1ms，恰好 2 天前仍应包含");
  assert.equal(isQuestionDoneInScope("q1", { type: "rolling", days: 2 }, [{ questionId: "q1", total: 1, latestAttemptAt: at(-2, 1) }], [], T0), true, "2 天前多 1 小时应算完成");
  assert.equal(isQuestionDoneInScope("q1", scope, [{ questionId: "q1", total: 1, latestAttemptAt: at(1) }], [], T0), false, "未来作答不算完成");
  assert.equal(isQuestionDoneInScope("q1", scope, [{ questionId: "q1", total: 0, latestAttemptAt: at(0) }], [], T0), false, "total=0 不算完成");
  assert.equal(isQuestionDoneInScope("q1", { type: "lifetime" }, [{ questionId: "q1", total: 2, latestAttemptAt: at(-999) }], [], T0), true, "lifetime 只要有过作答");
  assert.equal(isQuestionDoneInScope("q1", { type: "round", roundId: "r1" }, [], [round("r1", "q1", 1, 1, 0)], T0), true);
  assert.equal(isQuestionDoneInScope("q1", { type: "round", roundId: "r1" }, [], [round("r1", "q1", 0, 0, 0)], T0), false, "轮次 0 作答不算完成");
}

// ---------------------------------------------------------------------------
// calculateProgressCompletion
// ---------------------------------------------------------------------------
{
  const scope: ProgressScope = { type: "rolling", days: 2 };
  const stats = [
    { questionId: "q1", total: 1, latestAttemptAt: at(0) },
    { questionId: "q2", total: 1, latestAttemptAt: at(-3) },
  ];
  assert.deepEqual(calculateProgressCompletion(["q1", "q1", "q2"], scope, stats, [], T0), { total: 2, completed: 1, percent: 50 }, "重复题应去重");
  assert.deepEqual(calculateProgressCompletion([], scope, stats, [], T0), { total: 0, completed: 0, percent: 0 });
  assert.deepEqual(
    calculateProgressCompletion(["q1"], { type: "round", roundId: "r1" }, [], [round("r1", "q1", 1, 1, 0)], T0),
    { total: 1, completed: 1, percent: 100 },
  );
  assert.deepEqual(
    calculateProgressCompletion(["q1", "q2"], { type: "round", roundId: "r1" }, [], [round("r1", "q1", 1, 1, 0)], T0),
    { total: 2, completed: 1, percent: 50 },
  );
}

// ---------------------------------------------------------------------------
// buildScopedQuestionStats
// ---------------------------------------------------------------------------
{
  const scope: ProgressScope = { type: "rolling", days: 2 };
  const attempts = [
    attempt("a1", "q1", at(-3), true), // 窗口外
    attempt("a2", "q1", at(-2), false), // 下界包含
    attempt("a3", "q1", at(-1), true),
    attempt("a4", "q1", at(0), false, ""), // 放弃，且未来边界=参考时间
    attempt("a5", "q1", at(1), true), // 未来，排除
    attempt("a6", "q2", at(-1), false),
  ];
  const stats = buildScopedQuestionStats(["q1", "q2"], scope, attempts, [], T0);
  assert.equal(stats.size, 2);
  const q1 = stats.get("q1")!;
  assert.equal(q1.total, 3, "窗口内 3 条（-2/-1/0）");
  assert.equal(q1.correct, 1);
  assert.equal(q1.wrong, 2);
  assert.equal(q1.giveUps, 1);
  assert.equal(q1.totalElapsedMs, 30);
  assert.equal(q1.hasBeenWrong, true);
  assert.equal(q1.currentCorrectStreak, 0, "最后一条错误重置连胜");
  assert.equal(q1.correctStreakAfterWrong, 0, "最后一条错误后连胜为 0");
  assert.equal(q1.firstAttemptAt, at(-2));
  assert.equal(q1.latestAttemptAt, at(0));
  assert.equal(q1.firstAttemptCorrect, false);

  const q2 = stats.get("q2")!;
  assert.equal(q2.correctStreakAfterWrong, 0, "只错一次后无正确");

  // 轮次统计：aggregate 投影无法重建连胜，按约定返回 0 或 row.wrong===0 的 correct。
  const roundStats = buildScopedQuestionStats(["q1"], { type: "round", roundId: "r1" }, [], [round("r1", "q1", 5, 4, 1)], T0);
  const rq1 = roundStats.get("q1")!;
  assert.equal(rq1.total, 5);
  assert.equal(rq1.currentCorrectStreak, 0, "有错误时无法重建连胜");
  const roundStats2 = buildScopedQuestionStats(["q1"], { type: "round", roundId: "r1" }, [], [round("r1", "q1", 5, 5, 0)], T0);
  assert.equal(roundStats2.get("q1")!.currentCorrectStreak, 5, "全对时连胜=正确数");
}

// ---------------------------------------------------------------------------
// summarizeScopedQuestionStats / legacy bridge
// ---------------------------------------------------------------------------
{
  const summary = summarizeScopedQuestionStats(new Map([
    ["q1", {
      questionId: "q1", total: 3, correct: 1, wrong: 2, giveUps: 1, totalElapsedMs: 30,
      firstAttemptAt: at(-2), firstAttemptCorrect: false, latestAttemptAt: at(0),
      hasBeenWrong: true, currentCorrectStreak: 0, correctStreakAfterWrong: 0,
    }],
    ["q2", {
      questionId: "q2", total: 1, correct: 1, wrong: 0, giveUps: 0, totalElapsedMs: 10,
      firstAttemptAt: at(-1), firstAttemptCorrect: true, latestAttemptAt: at(-1),
      hasBeenWrong: false, currentCorrectStreak: 1, correctStreakAfterWrong: 0,
    }],
  ]));
  assert.equal(summary.attempts, 4);
  assert.equal(summary.correct, 2);
  assert.equal(summary.wrong, 2);
  assert.equal(summary.giveUps, 1);
  assert.equal(summary.totalElapsedMs, 40);
  assert.equal(summary.attemptedQuestions, 2);
  assert.equal(summary.firstCorrect, 1);
  assert.equal(summary.firstKnown, 2);
  assert.equal(summary.lastAttemptAt, at(0));

  const legacy = scopedStatsToLegacyAttemptStats({
    questionId: "q1", total: 3, correct: 1, wrong: 2, giveUps: 1, totalElapsedMs: 30,
    firstAttemptAt: at(-2), firstAttemptCorrect: false, latestAttemptAt: at(0),
    hasBeenWrong: true, currentCorrectStreak: 0, correctStreakAfterWrong: 0,
  });
  assert.equal(legacy.total, 3);
  assert.deepEqual(legacy.recentOutcomes, []);
}

// ---------------------------------------------------------------------------
// practice-metrics: attempts / stats / daily / streak
// ---------------------------------------------------------------------------
{
  assert.equal(calculateDifficulty(0, 0), 50);
  assert.equal(calculateDifficulty(8, 0), 10);

  const attempts = [
    attempt("a1", "q", at(-2), true),
    attempt("a2", "q", at(-1), false),
    attempt("a3", "q", at(0), true, ""),
  ];
  const built = buildAttemptStats(attempts);
  assert.equal(built?.total, 3);
  assert.equal(built?.correct, 2);
  assert.equal(built?.wrong, 1);
  assert.equal(built?.giveUps, 1, "空答案算放弃");
  assert.equal(built?.hasBeenWrong, true);
  assert.equal(built?.currentCorrectStreak, 1, "最后一条正确");
  assert.equal(built?.correctStreakAfterWrong, 1, "错误后又正确 1 次");
  assert.equal(statsNeedWrongReview(built, 2), true, "需要 2 连对仍差 1");
  assert.equal(statsNeedWrongReview(buildAttemptStats([attempt("a1", "q", at(-1), false), attempt("a2", "q", at(0), true), attempt("a3", "q", at(0, 1), true)]), 2), false, "错误后 2 连对满足");
  assert.equal(needsWrongReview(attempts, 2), true);
  assert.equal(needsWrongReview(attempts, 1), false, "错误后有 1 连对满足 1");

  const daily = addAttemptToDailyStats(undefined, attempts[0]);
  assert.equal(daily.key, `${at(-2).slice(0, 10)}:q`);
  assert.equal(addAttemptToDailyStats(daily, attempts[1]).total, 2);

  assert.equal(summarizeAttempts(attempts).latest, Date.parse(at(0)));
  assert.equal(summarizeAttempts(attempts).difficulty, calculateDifficulty(3, 1));
}

console.log("progress metrics boundary tests passed");
process.exit(0);
