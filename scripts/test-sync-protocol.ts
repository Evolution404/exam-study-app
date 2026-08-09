import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });

const { applyRemoteEvents, applySyncSnapshot, createSyncSnapshot, db, resetLocalDatabase, validateSyncSnapshot } = await import("../lib/db");
const { restoreFromGitHub, syncWithGitHub } = await import("../lib/github-sync");
type SyncEvent = import("../lib/types").SyncEvent;
type PracticeRun = import("../lib/types").PracticeRun;

const settings = { owner: "test", repo: "vault", branch: "main" };
const bank = { id: "bank-1", name: "送电线路工-初级工", questionCount: 1, importedAt: "2026-01-01T00:00:00.000Z" };
const question = { id: "question-1", bankId: bank.id, bankName: bank.name, stem: "测试题", normalizedStem: "测试题", answer: "A", options: ["甲", "乙"], type: "单选" as const, tags: [] };
const seedEvent: SyncEvent = { id: "seed", type: "bank.imported", payload: { bank, questions: [question] }, deviceId: "seed", createdAt: "2026-01-01T00:00:00.000Z", synced: 1 };

await resetLocalDatabase();
await applyRemoteEvents([seedEvent, { id: "delete-q", type: "question.deleted", payload: { id: question.id }, deviceId: "device-z", createdAt: "2026-02-01T00:00:00.000Z", synced: 1 }]);
await applyRemoteEvents([{ ...seedEvent, id: "older-seed", createdAt: "2026-01-15T00:00:00.000Z" }]);
assert.equal(await db.questions.count(), 0, "deleted question must not be resurrected by an older event");
assert.equal(await db.tombstones.count(), 1, "delete must create a tombstone");

const baseRun: PracticeRun = {
  id: "run-1", bankId: bank.id, bankIds: [bank.id], bankName: bank.name, mode: "sequential", modeLabel: "全量顺序练习",
  questionIds: [question.id], questionTypes: { [question.id]: "单选" }, answers: {}, shuffleOptions: false, optionOrders: {},
  startedAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:10:00.000Z", status: "in_progress", revision: 2,
};
const runA: SyncEvent = { id: "run-a", type: "practice.run.saved", payload: { ...baseRun, modeLabel: "A" }, deviceId: "device-a", createdAt: baseRun.updatedAt, synced: 1 };
const runB: SyncEvent = { id: "run-b", type: "practice.run.saved", payload: { ...baseRun, modeLabel: "B" }, deviceId: "device-b", createdAt: baseRun.updatedAt, synced: 1 };
for (const order of [[runB, runA], [runA, runB]]) {
  await resetLocalDatabase();
  await applyRemoteEvents(order);
  assert.equal((await db.practiceRuns.get(baseRun.id))?.modeLabel, "B", "same-revision conflict must be deterministic");
}

await resetLocalDatabase();
await applyRemoteEvents([seedEvent]);
const validSnapshot = await createSyncSnapshot();
validateSyncSnapshot(validSnapshot);
await resetLocalDatabase();
await applySyncSnapshot(validSnapshot, true);
assert.equal(await db.banks.count(), 1);
assert.equal(await db.questions.count(), 1);

await resetLocalDatabase();
const pending = Array.from({ length: 205 }, (_, index): SyncEvent => ({
  id: `pending-${index}`, type: "attempt.created", payload: { id: `attempt-${index}` }, deviceId: "batch-device",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), synced: 0,
}));
await db.events.bulkPut(pending);
let uploadCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/git/trees/")) return Response.json({ tree: [], truncated: false });
  if (init?.method === "PUT" && url.includes("/contents/events/v2/")) { uploadCalls += 1; return Response.json({ content: {} }); }
  throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
};
const batchResult = await syncWithGitHub(settings, "token");
assert.equal(batchResult.pushed, 205);
assert.equal(batchResult.remaining, 0);
assert.equal(uploadCalls, 3, "205 events must be uploaded as 100 + 100 + 5");

await resetLocalDatabase();
await db.banks.put(bank);
const invalidManifest = { formatVersion: 2, generatedAt: validSnapshot.generatedAt, snapshot: { path: "snapshots/v2/bad.json", sha256: "bad" }, eventPrefix: "events/v2/" };
const encode = (value: string) => Buffer.from(value).toString("base64");
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/git/trees/")) return Response.json({ tree: [
    { path: "sync/manifest.json", type: "blob", sha: "manifest" },
    { path: "snapshots/v2/bad.json", type: "blob", sha: "snapshot" },
  ] });
  if (url.includes("contents/sync/manifest.json")) return Response.json({ content: encode(JSON.stringify(invalidManifest)) });
  if (url.includes("contents/snapshots/v2/bad.json")) return Response.json({ content: encode(JSON.stringify(validSnapshot)) });
  throw new Error(`Unexpected request: ${url}`);
};
await assert.rejects(() => restoreFromGitHub(settings, "token"), /校验失败/);
assert.equal(await db.banks.count(), 1, "invalid remote data must leave local data untouched");

const snapshotText = JSON.stringify(validSnapshot);
const goodPath = "snapshots/v2/good.json";
const validManifest = { ...invalidManifest, snapshot: { path: goodPath, sha256: createHash("sha256").update(snapshotText).digest("hex") } };
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/git/trees/")) return Response.json({ tree: [
    { path: "sync/manifest.json", type: "blob", sha: "manifest-good" },
    { path: goodPath, type: "blob", sha: "snapshot-good" },
  ] });
  if (url.includes("contents/sync/manifest.json")) return Response.json({ content: encode(JSON.stringify(validManifest)) });
  if (url.includes("contents/snapshots/v2/good.json")) return Response.json({ content: encode(snapshotText) });
  throw new Error(`Unexpected request: ${url}`);
};
const restoreResult = await restoreFromGitHub(settings, "token");
assert.equal(restoreResult.formatVersion, 2);
assert.equal(await db.banks.count(), 1);
assert.equal(await db.questions.count(), 1);

await db.delete();
console.log("sync protocol tests passed: tombstones, deterministic conflicts, batching, safe restore");
