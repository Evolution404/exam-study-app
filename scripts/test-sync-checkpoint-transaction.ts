import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const {
  applyPreparedSyncCheckpoint,
  buildSyncCheckpointCacheFile,
  createSyncCheckpoint,
  db,
  prepareSyncCheckpoint,
  resetLocalDatabase,
  saveSyncCheckpointCache,
  withSyncCheckpointTransaction,
} = await import("../lib/db");

const bank = {
  id: "checkpoint-transaction-bank",
  name: "送电线路工-初级工" as const,
  questionCount: 1,
  importedAt: "2026-01-01T00:00:00.000Z",
};
const question = {
  id: "checkpoint-transaction-question",
  bankId: bank.id,
  bankName: bank.name,
  stem: "事务测试",
  normalizedStem: "事务测试",
  answer: "A",
  options: ["甲", "乙"],
  type: "单选" as const,
  tags: [],
};

await resetLocalDatabase();
await db.banks.put(bank);
await db.questions.put(question);
const checkpoint = await createSyncCheckpoint();
const plan = prepareSyncCheckpoint(checkpoint);

// Building a cache row consumes the already-built checkpoint and does not
// perform a database scan. The row retains object identity for direct reuse.
const cacheFile = buildSyncCheckpointCacheFile({
  path: "__local_remote_cache__/owner/repo/main",
  owner: "owner",
  repo: "repo",
  branch: "main",
  checkpoint: plan,
  markers: [{ path: "sync/manifest.json", sha: "manifest-sha", appliedAt: checkpoint.generatedAt }],
  cachedAt: "2026-01-01T00:01:00.000Z",
});
assert.equal(cacheFile.remoteCache?.snapshot, checkpoint);
assert.equal(cacheFile.remoteCache?.markers[0]?.path, "sync/manifest.json");
await saveSyncCheckpointCache({
  path: cacheFile.path,
  owner: "owner",
  repo: "repo",
  branch: "main",
  checkpoint: plan,
  markers: cacheFile.remoteCache?.markers,
  cachedAt: cacheFile.remoteCache?.cachedAt,
});
assert.deepEqual((await db.syncFiles.get(cacheFile.path))?.remoteCache?.snapshot, checkpoint);

// A staged checkpoint and follow-up marker commit as one transaction. Throwing
// after the apply must roll every table back without a JS backup of the vault.
await db.banks.put({ ...bank, displayName: "本地修改" });
await db.syncMeta.put({ key: "archive-index:attempts", value: ["old-row"], updatedAt: checkpoint.generatedAt });
await assert.rejects(() => withSyncCheckpointTransaction(async () => {
  await applyPreparedSyncCheckpoint(plan);
  await db.syncFiles.put({ path: "staged-marker", sha: "staged", appliedAt: checkpoint.generatedAt });
  throw new Error("abort staged restore");
}));
assert.equal((await db.banks.get(bank.id))?.displayName, "本地修改");
assert.equal(await db.syncFiles.get("staged-marker"), undefined);
assert.deepEqual((await db.syncMeta.get("archive-index:attempts"))?.value, ["old-row"]);

// A successful staged restore commits both checkpoint rows and its marker.
await withSyncCheckpointTransaction(async () => {
  await applyPreparedSyncCheckpoint(plan);
  await db.syncFiles.put({ path: "committed-marker", sha: "committed", appliedAt: checkpoint.generatedAt });
});
assert.equal((await db.banks.get(bank.id))?.displayName, undefined);
assert.ok(await db.syncFiles.get("committed-marker"));
assert.deepEqual((await db.syncMeta.get("archive-index:attempts"))?.value, ["old-row"]);

console.log("sync checkpoint transaction tests passed: prepared apply, cache reuse and atomic rollback");
