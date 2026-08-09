import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import Dexie from "dexie";
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
type PracticeSession = import("../lib/types").PracticeSession;
type Question = import("../lib/types").Question;
type SyncEvent = import("../lib/types").SyncEvent;

const databaseName = "memory-line-study";

async function deleteDatabase() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("无法删除测试数据库：仍有连接未关闭。"));
  });
}

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

function makeSession(run: PracticeRun, bank: Bank, question: Question): PracticeSession {
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

// Construct a genuine v6 IndexedDB database first. Importing lib/db then exercises
// the production v7 upgrade callback instead of only testing a fresh database.
await deleteDatabase();
const legacy = new Dexie(databaseName);
legacy.version(6).stores({
  banks: "id, folderId, sortOrder, importedAt, updatedAt",
  bankFolders: "id, sortOrder, updatedAt",
  questions: "id, bankId, type, *tags, normalizedStem",
  attempts: "id, questionId, bankId, runId, correct, createdAt, deviceId",
  notes: "questionId, updatedAt",
  practiceRuns: "id, status, startedAt, updatedAt",
  questionGroups: "id, type, updatedAt",
  events: "id, synced, createdAt, deviceId",
  syncFiles: "path, sha, appliedAt",
  tombstones: "key, entityType, entityId, deletedAt",
  sessions: "id, bankId, updatedAt",
});
await legacy.open();
await legacy.table("banks").put(legacyBank);
await legacy.table("questions").put(legacyQuestion);
await legacy.table("attempts").bulkPut([
  makeAttempt({ id: "legacy-a1", questionId: legacyQuestion.id, bankId: legacyBank.id, createdAt: "2026-01-01T12:00:00.000Z", correct: false }),
  makeAttempt({ id: "legacy-a2", questionId: legacyQuestion.id, bankId: legacyBank.id, createdAt: "2026-01-02T12:00:00.000Z", correct: true }),
]);
await legacy.table("events").put({
  id: "legacy-event", type: "attempt.created", payload: {}, deviceId: "legacy-device",
  createdAt: "2026-01-02T12:00:00.000Z", synced: 0,
});
const legacyRun = makeRun({ id: "legacy-run", updatedAt: "2026-01-02T12:00:00.000Z", status: "completed" }, legacyBank, legacyQuestion);
await legacy.table("practiceRuns").put(legacyRun);
await legacy.close();

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
  savePracticeSession,
  setPracticeRunStatus,
} = dbModule;
const { calendarDate, statsNeedWrongReview } = metricsModule;

await db.open();
assert.equal(db.verno, 7, "v6 database must upgrade to DB v7");
assert.equal(await db.attemptStats.count(), 1, "v7 upgrade must backfill attemptStats");
assert.equal(await db.attemptDailyStats.count(), 2, "v7 upgrade must backfill daily attempt stats");
const migratedStats = await db.attemptStats.get(legacyQuestion.id);
assert.equal(migratedStats?.total, 2);
assert.equal(migratedStats?.correct, 1);
assert.equal(migratedStats?.wrong, 1);
assert.equal((await db.practiceRunStats.get("__all__"))?.completed, 1, "v7 upgrade must backfill PracticeRunStats");
assert.ok(Number((await db.events.get("legacy-event"))?.sequence) > 0, "v7 upgrade should assign a monotonic sequence to legacy events");

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
await savePracticeSession(makeSession(run, bank, question));
assert.deepEqual(await db.practiceRunStats.get(bank.id), {
  bankId: bank.id, total: 1, completed: 0, inProgress: 1, abandoned: 0, latestUpdatedAt: run.updatedAt,
});
assert.equal((await db.practiceRunStats.get("__all__"))?.total, 1);
await savePracticeSession(makeSession({ ...run, updatedAt: isoAt(0), revision: 2 }, bank, question));
assert.equal((await db.practiceRunStats.get(bank.id))?.total, 1, "saving a later revision must not double count the run");
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
await savePracticeSession(makeSession(cascadeRun, bank, question));
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
console.log("sync data-model tests passed: v7 upgrade, aggregate consistency, ordering, daily stats, cascades, run stats, checkpoint caps");
