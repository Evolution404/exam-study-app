import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { readBankDetailDataset } from "../../src/app/bank/bank-library/bank-detail-read";
import { createBank, createQuestion, studyDb, resetDatabase } from "../../src/lib/db/db";
import { decomposePracticeRun } from "../../src/lib/db/practice-run-store";
import type { Attempt, AttemptDailyStats, Bank, PracticeRunRecord, PracticeRun, ReviewRoundProgress } from "../../src/lib/db/types";
import type { ProgressScope } from "../../src/lib/practice/progress-scope";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetDatabase();
const referenceTime = Date.parse("2026-09-17T00:00:00.000Z");
const oldAt = "2025-01-01T00:00:00.000Z";
const recentAt = "2026-09-16T00:00:00.000Z";
const bank = await createBank("题库详情性能");
const question = await createQuestion(bank.id, {
  type: "判断",
  stem: "性能题",
  options: ["对", "错"],
  optionIds: ["opt-0", "opt-1"],
  solution: { kind: "choice", correctOptionIds: ["opt-0"] },
});

const attempt = (id: string, createdAt: string): Attempt => ({
  id,
  runId: "bank-detail-perf",
  questionId: question.id,
  selected: "A",
  correct: true,
  elapsedMs: 1,
  createdAt,
  deviceId: "bank-detail-perf",
});
const unrelatedRecentAttempts = Array.from({ length: 2_000 }, (_, index) => ({
  ...attempt(`unrelated-recent-${index}`, recentAt),
  questionId: `unrelated-recent-question-${index}`,
}));
await studyDb.attempts.bulkPut([
  ...Array.from({ length: 1_000 }, (_, index) => attempt(`old-${index}`, oldAt)),
  attempt("recent-1", recentAt),
  attempt("recent-2", recentAt),
  attempt("recent-3", recentAt),
  ...unrelatedRecentAttempts,
]);
await studyDb.questionProgress.put({
  questionId: question.id,
  total: 1_003,
  correct: 1_003,
  wrong: 0,
  giveUps: 0,
  totalElapsedMs: 1_003,
  firstAttemptAt: oldAt,
  firstAttemptCorrect: true,
  latestAttemptAt: recentAt,
  hasBeenWrong: false,
  correctStreakAfterWrong: 0,
  currentCorrectStreak: 1_003,
  recentOutcomes: [],
});
const historyRuns: PracticeRun[] = Array.from({ length: 1_000 }, (_, index) => {
  const activityAt = new Date(Date.parse(oldAt) + index * 1_000).toISOString();
  return {
  id: `history-run-${index}`,
  bankId: bank.id,
  bankIds: [bank.id],
  bankName: bank.name,
  mode: "sequential" as const,
  modeLabel: "练习",
  questionIds: [question.id],
  questionTypes: { [question.id]: "判断" as const },
  answers: {},
  shuffleOptions: false,
  optionOrders: {},
  startedAt: activityAt,
  updatedAt: activityAt,
  completedAt: activityAt,
  status: "completed" as const,
  revision: 1,
  };
});
const historyBundles = historyRuns.map((run) => decomposePracticeRun(run, []));
await studyDb.transaction("rw", [studyDb.practiceRuns, studyDb.practiceRunSources, studyDb.practiceRunItems, studyDb.bankPracticeRunIndex], async () => {
  const records = historyBundles.map((bundle) => bundle.record);
  await studyDb.practiceRuns.bulkPut(records);
  await studyDb.practiceRunSources.bulkPut(historyBundles.flatMap((bundle) => bundle.sources));
  await studyDb.practiceRunItems.bulkPut(historyBundles.flatMap((bundle) => bundle.items));
  await studyDb.bankPracticeRunIndex.bulkPut(historyBundles.flatMap((bundle) =>
    bundle.sources.map((source) => {
      const record = records.find((item) => item.id === source.runId);
      if (!record) throw new Error(`missing seeded run ${source.runId}`);
      return { bankId: source.bankId, runId: source.runId, activityAt: record.activityAt, status: record.status };
    }),
  ));
});
await studyDb.bankPracticeStats.put({
  bankId: bank.id,
  total: 1_000,
  completed: 1_000,
  inProgress: 0,
  abandoned: 0,
  latestActivityAt: new Date(Date.parse(oldAt) + 999_000).toISOString(),
});

type ScopedReader = (bank: Bank, scope: ProgressScope, referenceTime: number) => ReturnType<typeof readBankDetailDataset>;
const scopedReader = readBankDetailDataset as unknown as ScopedReader;
let attemptReads = 0;
let runReads = 0;
const attemptHook = (row: Attempt) => { attemptReads += 1; return row; };
const runHook = (row: PracticeRunRecord) => { runReads += 1; return row; };
studyDb.attempts.hook("reading", attemptHook);
studyDb.practiceRuns.hook("reading", runHook);
const rolling = await scopedReader(bank, { type: "rolling", days: 90 }, referenceTime);
studyDb.attempts.hook("reading").unsubscribe(attemptHook);
studyDb.practiceRuns.hook("reading").unsubscribe(runHook);
assert.equal(rolling.attempts.length, 3, "滚动统计只需要窗口内当前题库 attempts");
assert.equal(attemptReads, 3, "窗口外历史和同窗口 2,000 条无关题目 attempts 都不得被题库详情 materialize");
assert.equal(rolling.runs.length, 5, "题库详情只需要最近 5 条练习记录");
assert.equal(runReads, 5, "1,000 条历史 run 不得被题库详情全部 materialize");

attemptReads = 0;
studyDb.attempts.hook("reading", attemptHook);
const lifetime = await scopedReader(bank, { type: "lifetime" }, referenceTime);
studyDb.attempts.hook("reading").unsubscribe(attemptHook);
assert.equal(lifetime.attempts.length, 0, "全部时间题库统计应直接复用 attemptStats");
assert.equal(attemptReads, 0, "全部时间题库统计不得重新读取 immutable attempts");

const progress = (roundId: string, questionId = question.id): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}`,
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
  recentOutcomes: [],
});
await studyDb.reviewRoundProgress.bulkPut([
  ...Array.from({ length: 1_000 }, (_, index) => progress(`other-${index}`)),
  ...Array.from({ length: 2_000 }, (_, index) => progress("target-round", `unrelated-round-question-${index}`)),
  progress("target-round"),
]);
let roundReads = 0;
const roundHook = (row: ReviewRoundProgress) => { roundReads += 1; return row; };
studyDb.reviewRoundProgress.hook("reading", roundHook);
const round = await scopedReader(bank, { type: "round", roundId: "target-round" }, referenceTime);
studyDb.reviewRoundProgress.hook("reading").unsubscribe(roundHook);
assert.equal(round.roundProgress.length, 1, "轮次统计只需要当前轮次 progress");
assert.equal(roundReads, 1, "同轮次其他题目及其他轮次 progress 都不得被题库详情 materialize");

const daily = (date: string, questionId: string, index: number): AttemptDailyStats => ({
  key: `${date}:${questionId}`,
  date,
  questionId,
  total: 1,
  correct: index % 2,
  wrong: index % 2 ? 0 : 1,
  giveUps: 0,
  totalElapsedMs: 1,
});
const activityDates = ["2026-09-15", "2026-09-16", "2026-09-17"];
await studyDb.questionDailyProgress.bulkPut([
  ...activityDates.map((date, index) => daily(date, question.id, index)),
  ...Array.from({ length: 6_000 }, (_, index) => daily(
    activityDates[index % activityDates.length],
    `unrelated-daily-question-${index}`,
    index,
  )),
]);
let dailyReads = 0;
const dailyHook = (row: AttemptDailyStats) => { dailyReads += 1; return row; };
studyDb.questionDailyProgress.hook("reading", dailyHook);
const activity = await readBankDetailDataset(
  bank,
  { type: "lifetime" },
  referenceTime,
  { from: activityDates[0], to: activityDates[2] },
);
studyDb.questionDailyProgress.hook("reading").unsubscribe(dailyHook);
assert.equal(activity.activityDailyStats.length, activityDates.length, "活动统计只需要当前题库题目的日期窗口行");
assert.equal(dailyReads, activityDates.length, "同日期窗口 6,000 条无关题目统计不得被题库详情 materialize");

await studyDb.close();
console.log("bank detail read performance tests passed: scoped reads avoid unrelated time-window attempts and full history scans");
