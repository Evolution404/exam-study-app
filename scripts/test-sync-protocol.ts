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

const {
  applyRemoteEvents, applySyncCheckpoint, createSyncCheckpoint, db, resetLocalDatabase, validateSyncCheckpoint,
} = await import("../lib/db");
const { addAttemptToStats, statsNeedWrongReview } = await import("../lib/practice-metrics");
const {
  getLastRemoteCache,
  restoreFromGitHubLegacyV3: restoreFromGitHub,
  restoreLastRemoteCache,
  syncWithGitHubLegacyV3: syncWithGitHub,
} = await import("../lib/github-sync");
type Attempt = import("../lib/types").Attempt;
type SyncCheckpointV3 = import("../lib/types").SyncCheckpointV3;
type SyncEvent = import("../lib/types").SyncEvent;

const settings = { owner: "test", repo: "vault", branch: "main" };
const bank = { id: "bank-1", name: "送电线路工-初级工", questionCount: 1, importedAt: "2026-01-01T00:00:00.000Z" };
const question = { id: "question-1", bankId: bank.id, bankName: bank.name, stem: "测试题", normalizedStem: "测试题", answer: "A", options: ["甲", "乙"], type: "单选" as const, tags: [] };
let sequence = 1;
const event = (input: Omit<SyncEvent, "sequence" | "synced">): SyncEvent => ({ ...input, sequence: sequence++, synced: 1 });
const seedEvent = event({ id: "seed", type: "bank.imported", payload: { bank, questions: [question] }, deviceId: "seed", createdAt: "2026-01-01T00:00:00.000Z" });

await resetLocalDatabase();
await applyRemoteEvents([seedEvent, event({ id: "delete-q", type: "question.deleted", payload: { id: question.id }, deviceId: "device-z", createdAt: "2026-02-01T00:00:00.000Z" })]);
await applyRemoteEvents([event({ ...seedEvent, id: "older-seed", createdAt: "2026-01-15T00:00:00.000Z" })]);
assert.equal(await db.questions.count(), 0, "deleted question must not be resurrected by an older event");
assert.equal(await db.tombstones.count(), 1, "delete must create a tombstone");

const attempt = (id: string, createdAt: string, correct: boolean): Attempt => ({
  id, runId: "run", questionId: question.id, bankId: bank.id, selected: correct ? "A" : "B",
  correct, elapsedMs: 1_000, createdAt, deviceId: "stats-device",
});
let outOfOrderStats = addAttemptToStats(undefined, attempt("a1", "2026-03-01T00:00:00.000Z", false));
outOfOrderStats = addAttemptToStats(outOfOrderStats, attempt("a3", "2026-03-01T00:03:00.000Z", true));
outOfOrderStats = addAttemptToStats(outOfOrderStats, attempt("a4", "2026-03-01T00:04:00.000Z", true));
outOfOrderStats = addAttemptToStats(outOfOrderStats, attempt("a2", "2026-03-01T00:02:00.000Z", false));
assert.equal(outOfOrderStats.currentCorrectStreak, 2, "late records must recalculate the trailing correct streak by timestamp");
assert.equal(statsNeedWrongReview(outOfOrderStats, 3), true);

await resetLocalDatabase();
await applyRemoteEvents([seedEvent]);
const manyAttemptEvents = Array.from({ length: 2_505 }, (_, index) => {
  const row = attempt(`attempt-${index}`, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), index % 4 !== 0);
  return event({ id: `attempt-event-${index}`, type: "attempt.created", payload: row, deviceId: "history-device", createdAt: row.createdAt });
});
await applyRemoteEvents(manyAttemptEvents);
const boundedCheckpoint = await createSyncCheckpoint();
validateSyncCheckpoint(boundedCheckpoint);
assert.equal(boundedCheckpoint.counts.totalAttempts, 2_505);
assert.equal(boundedCheckpoint.state.recentAttempts.length, 2_000, "v3 checkpoint must cap raw attempts at 2,000");
assert.equal(boundedCheckpoint.state.attemptStats[0].total, 2_505, "bounded raw history must retain exact lifetime totals");

let blobCounter = 0;
const blobContents: string[] = [];
let committedTree: Array<{ path: string; sha: string | null }> = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/git/trees/main?recursive=1") || url.includes("/git/trees/base-tree?recursive=1")) {
    return Response.json({ tree: [], truncated: false });
  }
  if (url.endsWith("/git/blobs") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { content: string };
    blobContents.push(body.content);
    return Response.json({ sha: `blob-${++blobCounter}` });
  }
  if (url.includes("/git/ref/heads/main")) return Response.json({ object: { sha: "head" } });
  if (url.includes("/git/commits/head")) return Response.json({ tree: { sha: "base-tree" } });
  if (url.endsWith("/git/trees") && init?.method === "POST") {
    committedTree = (JSON.parse(String(init.body)) as { tree: typeof committedTree }).tree;
    return Response.json({ sha: "new-tree" });
  }
  if (url.endsWith("/git/commits") && init?.method === "POST") return Response.json({ sha: "new-commit" });
  if (url.includes("/git/refs/heads/main") && init?.method === "PATCH") return Response.json({ object: { sha: "new-commit" } });
  throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
};
const initializeResult = await syncWithGitHub(settings, "token");
assert.equal(initializeResult.formatVersion, 3);
assert.equal(initializeResult.compacted, true);
assert.ok(committedTree.some((entry) => entry.path === "sync/manifest.json"));
assert.ok(committedTree.some((entry) => entry.path === "sync/v3/archive/catalog.json"));
assert.ok(committedTree.filter((entry) => entry.path.startsWith("sync/v3/archive/attempts/")).length >= 2, "505 old attempts must be split into bounded archive segments");
assert.equal(committedTree.some((entry) => entry.path.includes("/v2/")), false, "v3 initialization must not write legacy paths");
const checkpointPayload = blobContents.map((content) => { try { return JSON.parse(content) as { formatVersion?: number; retention?: unknown }; } catch { return {}; } }).find((value) => value.formatVersion === 3 && value.retention) as SyncCheckpointV3;
assert.equal(checkpointPayload.state.recentAttempts.length, 2_000);

await resetLocalDatabase();
await applyRemoteEvents([seedEvent]);
const remoteCheckpoint = await createSyncCheckpoint();
const checkpointText = JSON.stringify(remoteCheckpoint);
const checkpointHash = createHash("sha256").update(checkpointText).digest("hex");
const manifest = {
  formatVersion: 3, generatedAt: remoteCheckpoint.generatedAt,
  checkpoint: { path: "sync/v3/checkpoints/current.json", sha256: checkpointHash },
  eventPrefix: "sync/v3/events/",
  archiveCatalog: { path: "sync/v3/archive/catalog.json", sha256: "catalog-hash" },
};
await db.syncFiles.put({ path: manifest.checkpoint.path, sha: "checkpoint-sha", appliedAt: new Date().toISOString() });
const pending = Array.from({ length: 501 }, (_, index): SyncEvent => ({
  id: `pending-${index}`, type: "note.upserted", payload: { questionId: question.id, content: String(index) },
  deviceId: "batch-device", sequence: 10_000 + index, createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(), synced: 0,
}));
await db.events.bulkPut(pending);
const encoded = (value: string) => Buffer.from(value).toString("base64");
const uploadedPages: SyncEvent[][] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/git/trees/main?recursive=1")) return Response.json({ tree: [
    { path: "sync/manifest.json", type: "blob", sha: "manifest-sha", size: 500 },
    { path: manifest.checkpoint.path, type: "blob", sha: "checkpoint-sha", size: checkpointText.length },
    { path: manifest.archiveCatalog.path, type: "blob", sha: "catalog-sha", size: 100 },
  ], truncated: false });
  if (url.includes("/git/blobs/manifest-sha")) return Response.json({ content: encoded(JSON.stringify(manifest)) });
  if (url.includes("/git/ref/heads/main")) return Response.json({ object: { sha: "batch-head" } });
  if (url.includes("/git/commits/batch-head")) return Response.json({ tree: { sha: "batch-tree" } });
  if (url.includes("/git/trees/batch-tree?recursive=1")) return Response.json({ tree: [
    { path: "sync/manifest.json", type: "blob", sha: "manifest-sha", size: 500 },
    { path: manifest.checkpoint.path, type: "blob", sha: "checkpoint-sha", size: checkpointText.length },
    { path: manifest.archiveCatalog.path, type: "blob", sha: "catalog-sha", size: 100 },
  ], truncated: false });
  if (url.includes("/contents/sync/v3/events/") && init?.method === "PUT") {
    const body = JSON.parse(String(init.body)) as { content: string };
    uploadedPages.push(JSON.parse(Buffer.from(body.content, "base64").toString()) as SyncEvent[]);
    return Response.json({ content: { sha: `event-page-${uploadedPages.length}` } });
  }
  throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
};
const batchResult = await syncWithGitHub(settings, "token");
assert.equal(batchResult.pushed, 501);
assert.deepEqual(uploadedPages.map((page) => page.length), [250, 250, 1], "v3 event pages must be capped at 250 records");
assert.ok(uploadedPages.every((page) => Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024));

await resetLocalDatabase();
await db.banks.put({ ...bank, id: "local-only" });
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/git/trees/main?recursive=1")) return Response.json({ tree: [
    { path: "sync/manifest.json", type: "blob", sha: "restore-manifest" },
    { path: manifest.checkpoint.path, type: "blob", sha: "restore-checkpoint" },
    { path: manifest.archiveCatalog.path, type: "blob", sha: "catalog-sha" },
  ], truncated: false });
  if (url.includes("/git/blobs/restore-manifest")) return Response.json({ content: encoded(JSON.stringify(manifest)) });
  if (url.includes("/git/blobs/restore-checkpoint")) return Response.json({ content: encoded(checkpointText) });
  throw new Error(`Unexpected request: GET ${url}`);
};
const restoreResult = await restoreFromGitHub(settings, "token");
assert.equal(restoreResult.formatVersion, 3);
assert.equal(await db.banks.count(), 1);
assert.equal((await db.banks.toArray())[0].id, bank.id);
const cached = await getLastRemoteCache(settings);
assert.ok(cached, "successful v3 restore must save a bounded local remote cache");
await db.banks.put({ ...bank, id: "local-edit" });
globalThis.fetch = async () => { throw new Error("local cache restore must not access the network"); };
await restoreLastRemoteCache(settings);
assert.equal(await db.banks.count(), 1, "cached checkpoint restore must discard later local changes");

await applySyncCheckpoint(remoteCheckpoint);
await db.delete();
console.log("sync v3 tests passed: bounded checkpoint, archives, event pages, statistics, restore and cache");
