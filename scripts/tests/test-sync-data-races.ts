import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  claimPendingChangeSets,
  createBank,
  createPracticeRun,
  getPracticeRun,
  createQuestion,
  studyDb,
  listChangeSets,
  recordPracticeAnswer,
  releaseChangeSetClaim,
  resetDatabase,
  restoreLocalCheckpoint,
} from "../../src/lib/db/db";
import { createSyncCheckpoint, createSyncCheckpointSnapshot } from "../../src/lib/sync/sync-checkpoint-store";
import { nextSequence } from "../../src/lib/db/db-core";

const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

await resetDatabase();

// A claim made after rebase may only contain the exact snapshot. A later
// pending event must stay pending for the next sync attempt.
{
  const first = await createBank("快照前题库");
  const snapshot = await listChangeSets(["pending"]);
  const second = await createBank("快照后题库");
  const claim = await claimPendingChangeSets(snapshot);
  assert.deepEqual(claim.records.map((record) => record.id), snapshot.map((record) => record.id), "精确 claim 只能锁定快照记录");
  assert.equal((await studyDb.changeSets.get(snapshot[0]!.id))?.state, "claimed");
  assert.equal((await studyDb.changeSets.toArray()).find((record) => record.mutations.some((mutation) => mutation.kind === "bank.create" && mutation.bank.id === second.id))?.state, "pending", "快照后事件不得被旧 claim 吞掉");
  await releaseChangeSetClaim(claim.claimId);
  assert.ok(await studyDb.banks.get(first.id));
}

// Concurrent answers to one run must merge from the authoritative row inside
// each write transaction instead of overwriting one another from stale reads.
{
  await resetDatabase();
  const bank = await createBank("并发作答题库");
  const optionIds = ["opt-0", "opt-1"];
  const firstQuestion = await createQuestion(bank.id, {
    type: "单选",
    stem: "并发题一",
    options: ["甲", "乙"],
    optionIds,
    solution: { kind: "choice", correctOptionIds: [optionIds[0]!] },
  });
  const secondQuestion = await createQuestion(bank.id, {
    type: "单选",
    stem: "并发题二",
    options: ["甲", "乙"],
    optionIds,
    solution: { kind: "choice", correctOptionIds: [optionIds[1]!] },
  });
  const run = await createPracticeRun({ bankId: bank.id, questionIds: [firstQuestion.id, secondQuestion.id] });
  await Promise.all([
    recordPracticeAnswer({ runId: run.id, questionId: firstQuestion.id, selected: ["A"], correct: true, createdAt: "2026-01-01T00:00:00.001Z", elapsedMs: 10 }),
    recordPracticeAnswer({ runId: run.id, questionId: secondQuestion.id, selected: ["B"], correct: true, createdAt: "2026-01-01T00:00:00.002Z", elapsedMs: 10 }),
  ]);
  const stored = await getPracticeRun(run.id);
  assert.ok(stored?.answers[firstQuestion.id]?.submitted, "第一道并发作答应保留");
  assert.ok(stored?.answers[secondQuestion.id]?.submitted, "第二道并发作答应保留");
  assert.equal(stored?.revision, 2, "并发作答应各自递增 run revision");
  assert.equal(await studyDb.attempts.where("runId").equals(run.id).count(), 2);
}

// A restore must check the queue again in its final write transaction. A new
// queue row after the snapshot causes a no-op and leaves both data and queue
// intact instead of clearing the just-created edit.
{
  await resetDatabase();
  await createBank("恢复守卫基础");
  const snapshot = await createSyncCheckpoint();
  const queueSnapshot = await listChangeSets();
  await createBank("恢复期间新增");
  const installed = await restoreLocalCheckpoint(snapshot.state, { queueGuard: queueSnapshot, clearChangeSets: true });
  assert.equal(installed, false, "恢复最终事务应拒绝快照后新编辑");
  assert.ok((await studyDb.banks.toArray()).some((bank) => bank.name === "恢复期间新增"), "新编辑的投影不得被覆盖");
  assert.ok((await listChangeSets(["pending"])).length >= 1, "新编辑的队列不得被清空");
}

// The navigator.locks-free path still reserves unique values through the
// IndexedDB syncMeta transaction across concurrent callers.
{
  await resetDatabase();
  const values = await Promise.all(Array.from({ length: 64 }, () => nextSequence("race-sequence-device")));
  assert.equal(new Set(values).size, values.length, "并发序列分配必须唯一");
}

// Exercise the checkpoint API once more after all race fixtures so the test
// fails if a transaction leaves a half-written state behind.
{
  const snapshot = await createSyncCheckpointSnapshot();
  assert.equal(snapshot.checkpoint.counts.banks, snapshot.checkpoint.state.banks.length);
  assert.equal(snapshot.changeSets.length, await studyDb.changeSets.count());
}

console.log("sync/db data-race tests passed");
studyDb.close();
