import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

type Attempt = import("../lib/types").Attempt;
type Bank = import("../lib/types").Bank;
type PracticeRun = import("../lib/types").PracticeRun;
type ActivePractice = import("../lib/types").ActivePractice;
type Question = import("../lib/types").Question;
type SyncEvent = import("../lib/types").SyncEvent;

function isoAt(daysFromToday: number, hour = 12, minute = 0, second = 0) {
  const value = new Date();
  value.setHours(hour, minute, second, 0);
  value.setDate(value.getDate() + daysFromToday);
  return value.toISOString();
}

function makeAttempt(input: Partial<Attempt> & Pick<Attempt, "id" | "questionId" | "bankId" | "createdAt">): Attempt {
  return {
    id: input.id,
    runId: input.runId ?? "run-test",
    questionId: input.questionId,
    bankId: input.bankId,
    selected: input.selected ?? (input.correct ? "A" : "B"),
    correct: input.correct ?? false,
    elapsedMs: input.elapsedMs ?? 1_000,
    createdAt: input.createdAt,
    deviceId: input.deviceId ?? "test-device",
  };
}

function makeEvent(input: Omit<SyncEvent, "sequence" | "synced">, sequence: number): SyncEvent {
  return { ...input, sequence, synced: 1 };
}

function makeRun(input: Partial<PracticeRun> & Pick<PracticeRun, "id" | "updatedAt">, bank: Bank, question: Question): PracticeRun {
  return {
    id: input.id,
    bankId: input.bankId ?? bank.id,
    bankIds: input.bankIds ?? [bank.id],
    bankName: input.bankName ?? bank.name,
    mode: input.mode ?? "random30",
    modeLabel: input.modeLabel ?? "测试练习",
    questionIds: input.questionIds ?? [question.id],
    questionTypes: input.questionTypes ?? { [question.id]: question.type },
    answers: input.answers ?? {},
    shuffleOptions: input.shuffleOptions ?? false,
    optionOrders: input.optionOrders ?? {},
    startedAt: input.startedAt ?? input.updatedAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt,
    abandonedAt: input.abandonedAt,
    status: input.status ?? "in_progress",
    revision: input.revision ?? 1,
    lastAnsweredIndex: input.lastAnsweredIndex,
  };
}

function makeActivePractice(run: PracticeRun, bank: Bank, question: Question): ActivePractice {
  return {
    id: "active",
    runId: run.id,
    bankId: run.bankId,
    bankIds: run.bankIds,
    bankName: bank.name,
    mode: run.mode,
    modeLabel: run.modeLabel,
    questionIds: run.questionIds,
    questionTypes: { [question.id]: question.type },
    currentIndex: 0,
    answers: run.answers,
    shuffleOptions: false,
    optionOrders: {},
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    revision: run.revision,
  };
}

const legacyBank: Bank = {
  id: "legacy-bank",
  name: "送电线路工-初级工",
  questionCount: 1,
  importedAt: "2026-01-01T00:00:00.000Z",
};
const legacyQuestion: Question = {
  id: "legacy-question",
  bankId: legacyBank.id,
  bankName: legacyBank.name,
  stem: "旧版本升级测试题",
  normalizedStem: "旧版本升级测试题",
  answer: "A",
  options: ["正确", "错误"],
  type: "判断",
  tags: [],
};

const dbModule = await import("../lib/db");
const metricsModule = await import("../lib/practice-metrics");
const {
  applyRemoteEvents,
  createSyncCheckpoint,
  db,
  deleteBank,
  deleteQuestion,
  deletePracticeRun,
  recordAttempt,
  resetLocalDatabase,
  saveNote,
  savePracticeProgress,
  setPracticeRunStatus,
} = dbModule;
const { calendarDate, statsNeedWrongReview } = metricsModule;

// v9 removes the duplicate active-session table. PracticeRun is the sole
// persisted progress source alongside the restore staging/archive tables.
await resetLocalDatabase();
assert.equal(db.verno, 9, "the current client schema must be DB v9");
assert.equal(db.tables.some((table) => table.name === "sessions"), false, "active sessions must not duplicate practiceRun progress");
assert.ok(db.tables.some((table) => table.name === "syncRestoreAttempts"));
assert.ok(db.tables.some((table) => table.name === "syncRestorePracticeRuns"));
assert.ok(db.tables.some((table) => table.name === "syncArchiveEntries"));
assert.deepEqual(
  db.syncArchiveEntries.schema.indexes.map((index) => index.name),
  ["kind", "id"],
  "archive index must expose kind and id lookups",
);

const bank: Bank = { ...legacyBank, id: "bank-data-model", questionCount: 2 };
const question: Question = { ...legacyQuestion, id: "question-data-model", bankId: bank.id, bankName: bank.name, type: "单选", options: ["甲", "乙"], answer: "A" };
const secondQuestion: Question = { ...question, id: "question-data-model-2" };

await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.bulkPut([question, secondQuestion]);

// Local writes and remote replay must create exactly the same all-time aggregate.
const localAttempts = await Promise.all([
  recordAttempt({ runId: "local-run", questionId: question.id, bankId: bank.id, selected: "B", correct: false, elapsedMs: 900 }),
  recordAttempt({ runId: "local-run", questionId: question.id, bankId: bank.id, selected: "A", correct: true, elapsedMs: 1_100 }),
]);
const localStats = await db.attemptStats.get(question.id);
assert.equal(localStats?.total, 2);
assert.equal(localStats?.correct, 1);
assert.equal(localStats?.wrong, 1);
assert.equal(localStats?.totalElapsedMs, 2_000);
assert.equal((await db.attemptDailyStats.where("questionId").equals(question.id).count()), 1);
const localEvents = await db.events.where("synced").equals(0).toArray();

await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.bulkPut([question, secondQuestion]);
await applyRemoteEvents(localEvents);
const remoteStats = await db.attemptStats.get(question.id);
assert.deepEqual(
  { total: remoteStats?.total, correct: remoteStats?.correct, wrong: remoteStats?.wrong, elapsed: remoteStats?.totalElapsedMs },
  { total: localStats?.total, correct: localStats?.correct, wrong: localStats?.wrong, elapsed: localStats?.totalElapsedMs },
  "remote attempt replay must preserve local aggregate totals",
);
assert.equal(await db.attempts.count(), localAttempts.length);

// Remote event application is intentionally shuffled; the trailing streak must be
// based on createdAt rather than arrival order.
await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.bulkPut([question, secondQuestion]);
const outOfOrderAttempts = [
  makeAttempt({ id: "ooo-1", questionId: question.id, bankId: bank.id, createdAt: "2026-02-01T12:00:00.000Z", correct: false }),
  makeAttempt({ id: "ooo-3", questionId: question.id, bankId: bank.id, createdAt: "2026-02-03T12:00:00.000Z", correct: true }),
  makeAttempt({ id: "ooo-4", questionId: question.id, bankId: bank.id, createdAt: "2026-02-04T12:00:00.000Z", correct: true }),
  makeAttempt({ id: "ooo-2", questionId: question.id, bankId: bank.id, createdAt: "2026-02-02T12:00:00.000Z", correct: false }),
].map((attempt, index) => makeEvent({
  id: `ooo-event-${index}`, type: "attempt.created", payload: attempt, deviceId: "remote-streak", createdAt: attempt.createdAt,
}, index + 1));
await applyRemoteEvents([outOfOrderAttempts[2], outOfOrderAttempts[0], outOfOrderAttempts[3], outOfOrderAttempts[1]]);
const oooStats = await db.attemptStats.get(question.id);
assert.equal(oooStats?.currentCorrectStreak, 2, "out-of-order events must calculate trailing correct streak by timestamp");
assert.equal(oooStats?.correctStreakAfterWrong, 2);
assert.equal(statsNeedWrongReview(oooStats, 3), true);
assert.equal(statsNeedWrongReview(oooStats, 2), false);

// Daily buckets are independent from lifetime attemptStats and support the exact
// retention window used by v3 checkpoints.
await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.bulkPut([question, secondQuestion]);
const dailyDates = [0, 0, -1, -34, -35];
const dailyEvents = dailyDates.map((offset, index) => {
  const createdAt = isoAt(offset, 13, index);
  const attempt = makeAttempt({ id: `daily-${index}`, questionId: question.id, bankId: bank.id, createdAt, correct: index % 2 === 0 });
  return makeEvent({ id: `daily-event-${index}`, type: "attempt.created", payload: attempt, deviceId: "daily-device", createdAt }, index + 20);
});
await applyRemoteEvents(dailyEvents);
const today = calendarDate(new Date());
const todayRows = await db.attemptDailyStats.where("date").equals(today).toArray();
assert.equal(todayRows.find((row) => row.questionId === question.id)?.total, 2);
assert.equal(await db.attemptDailyStats.where("date").equals(calendarDate(isoAt(-34, 13))).count(), 1);
assert.equal(await db.attemptDailyStats.where("date").equals(calendarDate(isoAt(-35, 13))).count(), 1, "local daily stats retain historical rows; checkpoint applies the 35-day bound");

// PracticeRunStats must remain one row per bank plus __all__, even when a run is
// updated repeatedly and later deleted.
await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.bulkPut([question, secondQuestion]);
const run = makeRun({ id: "run-stats", updatedAt: isoAt(-1), revision: 1 }, bank, question);
await savePracticeProgress(makeActivePractice(run, bank, question));
assert.equal(await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved").count(), 0, "starting an empty practice must stay local");
assert.deepEqual(await db.practiceRunStats.get(bank.id), {
  bankId: bank.id, total: 1, completed: 0, inProgress: 1, abandoned: 0, latestUpdatedAt: run.updatedAt,
});
assert.equal((await db.practiceRunStats.get("__all__"))?.total, 1);
await savePracticeProgress(makeActivePractice({ ...run, updatedAt: isoAt(0), revision: 2 }, bank, question));
assert.equal(await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved").count(), 0, "navigation without a submitted answer must not queue sync");
assert.equal((await db.practiceRunStats.get(bank.id))?.total, 1, "saving a later revision must not double count the run");
const answeredRun = {
  ...run,
  updatedAt: isoAt(0, 13, 1),
  revision: 3,
  answers: { [question.id]: { selected: ["A"], submitted: true, correct: true } },
  lastAnsweredIndex: 0,
};
await savePracticeProgress(makeActivePractice(answeredRun, bank, question));
const firstRunEvent = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved").first();
assert.ok(firstRunEvent, "the first submitted answer must queue the practice run");
await savePracticeProgress(makeActivePractice({ ...answeredRun, updatedAt: isoAt(0, 13, 2), revision: 4 }, bank, question));
const unchangedRunEvents = await db.events.where("synced").equals(0).filter((event) => event.type === "practice.run.saved").toArray();
assert.equal(unchangedRunEvents.length, 1, "navigation after answering must not add another run event");
assert.equal(unchangedRunEvents[0].id, firstRunEvent.id);
assert.equal((unchangedRunEvents[0].payload as PracticeRun).revision, 3, "navigation-only revisions must not rewrite the pending answer payload");
const completed = await setPracticeRunStatus(run.id, "completed");
assert.equal(completed?.status, "completed");
assert.deepEqual(
  { total: (await db.practiceRunStats.get(bank.id))?.total, completed: (await db.practiceRunStats.get(bank.id))?.completed, inProgress: (await db.practiceRunStats.get(bank.id))?.inProgress },
  { total: 1, completed: 1, inProgress: 0 },
);
assert.equal(await deletePracticeRun(run.id), true);
assert.equal(await db.practiceRunStats.get(bank.id), undefined);
assert.equal(await db.practiceRunStats.get("__all__"), undefined);

// Question and bank deletion must remove raw attempts, aggregate rows, daily
// rows, notes, runs, and groups. The remote question-delete path is tested too.
await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.bulkPut([question, secondQuestion]);
await recordAttempt({ runId: "cascade-run", questionId: question.id, bankId: bank.id, selected: "B", correct: false, elapsedMs: 500 });
await recordAttempt({ runId: "cascade-run", questionId: secondQuestion.id, bankId: bank.id, selected: "A", correct: true, elapsedMs: 500 });
await saveNote(question.id, "待删除解析");
const cascadeRun = makeRun({ id: "cascade-run", updatedAt: isoAt(0), revision: 1 }, bank, question);
await savePracticeProgress(makeActivePractice(cascadeRun, bank, question));
await db.questionGroups.put({ id: "group-cascade", name: "级联", type: "自定义", description: "", items: [{ questionId: question.id, note: "" }, { questionId: secondQuestion.id, note: "" }], createdAt: isoAt(0), updatedAt: isoAt(0), deviceId: "test" });
await deleteQuestion(question.id);
assert.equal(await db.questions.get(question.id), undefined);
assert.equal(await db.attemptStats.get(question.id), undefined);
assert.equal(await db.attempts.where("questionId").equals(question.id).count(), 0);
assert.equal(await db.attemptDailyStats.where("questionId").equals(question.id).count(), 0);
assert.equal(await db.notes.get(question.id), undefined);
assert.deepEqual((await db.questionGroups.get("group-cascade"))?.items.map((item) => item.questionId), [secondQuestion.id]);
await deleteBank(bank.id);
assert.equal(await db.banks.get(bank.id), undefined);
assert.equal(await db.questions.where("bankId").equals(bank.id).count(), 0);
assert.equal(await db.attemptStats.where("bankId").equals(bank.id).count(), 0);
assert.equal(await db.attemptDailyStats.where("bankId").equals(bank.id).count(), 0);
assert.equal(await db.practiceRuns.get(cascadeRun.id), undefined);
assert.equal(await db.practiceRunStats.get("__all__"), undefined);

await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.bulkPut([question, secondQuestion]);
await applyRemoteEvents([makeEvent({
  id: "remote-question-delete", type: "question.deleted", payload: { id: question.id, deletedAt: isoAt(0) },
  deviceId: "remote-delete", createdAt: isoAt(0),
}, 99)]);
assert.equal(await db.questions.get(question.id), undefined);
assert.equal((await db.banks.get(bank.id))?.questionCount, 1, "remote question deletion must decrement bank.questionCount");

// Checkpoint limits and counts: lifetime totals are complete while raw recent
// attempts/runs and daily buckets are bounded.
await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.bulkPut([question, secondQuestion]);
const checkpointAttempts = Array.from({ length: 2_005 }, (_, index) => {
  const createdAt = index === 2_000 ? isoAt(-34, 14) : index === 2_001 ? isoAt(-35, 14) : isoAt(0, 14, 0, index % 60);
  return makeAttempt({ id: `checkpoint-attempt-${index}`, questionId: question.id, bankId: bank.id, createdAt, correct: index % 3 !== 0 });
});
await applyRemoteEvents(checkpointAttempts.map((attempt, index) => makeEvent({
  id: `checkpoint-attempt-event-${index}`, type: "attempt.created", payload: attempt, deviceId: "checkpoint-device", createdAt: attempt.createdAt,
}, index + 1)));
const checkpointRuns = Array.from({ length: 101 }, (_, index) => makeRun({
  id: `checkpoint-run-${index}`, updatedAt: isoAt(0, 15, 0, index % 60), revision: 1,
}, bank, question));
await applyRemoteEvents(checkpointRuns.map((run, index) => makeEvent({
  id: `checkpoint-run-event-${index}`, type: "practice.run.saved", payload: run, deviceId: "checkpoint-run-device", createdAt: run.updatedAt,
}, 10_000 + index)));
const checkpoint = await createSyncCheckpoint();
assert.equal(checkpoint.state.recentAttempts.length, 2_000);
assert.equal(checkpoint.state.recentPracticeRuns.length, 100);
assert.equal(checkpoint.counts.totalAttempts, 2_005);
assert.equal(checkpoint.counts.recentAttempts, 2_000);
assert.equal(checkpoint.counts.totalPracticeRuns, 101);
assert.equal(checkpoint.counts.recentPracticeRuns, 100);
assert.equal(checkpoint.state.attemptStats.find((stats) => stats.questionId === question.id)?.total, 2_005);
const retainedDates = new Set(checkpoint.state.recentAttemptDailyStats.map((row) => row.date));
assert.equal(retainedDates.has(calendarDate(isoAt(-34, 14))), true);
assert.equal(retainedDates.has(calendarDate(isoAt(-35, 14))), false);
assert.equal(checkpoint.retention.recentAttemptLimit, 2_000);
assert.equal(checkpoint.retention.recentPracticeRunLimit, 100);
assert.equal(checkpoint.retention.dailyStatsDays, 35);

await db.delete();
console.log("sync data-model tests passed: DB v9 single progress source, aggregate consistency, ordering, daily stats, cascades, run stats, checkpoint caps");
