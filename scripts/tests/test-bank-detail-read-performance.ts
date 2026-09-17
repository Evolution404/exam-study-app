import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { readBankDetailDatasetV7 } from "../../src/app/bank/bank-library/bank-detail-read";
import { createBankV7, createQuestionV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import type { AttemptV7, BankV7, PracticeRunV7, ReviewRoundProgress } from "../../src/lib/db/v7-types";
import type { ProgressScope } from "../../src/lib/practice/progress-scope";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetV7Database();
const referenceTime = Date.parse("2026-09-17T00:00:00.000Z");
const oldAt = "2025-01-01T00:00:00.000Z";
const recentAt = "2026-09-16T00:00:00.000Z";
const bank = await createBankV7("题库详情性能");
const question = await createQuestionV7(bank.id, {
  type: "判断",
  stem: "性能题",
  options: ["对", "错"],
  optionIds: ["opt-0", "opt-1"],
  solution: { kind: "choice", correctOptionIds: ["opt-0"] },
});

const attempt = (id: string, createdAt: string): AttemptV7 => ({
  id,
  runId: "bank-detail-perf",
  questionId: question.id,
  selected: "A",
  correct: true,
  elapsedMs: 1,
  createdAt,
  deviceId: "bank-detail-perf",
});
await dbV7.attempts.bulkPut([
  ...Array.from({ length: 1_000 }, (_, index) => attempt(`old-${index}`, oldAt)),
  attempt("recent-1", recentAt),
  attempt("recent-2", recentAt),
  attempt("recent-3", recentAt),
]);
await dbV7.attemptStats.put({
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
await dbV7.practiceRuns.bulkPut(Array.from({ length: 1_000 }, (_, index) => ({
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
  startedAt: new Date(Date.parse(oldAt) + index * 1_000).toISOString(),
  updatedAt: new Date(Date.parse(oldAt) + index * 1_000).toISOString(),
  status: "completed" as const,
  revision: 1,
})));
await dbV7.practiceRunStats.put({
  key: bank.id,
  bankId: bank.id,
  total: 1_000,
  completed: 1_000,
  inProgress: 0,
  abandoned: 0,
  latestUpdatedAt: new Date(Date.parse(oldAt) + 999_000).toISOString(),
});

type ScopedReader = (bank: BankV7, scope: ProgressScope, referenceTime: number) => ReturnType<typeof readBankDetailDatasetV7>;
const scopedReader = readBankDetailDatasetV7 as unknown as ScopedReader;
let attemptReads = 0;
let runReads = 0;
const attemptHook = (row: AttemptV7) => { attemptReads += 1; return row; };
const runHook = (row: PracticeRunV7) => { runReads += 1; return row; };
dbV7.attempts.hook("reading", attemptHook);
dbV7.practiceRuns.hook("reading", runHook);
const rolling = await scopedReader(bank, { type: "rolling", days: 90 }, referenceTime);
dbV7.attempts.hook("reading").unsubscribe(attemptHook);
dbV7.practiceRuns.hook("reading").unsubscribe(runHook);
assert.equal(rolling.attempts.length, 3, "滚动统计只需要窗口内 attempts");
assert.equal(attemptReads, 3, "1,000 条窗口外历史不得被题库详情 materialize");
assert.equal(rolling.runs.length, 5, "题库详情只需要最近 5 条练习记录");
assert.equal(runReads, 5, "1,000 条历史 run 不得被题库详情全部 materialize");

attemptReads = 0;
dbV7.attempts.hook("reading", attemptHook);
const lifetime = await scopedReader(bank, { type: "lifetime" }, referenceTime);
dbV7.attempts.hook("reading").unsubscribe(attemptHook);
assert.equal(lifetime.attempts.length, 0, "全部时间题库统计应直接复用 attemptStats");
assert.equal(attemptReads, 0, "全部时间题库统计不得重新读取 immutable attempts");

const progress = (roundId: string): ReviewRoundProgress => ({
  key: `${roundId}:${question.id}`,
  roundId,
  questionId: question.id,
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
await dbV7.reviewRoundProgress.bulkPut([
  ...Array.from({ length: 1_000 }, (_, index) => progress(`other-${index}`)),
  progress("target-round"),
]);
let roundReads = 0;
const roundHook = (row: ReviewRoundProgress) => { roundReads += 1; return row; };
dbV7.reviewRoundProgress.hook("reading", roundHook);
const round = await scopedReader(bank, { type: "round", roundId: "target-round" }, referenceTime);
dbV7.reviewRoundProgress.hook("reading").unsubscribe(roundHook);
assert.equal(round.roundProgress.length, 1, "轮次统计只需要当前轮次 progress");
assert.equal(roundReads, 1, "其他轮次 progress 不得被题库详情 materialize");

await dbV7.close();
console.log("bank detail read performance tests passed: scoped reads avoid full attempt and round history scans");
