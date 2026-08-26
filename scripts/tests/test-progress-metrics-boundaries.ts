import assert from "node:assert/strict";
import {
  addAttemptToDailyStats,
  attemptGapFactor,
  buildAttemptStats,
  calibrateDifficultyLearningRate,
  calculateDifficulty,
  difficultyFromOutcomes,
  needsWrongReview,
  reviewPriorityFromDifficulty,
  runActivityAt,
  statsNeedWrongReview,
  summarizeAttemptStats,
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
  scopedStatsToAttemptStats,
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
  giveUps: 0,
  totalElapsedMs: attempts * 10,
  firstAttemptAt: T0,
  firstAttemptCorrect: correct > 0,
  latestAttemptAt: T0,
  hasBeenWrong: wrong > 0,
  currentCorrectStreak: wrong > 0 ? 0 : correct,
  correctStreakAfterWrong: 0,
  recentOutcomes: Array.from({ length: attempts }, (_, index) => ({
    id: `${roundId}:${questionId}:${index}`,
    createdAt: T0,
    correct: index < correct,
    elapsedMs: 10,
  })),
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
  assert.equal(isQuestionDoneInScope("q1", { type: "round", roundId: "r1" }, [], [], T0), false, "没有轮次进度行时不算完成");
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
  // 窗口和轮次口径都携带完整作答证据，供当前个人难度模型使用。
  assert.equal(stats.get("q1")!.recentOutcomes?.length, 3, "rolling 窗口内的作答应生成 outcomes 序列");
  assert.equal(stats.get("q1")!.recentOutcomes?.[0].elapsedMs, 10);
  assert.equal(buildScopedQuestionStats(["q1"], { type: "round", roundId: "r1" }, [], [round("r1", "q1", 5, 4, 1)], T0).get("q1")!.recentOutcomes.length, 5);
  const roundWithEvidence: ReviewRoundProgress = {
    ...round("r2", "q1", 2, 2, 0),
    giveUps: 0,
    totalElapsedMs: 28_000,
    firstAttemptCorrect: true,
    hasBeenWrong: false,
    currentCorrectStreak: 2,
    correctStreakAfterWrong: 0,
    recentOutcomes: [
      { id: "r2:a1", createdAt: at(-2), correct: true, elapsedMs: 20_000 },
      { id: "r2:a2", createdAt: at(-1), correct: true, elapsedMs: 8_000 },
    ],
  };
  const roundEvidenceStats = buildScopedQuestionStats(["q1"], { type: "round", roundId: "r2" }, [], [roundWithEvidence], T0).get("q1")!;
  assert.equal(roundEvidenceStats.recentOutcomes?.length, 2, "新轮次投影应携带与普通练习一致的难度证据");
  assert.equal(summarizeAttemptStats(scopedStatsToAttemptStats(roundEvidenceStats), T0).difficulty, 23, "轮次个人难度应与同一作答序列的普通练习口径一致");
  assert.equal(scopedStatsToAttemptStats(stats.get("q1")!).recentOutcomes.length, 3, "统计转换应透传窗口内序列");
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

  const converted = scopedStatsToAttemptStats({
    questionId: "q1", total: 3, correct: 1, wrong: 2, giveUps: 1, totalElapsedMs: 30,
    firstAttemptAt: at(-2), firstAttemptCorrect: false, latestAttemptAt: at(0),
    hasBeenWrong: true, currentCorrectStreak: 0, correctStreakAfterWrong: 0,
    recentOutcomes: [
      { id: "q1:0", createdAt: at(-2), correct: false, elapsedMs: 10 },
      { id: "q1:1", createdAt: at(-1), correct: false, elapsedMs: 10 },
      { id: "q1:2", createdAt: at(0), correct: true, elapsedMs: 10 },
    ],
  });
  assert.equal(converted.total, 3);
  assert.equal(converted.recentOutcomes.length, 3);
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
  // 难度 v2：10ms 作答时间不入基准（<1s 视为噪声），首次/无基准做对按 q=0.9 计。
  assert.equal(summarizeAttempts(attempts).difficulty, 41);
}

// ---------------------------------------------------------------------------
// 难度 v2：时间感知（相对自己历史中位速度）+ 间隔感知（秒级对数插值）EMA
// ---------------------------------------------------------------------------
{
  const HOUR = 3_600_000;
  const T1 = "2026-08-01T00:00:00.000Z";
  const outcome = (hoursFromStart: number, correct: boolean, elapsedMs: number) => ({
    correct,
    createdAt: new Date(Date.parse(T1) + hoursFromStart * HOUR).toISOString(),
    elapsedMs,
  });
  // 逐步轨迹：对前缀序列逐个求难度，观察演化路径。
  const trajectory = (...outcomes: ReturnType<typeof outcome>[]) =>
    outcomes.map((_, index) => difficultyFromOutcomes(outcomes.slice(0, index + 1)));

  // 间隔权重锚点与单调性（秒级连续插值，不按日历天）。
  assert.equal(attemptGapFactor(60), 0.2);
  assert.equal(attemptGapFactor(600), 0.2);
  assert.equal(attemptGapFactor(43_200), 1);
  assert.equal(attemptGapFactor(86_400), 1);
  assert.ok(Math.abs(attemptGapFactor(1_800) - 0.406) < 0.01, "30min ≈ 0.41");
  assert.ok(Math.abs(attemptGapFactor(3_600) - 0.535) < 0.01, "1h ≈ 0.53");
  assert.ok(Math.abs(attemptGapFactor(21_600) - 0.87) < 0.01, "6h ≈ 0.87");
  assert.ok(attemptGapFactor(1_200) < attemptGapFactor(7_200) && attemptGapFactor(7_200) < attemptGapFactor(10_800), "间隔权重随秒数单调递增");

  // 空序列 = 未作答 = 50。
  assert.equal(difficultyFromOutcomes([]), 50);

  // 瞬时记忆防护：同场连刷（间隔 6 分钟）×5 只降到 29、×10 渐近 29（旧公式 17 / 8）。
  assert.deepEqual(trajectory(
    outcome(0, true, 20_000),
    outcome(0.1, true, 8_000),
    outcome(0.2, true, 6_000),
    outcome(0.3, true, 5_000),
    outcome(0.4, true, 4_000),
  ), [36, 33, 31, 31, 29], "同场快速连对应缓慢下降");
  assert.deepEqual(trajectory(...Array.from({ length: 10 }, (_, index) => outcome(index * 0.1, true, index === 0 ? 20_000 : 8_000 - index * 300)))
    .at(-1), 29, "同场连刷 10 次应渐近稳定，不再骤降");

  // 隔 13h 快速连对（每次都明显快于自己中位）→ 真掌握，较快变容易。
  assert.deepEqual(trajectory(
    outcome(0, true, 20_000),
    outcome(13, true, 8_000),
    outcome(26, true, 6_000),
    outcome(39, true, 4_000),
  ), [36, 23, 15, 10], "跨半天快速连对应显著降低难度");

  // 隔 13h 但慢于自己常态（30s vs 基准 20s = 1.5×）→ 做对了难度反而回调。
  assert.deepEqual(trajectory(
    outcome(0, true, 20_000),
    outcome(13, true, 30_000),
    outcome(26, true, 32_000),
  ).at(-1), 47, "慢于常态的做对不应降低难度");

  // 做错（退步信号不降权）快速上升；错后连对渐进恢复。
  assert.deepEqual(trajectory(outcome(0, false, 20_000), outcome(13, false, 25_000)), [68, 79], "做错应快速推高难度");
  assert.deepEqual(trajectory(
    outcome(0, false, 20_000),
    outcome(13, true, 8_000),
    outcome(26, true, 6_000),
  ), [68, 47, 40], "错误耗时不进入速度基线，错后正确先按中性证据渐进恢复");

  assert.equal(
    difficultyFromOutcomes([outcome(0, false, 2_000), outcome(13, true, 8_000), outcome(26, true, 6_000)]),
    difficultyFromOutcomes([outcome(0, false, 600_000), outcome(13, true, 8_000), outcome(26, true, 6_000)]),
    "错误和不会的耗时不得改变后续正确作答的速度基线",
  );

  assert.throws(() => difficultyFromOutcomes([{ correct: true, createdAt: T1, elapsedMs: Number.NaN }]), /elapsedMs/, "current outcomes reject invalid elapsedMs");
  assert.doesNotThrow(() => difficultyFromOutcomes([outcome(0, true, 20_000), outcome(13, true, 500)]), "sub-second valid timings must remain valid");
  assert.doesNotThrow(() => difficultyFromOutcomes([outcome(0, true, 20_000), outcome(13, true, 25 * 60_000)]), "long valid timings must remain valid");

  // 有 12 条以上本机历史时用 walk-forward Brier score 在有界候选中校准学习率；
  // 短历史保持默认参数，未作答仍固定为 50。
  assert.deepEqual(calibrateDifficultyLearningRate([outcome(0, true, 20_000)]), { learningRate: 0.35, samples: 0, brierScore: null });
  const alternating = Array.from({ length: 12 }, (_, index) => outcome(index * 13, index % 2 === 0, index % 2 === 0 ? 8_000 : 20_000));
  assert.equal(calibrateDifficultyLearningRate(alternating).learningRate, 0.25, "反复波动的成熟历史应选择更稳健的学习率");
  assert.equal(difficultyFromOutcomes([]), 50, "本地校准不得改变未作答默认 50");

  assert.equal(reviewPriorityFromDifficulty(80, null, Date.parse(T1)), 50, "未作答复习优先级继续默认 50");
  assert.equal(reviewPriorityFromDifficulty(80, Date.parse(T1), Date.parse(T1)), 56, "刚作答时优先级主要来自个人难度");
  assert.equal(reviewPriorityFromDifficulty(20, Date.parse(T1), Date.parse(T1) + 30 * DAY), 44, "长时间未复习应提高低难度题的复习优先级");

  // 中位基准抗离群：一次 10 分钟（接电话）后，8s 仍明显快于中位、恢复下降。
  assert.deepEqual(trajectory(
    outcome(0, true, 20_000),
    outcome(13, true, 600_000),
    outcome(26, true, 8_000),
  ).at(-1), 28, "单次超长作答不应击穿速度基准");

  // 聚合行读取路径：recentOutcomes 直接驱动 EMA 难度。
  assert.equal(summarizeAttemptStats({
    questionId: "q", bankId: "", total: 2, correct: 2, wrong: 0, giveUps: 0, totalElapsedMs: 28_000,
    firstAttemptAt: at(0), firstAttemptCorrect: true, latestAttemptAt: at(0), hasBeenWrong: false,
    correctStreakAfterWrong: 0, currentCorrectStreak: 2,
    recentOutcomes: [
      { id: "a1", createdAt: at(-2), correct: true, elapsedMs: 20_000 },
      { id: "a2", createdAt: at(-1), correct: true, elapsedMs: 8_000 },
    ],
  }).difficulty, 23, "聚合行有 outcomes 时按 EMA 估计（跨天快速连对第二步）");
  // 写入链把作答时间记进 recentOutcomes。
  const builtChain = buildAttemptStats([attempt("a1", "q", at(-2), true), attempt("a2", "q", at(-1), false)]);
  assert.equal(builtChain?.recentOutcomes[0].elapsedMs, 10);
  assert.equal(builtChain?.recentOutcomes[1].elapsedMs, 10);
  assert.equal(builtChain?.recentOutcomes.length, 2, "recentOutcomes 截断上限仍为 32（此处 2）");
}

// ===== 练习记录的活动时间：排序口径（已完成=完成时间，其余=最后一道作答题的时间）=====
{
  type Answer = { submitted: boolean; updatedAt?: string };
  const run = (overrides: Partial<Parameters<typeof runActivityAt>[0]>) =>
    ({ status: "in_progress", startedAt: "2026-08-01T00:00:00.000Z", answers: {}, ...overrides }) as Parameters<typeof runActivityAt>[0];
  const answers = (...entries: Array<[string, boolean]>): Record<string, Answer> =>
    Object.fromEntries(entries.map(([updatedAt, submitted], index) => [`q${index}`, { submitted, updatedAt }]));

  assert.equal(
    runActivityAt(run({ status: "completed", completedAt: "2026-08-15T08:00:00.000Z", startedAt: "2026-08-01T00:00:00.000Z", answers: answers(["2026-08-14T22:00:00.000Z", true]) })),
    "2026-08-15T08:00:00.000Z",
    "已完成按完成时间排序（不是开始时间，也不是最后一题时间）",
  );
  assert.throws(() => runActivityAt(run({ status: "completed", answers: answers(["2026-08-14T22:00:00.000Z", true]) })), /completedAt/, "completed current runs require completedAt");
  assert.equal(
    runActivityAt(run({ startedAt: "2026-08-01T00:00:00.000Z", answers: answers(["2026-08-16T09:00:00.000Z", true], ["2026-08-16T10:30:00.000Z", true], ["2026-08-16T10:00:00.000Z", true]) })),
    "2026-08-16T10:30:00.000Z",
    "进行中取多道作答里最新的 updatedAt",
  );
  assert.equal(
    runActivityAt(run({ startedAt: "2026-08-01T00:00:00.000Z", answers: { q1: { submitted: false, updatedAt: "2026-08-16T12:00:00.000Z" }, q2: { submitted: true, updatedAt: "2026-08-16T09:00:00.000Z" } } })),
    "2026-08-16T09:00:00.000Z",
    "未提交的暂存选择不算做题（只有 submitted 才计入活动时间）",
  );
  assert.equal(
    runActivityAt(run({ status: "abandoned", abandonedAt: "2026-08-16T12:00:00.000Z", answers: answers(["2026-08-16T09:00:00.000Z", true]) })),
    "2026-08-16T09:00:00.000Z",
    "已放弃按最后一道作答题的时间（不按放弃时间，完成时间口径只属于已完成）",
  );
  assert.equal(
    runActivityAt(run({ status: "abandoned", abandonedAt: "2026-08-16T12:00:00.000Z" })),
    "2026-08-16T12:00:00.000Z",
    "未作答的已放弃记录使用 abandonedAt",
  );
  assert.throws(() => runActivityAt(run({ startedAt: "2026-08-01T00:00:00.000Z", answers: { q1: { submitted: true } as Answer } })), /updatedAt/, "submitted current answers require updatedAt");
}

// ===== 错题口径：scoped（进度口径）与 lifetime（终身）的区分性用例 =====
// 练习入口的 wrong 判定与题库页一致使用 scoped 统计：窗口外的历史不影响窗口内判定。
{
  const scope = normalizeProgressScope({ type: "rolling", days: 30 });
  // 场景 1：错题发生在窗口内、随后的连对也在窗口内 → 连对数满足即移出。
  const inWindow = buildScopedQuestionStats(["q1"], scope, [
    attempt("w1", "q1", at(-10), false),
    attempt("w2", "q1", at(-9), true),
    attempt("w3", "q1", at(-8), true),
  ], [], Date.parse(T0));
  const inWindowLegacy = scopedStatsToAttemptStats(inWindow.get("q1")!);
  assert.equal(statsNeedWrongReview(inWindowLegacy, 2), false, "窗口内错后 2 连对应移出错题");

  // 场景 2：错误与连对都在窗口外（40 天前）→ rolling(30) 下 scoped 无记录，不再是错题；
  // 但 lifetime 聚合仍算错题（正确后连对数不足阈值）——证明两种口径的集合不同。
  const staleAttempts = [
    attempt("s1", "q2", at(-40), false),
    attempt("s2", "q2", at(-39), true),
  ];
  const staleScoped = buildScopedQuestionStats(["q2"], scope, staleAttempts, [], Date.parse(T0));
  assert.equal(staleScoped.has("q2"), false, "窗口外作答在 scoped 口径下无记录");
  assert.equal(statsNeedWrongReview(undefined, 2), false, "窗口外错题在 scoped 口径下不再算错题（与 startPractice 的传法一致）");
  assert.equal(statsNeedWrongReview(buildAttemptStats(staleAttempts), 2), true, "同一数据在 lifetime 口径下仍是错题（口径差异的证明）");

  // 场景 3：错误在窗口内、连对在窗口外（先对后错）→ scoped 只见错误，仍是错题。
  const wrongRecent = buildScopedQuestionStats(["q3"], scope, [
    attempt("r1", "q3", at(-40), true),
    attempt("r2", "q3", at(-5), false),
  ], [], Date.parse(T0));
  assert.equal(statsNeedWrongReview(scopedStatsToAttemptStats(wrongRecent.get("q3")!), 2), true, "窗口内的错误即使之前有历史连对也仍是错题");

  // 场景 4：round 口径下 wrong>0 恒为错题（correctStreakAfterWrong 恒 0，既定行为）。
  const roundScoped = buildScopedQuestionStats(["q4"], normalizeProgressScope({ type: "round", roundId: "round-1" }), [], [
    round("round-1", "q4", 6, 5, 1),
  ], Date.parse(T0));
  assert.equal(statsNeedWrongReview(scopedStatsToAttemptStats(roundScoped.get("q4")!), 1), true, "轮次内错过永不移出（既定行为）");
}

console.log("progress metrics boundary tests passed");
process.exit(0);
