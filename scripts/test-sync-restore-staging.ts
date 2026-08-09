import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const {
  clearSyncRestoreStage,
  clearSyncArchiveEntries,
  commitStagedSyncRestore,
  createSyncCheckpoint,
  db,
  filterUnarchivedSyncIds,
  hasSyncArchiveEntry,
  markSyncArchiveEntries,
  resetLocalDatabase,
  stageSyncRestoreAttempts,
  stageSyncRestorePracticeRuns,
} = await import("../lib/db");
const { addAttemptToDailyStats, buildAttemptStats, attemptDailyKey } = await import("../lib/practice-metrics");
type Attempt = import("../lib/types").Attempt;
type PracticeRun = import("../lib/types").PracticeRun;

const bank = {
  id: "staging-bank",
  name: "送电线路工-初级工" as const,
  questionCount: 1,
  importedAt: "2026-01-01T00:00:00.000Z",
};
const question = {
  id: "staging-question",
  bankId: bank.id,
  bankName: bank.name,
  stem: "分段恢复测试",
  normalizedStem: "分段恢复测试",
  answer: "A",
  options: ["甲", "乙"],
  type: "单选" as const,
  tags: [],
};

function makeAttempt(index: number): Attempt {
  return {
    id: `staged-attempt-${String(index).padStart(4, "0")}`,
    runId: `staged-run-${index}`,
    questionId: question.id,
    bankId: bank.id,
    selected: index % 3 === 0 ? "" : index % 2 ? "B" : "A",
    correct: index % 2 === 0,
    elapsedMs: index + 1,
    createdAt: new Date(Date.UTC(2022, 0, 1, 0, index)).toISOString(),
    deviceId: "staging-device",
  };
}

function makeRun(index: number): PracticeRun {
  const updatedAt = new Date(Date.UTC(2022, 0, 1, 0, index)).toISOString();
  return {
    id: `staged-practice-run-${String(index).padStart(4, "0")}`,
    bankId: bank.id,
    bankIds: [bank.id],
    bankName: bank.name,
    mode: "random30",
    modeLabel: "随机练习",
    questionIds: [question.id],
    questionTypes: { [question.id]: "单选" },
    answers: { [question.id]: { selected: ["A"], submitted: true, correct: true } },
    shuffleOptions: false,
    optionOrders: {},
    startedAt: updatedAt,
    updatedAt,
    completedAt: updatedAt,
    status: "completed",
    revision: 1,
  };
}

const attempts = Array.from({ length: 3_200 }, (_, index) => makeAttempt(index));
const practiceRuns = Array.from({ length: 750 }, (_, index) => makeRun(index));

await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.put(question);
await db.attempts.bulkPut(attempts);
const attemptStats = buildAttemptStats(attempts);
assert.ok(attemptStats);
await db.attemptStats.put(attemptStats);
const dailyStats = new Map<string, import("../lib/types").AttemptDailyStats>();
for (const attempt of attempts) {
  const key = attemptDailyKey(attempt);
  dailyStats.set(key, addAttemptToDailyStats(dailyStats.get(key), attempt));
}
await db.attemptDailyStats.bulkPut([...dailyStats.values()]);
await db.practiceRuns.bulkPut(practiceRuns);
await db.practiceRunStats.bulkPut([
  { bankId: "__all__", total: practiceRuns.length, completed: practiceRuns.length, inProgress: 0, abandoned: 0, latestUpdatedAt: practiceRuns.at(-1)!.updatedAt },
  { bankId: bank.id, total: practiceRuns.length, completed: practiceRuns.length, inProgress: 0, abandoned: 0, latestUpdatedAt: practiceRuns.at(-1)!.updatedAt },
]);

const checkpoint = await createSyncCheckpoint();
const plan = { checkpoint, questionIds: new Set(checkpoint.state.questions.map((row) => row.id)) };
const archivedAttempts = attempts.slice(0, attempts.length - checkpoint.state.recentAttempts.length);
const archivedRuns = practiceRuns.slice(0, practiceRuns.length - checkpoint.state.recentPracticeRuns.length);

// Simulate a device that already has data: failed finalization must leave it
// untouched, while all archive rows remain available for an explicit retry.
await resetLocalDatabase();
await db.banks.put({ ...bank, displayName: "本地未提交修改" });
for (let index = 0; index < archivedAttempts.length; index += 200) {
  await stageSyncRestoreAttempts(archivedAttempts.slice(index, index + 200));
}
for (let index = 0; index < archivedRuns.length; index += 125) {
  await stageSyncRestorePracticeRuns(archivedRuns.slice(index, index + 125));
}
assert.equal(await db.syncRestoreAttempts.count(), archivedAttempts.length);
assert.equal(await db.syncRestorePracticeRuns.count(), archivedRuns.length);

await assert.rejects(() => commitStagedSyncRestore(plan, async () => {
  await markSyncArchiveEntries("attempts", archivedAttempts.map((attempt) => attempt.id));
  await db.syncFiles.put({ path: "restore-failure-marker", sha: "failure", appliedAt: checkpoint.generatedAt });
  throw new Error("abort restore transaction");
}));
assert.equal((await db.banks.get(bank.id))?.displayName, "本地未提交修改");
assert.equal(await db.syncFiles.get("restore-failure-marker"), undefined);
assert.equal(await db.syncRestoreAttempts.count(), archivedAttempts.length);
assert.equal(await db.syncRestorePracticeRuns.count(), archivedRuns.length);
assert.equal(await db.syncArchiveEntries.count(), 0, "archive index writes must roll back with failed restore");

const committed = await commitStagedSyncRestore(plan, async () => {
  await markSyncArchiveEntries("attempts", archivedAttempts.map((attempt) => attempt.id));
  await markSyncArchiveEntries("practice-runs", archivedRuns.map((run) => run.id));
  await db.syncFiles.put({ path: "restore-success-marker", sha: "success", appliedAt: checkpoint.generatedAt });
});
assert.equal(committed.attempts, archivedAttempts.length);
assert.equal(committed.practiceRuns, archivedRuns.length);
assert.equal(await db.syncRestoreAttempts.count(), 0);
assert.equal(await db.syncRestorePracticeRuns.count(), 0);
assert.equal(await db.attempts.count(), attempts.length);
assert.equal(await db.practiceRuns.count(), practiceRuns.length);
assert.equal((await db.syncFiles.get("restore-success-marker"))?.sha, "success");
assert.equal(await db.syncArchiveEntries.count(), archivedAttempts.length + archivedRuns.length);
assert.equal(await hasSyncArchiveEntry("attempts", archivedAttempts[0].id), true);
assert.deepEqual(await filterUnarchivedSyncIds("attempts", archivedAttempts.slice(0, 10).map((attempt) => attempt.id)), []);
assert.deepEqual(await filterUnarchivedSyncIds("attempts", ["not-indexed"]), ["not-indexed"]);
// The checkpoint already contains totals for archived rows. Promoting stage
// rows must not aggregate them a second time.
assert.equal((await db.attemptStats.get(question.id))?.total, checkpoint.state.attemptStats[0].total);
assert.equal((await db.practiceRunStats.get("__all__"))?.total, checkpoint.state.practiceRunStats.find((row) => row.bankId === "__all__")?.total);

await clearSyncRestoreStage();
assert.equal(await db.syncRestoreAttempts.count(), 0);
assert.equal(await db.syncRestorePracticeRuns.count(), 0);
await clearSyncArchiveEntries();
assert.equal(await db.syncArchiveEntries.count(), 0);
await db.delete();
console.log("sync restore staging tests passed: segmented promotion, bounded copy, atomic rollback and aggregate preservation");
