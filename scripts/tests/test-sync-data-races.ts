import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  claimPendingChangeSetsV7,
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  dbV7,
  listChangeSetsV7,
  recordPracticeAnswerV7,
  releaseChangeSetClaimV7,
  resetV7Database,
  restoreV7Checkpoint,
} from "../../src/lib/db/db-v7";
import { createSyncCheckpointV7, createSyncCheckpointV7Snapshot } from "../../src/lib/sync/sync-v7-checkpoint";
import { nextV7Sequence } from "../../src/lib/db/db-v7-core";

const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

await resetV7Database();

// A claim made after rebase may only contain the exact snapshot. A later
// pending event must stay pending for the next sync attempt.
{
  const first = await createBankV7("快照前题库");
  const snapshot = await listChangeSetsV7(["pending"]);
  const second = await createBankV7("快照后题库");
  const claim = await claimPendingChangeSetsV7(snapshot);
  assert.deepEqual(claim.records.map((record) => record.id), snapshot.map((record) => record.id), "精确 claim 只能锁定快照记录");
  assert.equal((await dbV7.changeSets.get(snapshot[0]!.id))?.state, "claimed");
  assert.equal((await dbV7.changeSets.toArray()).find((record) => record.mutations.some((mutation) => mutation.kind === "bank.create" && mutation.bank.id === second.id))?.state, "pending", "快照后事件不得被旧 claim 吞掉");
  await releaseChangeSetClaimV7(claim.claimId);
  assert.ok(await dbV7.banks.get(first.id));
}

// Concurrent answers to one run must merge from the authoritative row inside
// each write transaction instead of overwriting one another from stale reads.
{
  await resetV7Database();
  const bank = await createBankV7("并发作答题库");
  const firstQuestion = await createQuestionV7(bank.id, { type: "单选", stem: "并发题一", options: ["甲", "乙"], answer: "A" });
  const secondQuestion = await createQuestionV7(bank.id, { type: "单选", stem: "并发题二", options: ["甲", "乙"], answer: "B" });
  const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [firstQuestion.id, secondQuestion.id] });
  await Promise.all([
    recordPracticeAnswerV7({ runId: run.id, questionId: firstQuestion.id, selected: ["A"], correct: true, createdAt: "2026-01-01T00:00:00.001Z" }),
    recordPracticeAnswerV7({ runId: run.id, questionId: secondQuestion.id, selected: ["B"], correct: true, createdAt: "2026-01-01T00:00:00.002Z" }),
  ]);
  const stored = await dbV7.practiceRuns.get(run.id);
  assert.ok(stored?.answers[firstQuestion.id]?.submitted, "第一道并发作答应保留");
  assert.ok(stored?.answers[secondQuestion.id]?.submitted, "第二道并发作答应保留");
  assert.equal(stored?.revision, 2, "并发作答应各自递增 run revision");
  assert.equal(await dbV7.attempts.where("runId").equals(run.id).count(), 2);
}

// A restore must check the queue again in its final write transaction. A new
// queue row after the snapshot causes a no-op and leaves both data and queue
// intact instead of clearing the just-created edit.
{
  await resetV7Database();
  await createBankV7("恢复守卫基础");
  const snapshot = await createSyncCheckpointV7();
  const queueSnapshot = await listChangeSetsV7();
  await createBankV7("恢复期间新增");
  const installed = await restoreV7Checkpoint(snapshot.state, { queueGuard: queueSnapshot, clearChangeSets: true });
  assert.equal(installed, false, "恢复最终事务应拒绝快照后新编辑");
  assert.ok((await dbV7.banks.toArray()).some((bank) => bank.name === "恢复期间新增"), "新编辑的投影不得被覆盖");
  assert.ok((await listChangeSetsV7(["pending"])).length >= 1, "新编辑的队列不得被清空");
}

// The fallback path (without navigator.locks) still reserves unique values
// through the IndexedDB syncMeta transaction across concurrent callers.
{
  await resetV7Database();
  const values = await Promise.all(Array.from({ length: 64 }, () => nextV7Sequence("race-sequence-device")));
  assert.equal(new Set(values).size, values.length, "并发序列分配必须唯一");
}

// Exercise the checkpoint API once more after all race fixtures so the test
// fails if a transaction leaves a half-written state behind.
{
  const snapshot = await createSyncCheckpointV7Snapshot();
  assert.equal(snapshot.checkpoint.counts.banks, snapshot.checkpoint.state.banks.length);
  assert.equal(snapshot.changeSets.length, await dbV7.changeSets.count());
}

console.log("sync/db data-race tests passed");
dbV7.close();
