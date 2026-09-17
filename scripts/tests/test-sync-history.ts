import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { createBank, createQuestion, studyDb, resetDatabase } from "../../src/lib/db/db";
import type { Attempt, PracticeRun } from "../../src/lib/db/types";
import { decomposePracticeRun } from "../../src/lib/db/practice-run-store";
import { createGitHubRemote } from "../../src/lib/sync/github-remote";
import { descriptorPath } from "../../src/lib/sync/sync-context";
import { validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";
import { createSyncCheckpoint, encodeSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-store";
import { SYNC_CHECKPOINT_PREFIX, SYNC_HISTORY_PREFIX, type SyncHead } from "../../src/lib/sync/sync-head-types";
import {
  createRemoteHistoryCheckpoint,
  encodeRemoteHistoryCheckpoint,
  gcRemoteHistory,
  hydrateRemoteHistoryCheckpoint,
  validateRemoteHistoryCheckpoint,
} from "../../src/lib/sync/sync-history";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const server = await startMockGitHubServer({ cas: true });
try {
  await resetDatabase();
  const bank = await createBank("历史归档测试");
  const question = await createQuestion(bank.id, {
    type: "单选",
    stem: "历史归档是否保持完整恢复？",
    options: ["是", "否"],
    solution: { kind: "choice", correctOptionIds: ["option-1y6l9uk"] },
  });
  const deviceId = "history-device";
  memoryLocalStorage.set("shijuan-study-device-id", deviceId);
  const base = Date.parse("2026-01-01T00:00:00.000Z");

  const attempts: Attempt[] = Array.from({ length: 8 }, (_, index) => ({
    id: `attempt-${index}`,
    runId: `run-${Math.floor(index / 2)}`,
    questionId: question.id,
    selected: `A-${index}-${"x".repeat(4_000)}`,
    correct: index % 3 !== 0,
    elapsedMs: 1_000 + index,
    createdAt: new Date(base + index * 86_400_000).toISOString(),
    deviceId,
    sourceBankId: bank.id,
  }));
  await studyDb.attempts.bulkPut(attempts);

  const runs: PracticeRun[] = Array.from({ length: 4 }, (_, index) => {
    const startedAt = new Date(base + index * 2 * 86_400_000).toISOString();
    return {
      id: `run-${index}`,
      bankId: bank.id,
      bankIds: [bank.id],
      bankName: bank.name,
      mode: "sequential",
      modeLabel: "练习",
      questionIds: [question.id],
      questionTypes: { [question.id]: "单选" },
      answers: {},
      shuffleOptions: false,
      optionOrders: {},
      startedAt,
      updatedAt: startedAt,
      status: "completed",
      revision: 1,
      completedAt: startedAt,
    };
  });
  const runBundles = runs.map((run) => decomposePracticeRun(run, attempts));
  await studyDb.practiceRuns.bulkPut(runBundles.map((bundle) => bundle.record));
  await studyDb.practiceRunSources.bulkPut(runBundles.flatMap((bundle) => bundle.sources));
  await studyDb.practiceRunItems.bulkPut(runBundles.flatMap((bundle) => bundle.items));

  const full = await createSyncCheckpoint();
  validateSyncCheckpoint(full);
  assert.equal(full.state.attempts.length, 8);
  assert.equal(full.state.practiceRuns.length, 4);
  assert.equal(full.state.practiceRunSources.length, 4);
  assert.equal(full.state.practiceRunItems.length, 4);

  const vaultId = "qa/history@main";
  const client = createGitHubRemote({ owner: "qa", repo: "sync-history", branch: "main", token: "qa-token", apiBaseUrl: server.url, vaultId });
  const bounded = await createRemoteHistoryCheckpoint(client, full, { recentAttemptLimit: 2, recentPracticeRunLimit: 1, chunkCount: 2 });
  validateRemoteHistoryCheckpoint(bounded);
  assert.equal(bounded.formatVersion, 9);
  assert.equal(bounded.state.attempts.length, 2, "remote checkpoint keeps only recent attempts");
  assert.equal(bounded.state.practiceRuns.length, 1, "remote checkpoint keeps only recent practice run records");
  assert.equal(bounded.state.practiceRunSources.length, 1, "bounded state keeps only relations for retained runs");
  assert.equal(bounded.state.practiceRunItems.length, 1, "bounded state keeps only run items for retained runs");
  assert.equal(bounded.history.archivedAttempts, 6);
  assert.equal(bounded.history.archivedPracticeRuns, 3);
  assert.ok(bounded.history.index, "archive-bearing checkpoint has one history index descriptor");
  assert.equal(bounded.counts.totalAttempts, 8);
  assert.equal(bounded.counts.totalPracticeRuns, 4);
  for (const retired of ["attemptStats", "attemptDailyStats", "practiceRunStats", "reviewRoundProgress"]) {
    assert.equal(retired in (bounded.state as unknown as Record<string, unknown>), false, `history checkpoint must not serialize derived ${retired}`);
  }

  if (!bounded.history.index) throw new Error("history index missing");
  const historyIndex = JSON.parse(new TextDecoder().decode(await client.readBlob(bounded.history.index))) as {
    practiceRuns: Array<{ path: string; blobSha: string; sha256: string; size: number; storedSize: number }>;
  };
  const firstRunChunk = JSON.parse(new TextDecoder().decode(await client.readBlob(historyIndex.practiceRuns[0]!))) as Record<string, unknown>;
  assert.ok(Array.isArray(firstRunChunk.practiceRuns), "practice history chunk stores normalized run records");
  assert.ok(Array.isArray(firstRunChunk.practiceRunSources), "practice history chunk stores normalized source relations");
  assert.ok(Array.isArray(firstRunChunk.practiceRunItems), "practice history chunk stores normalized item relations");
  assert.equal("items" in firstRunChunk, false, "practice history must not restore aggregate PracticeRun items payloads");

  const fullBytes = encodeSyncCheckpoint(full);
  const boundedBytes = encodeRemoteHistoryCheckpoint(bounded);
  assert.ok(boundedBytes.byteLength < fullBytes.byteLength, `bounded checkpoint should be smaller (${boundedBytes.byteLength} < ${fullBytes.byteLength})`);

  const hydrated = await hydrateRemoteHistoryCheckpoint(client, bounded);
  validateSyncCheckpoint(hydrated);
  assert.deepEqual(new Set(hydrated.state.attempts.map((item) => item.id)), new Set(attempts.map((item) => item.id)), "hydration restores every archived + recent attempt");
  assert.deepEqual(new Set(hydrated.state.practiceRuns.map((item) => item.id)), new Set(runs.map((item) => item.id)), "hydration restores every archived + recent run");
  assert.equal(hydrated.state.practiceRunSources.length, 4, "hydration restores canonical run-source relations");
  assert.equal(hydrated.state.practiceRunItems.length, 4, "hydration restores canonical run-item relations");

  const readsBeforeWindowedHydration = server.stats.blobReads;
  const windowed = await hydrateRemoteHistoryCheckpoint(client, bounded, { historySyncStart: "2026-01-05" });
  validateSyncCheckpoint(windowed);
  assert.deepEqual(windowed.state.attempts.map((item) => item.id), ["attempt-4", "attempt-5", "attempt-6", "attempt-7"], "history start filters attempts before the selected date");
  assert.deepEqual(windowed.state.practiceRuns.map((item) => item.id), ["run-2", "run-3"], "history start filters runs before the selected date");
  assert.equal(windowed.state.practiceRunSources.length, 2, "windowed hydration keeps relations only for retained runs");
  assert.equal(windowed.state.practiceRunItems.length, 2, "windowed hydration keeps items only for retained runs");
  assert.equal(server.stats.blobReads - readsBeforeWindowedHydration, 3, "windowed hydration reads only the index and two boundary/relevant chunks");

  const checkpointPath = descriptorPath(SYNC_CHECKPOINT_PREFIX, digest(boundedBytes));
  const uploadedCheckpoint = await client.putImmutable({ path: checkpointPath, bytes: boundedBytes, kind: "checkpoint" });
  const checkpointDescriptor = {
    path: checkpointPath,
    blobSha: uploadedCheckpoint.blobSha,
    sha256: uploadedCheckpoint.sha256,
    size: uploadedCheckpoint.size,
    storedSize: uploadedCheckpoint.storedSize,
    generation: 1,
  };
  const head: SyncHead = {
    formatVersion: 9,
    vaultId,
    generatedAt: "2026-02-01T00:00:00.000Z",
    generation: 1,
    metadata: { vaultId, deviceId, producer: "history-test" },
    checkpoint: checkpointDescriptor,
    segments: [],
    cursors: {},
  };
  const published = await client.putHead(head);
  assert.equal(published.ok, true);
  if (!published.ok) throw new Error("failed to publish test head");

  const orphanBytes = new TextEncoder().encode(JSON.stringify({ formatVersion: 9, kind: "orphan" }));
  const orphanPath = descriptorPath(SYNC_HISTORY_PREFIX, digest(orphanBytes));
  await client.putImmutable({ path: orphanPath, bytes: orphanBytes, kind: "history" });
  const beforeGc = server.contentPaths().filter((path) => path.startsWith(SYNC_HISTORY_PREFIX));
  assert.ok(beforeGc.includes(orphanPath));
  const gc = await gcRemoteHistory(client, head, published.cache);
  assert.equal(gc.deleted, 1, "history GC removes the unreachable orphan");
  const afterGc = server.contentPaths().filter((path) => path.startsWith(SYNC_HISTORY_PREFIX));
  assert.ok(!afterGc.includes(orphanPath));
  assert.ok(bounded.history.index && afterGc.includes(bounded.history.index.path), "current history index remains reachable");
  assert.ok(afterGc.length > 1, "current archive chunks remain reachable");

  console.log("sync history tests passed: canonical bounded facts, normalized run history, hydration and dedicated history GC");
} finally {
  await server.close();
  studyDb.close();
}