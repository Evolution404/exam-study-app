import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { createBankV7, createQuestionV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import type { AttemptV7, PracticeRunV7 } from "../../src/lib/db/v7-types";
import { createGitHubV7Remote } from "../../src/lib/sync/github-v7-remote";
import { descriptorPath } from "../../src/lib/sync/sync-v7-context";
import { validateSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint-validation";
import { createSyncCheckpointV7, encodeSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint-store";
import { SYNC_V9_CHECKPOINT_PREFIX, SYNC_V9_HISTORY_PREFIX, type SyncHeadV7 } from "../../src/lib/sync/sync-v7-head-types";
import {
  createRemoteCheckpointV8,
  encodeSyncCheckpointV8,
  gcSyncV8HistoryRemote,
  hydrateSyncCheckpointV8,
  validateSyncCheckpointV8,
} from "../../src/lib/sync/sync-v8-history";
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
  await resetV7Database();
  const bank = await createBankV7("v8 历史归档测试");
  const question = await createQuestionV7(bank.id, {
    type: "单选",
    stem: "历史归档是否保持完整恢复？",
    options: ["是", "否"],
    answer: "A",
  });
  const deviceId = "history-device";
  memoryLocalStorage.set("shijuan-study-device-id", deviceId);
  const base = Date.parse("2026-01-01T00:00:00.000Z");

  const attempts: AttemptV7[] = Array.from({ length: 8 }, (_, index) => ({
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
  await dbV7.attempts.bulkPut(attempts);

  const runs: PracticeRunV7[] = Array.from({ length: 4 }, (_, index) => {
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
  await dbV7.practiceRuns.bulkPut(runs);

  const full = await createSyncCheckpointV7();
  validateSyncCheckpointV7(full);
  assert.equal(full.state.attempts.length, 8);
  assert.equal(full.state.practiceRuns.length, 4);

  const vaultId = "qa/v8-history@main";
  const client = createGitHubV7Remote({ owner: "qa", repo: "v8-history", branch: "main", token: "qa-token", apiBaseUrl: server.url, vaultId });
  const bounded = await createRemoteCheckpointV8(client, full, { recentAttemptLimit: 2, recentPracticeRunLimit: 1, chunkCount: 2 });
  validateSyncCheckpointV8(bounded);
  assert.equal(bounded.formatVersion, 9);
  assert.equal(bounded.state.attempts.length, 2, "remote checkpoint keeps only recent attempts");
  assert.equal(bounded.state.practiceRuns.length, 1, "remote checkpoint keeps only recent practice runs");
  assert.equal(bounded.history.archivedAttempts, 6);
  assert.equal(bounded.history.archivedPracticeRuns, 3);
  assert.ok(bounded.history.index, "archive-bearing checkpoint has one history index descriptor");
  assert.equal(bounded.counts.totalAttempts, 8);
  assert.equal(bounded.counts.totalPracticeRuns, 4);
  assert.equal(bounded.state.attemptStats.length, 0, "derived stats are not serialized from a partial detail window");

  const fullBytes = encodeSyncCheckpointV7(full);
  const boundedBytes = encodeSyncCheckpointV8(bounded);
  assert.ok(boundedBytes.byteLength < fullBytes.byteLength, `bounded checkpoint should be smaller (${boundedBytes.byteLength} < ${fullBytes.byteLength})`);

  const hydrated = await hydrateSyncCheckpointV8(client, bounded);
  validateSyncCheckpointV7(hydrated);
  assert.deepEqual(new Set(hydrated.state.attempts.map((item) => item.id)), new Set(attempts.map((item) => item.id)), "hydration restores every archived + recent attempt");
  assert.deepEqual(new Set(hydrated.state.practiceRuns.map((item) => item.id)), new Set(runs.map((item) => item.id)), "hydration restores every archived + recent run");
  assert.ok(hydrated.state.attemptStats.length > 0, "lifetime derived statistics are rebuilt after full history hydration");

  const readsBeforeWindowedHydration = server.stats.blobReads;
  const windowed = await hydrateSyncCheckpointV8(client, bounded, { historySyncStart: "2026-01-05" });
  validateSyncCheckpointV7(windowed);
  assert.deepEqual(windowed.state.attempts.map((item) => item.id), ["attempt-4", "attempt-5", "attempt-6", "attempt-7"], "history start filters attempts before the selected date");
  assert.deepEqual(windowed.state.practiceRuns.map((item) => item.id), ["run-2", "run-3"], "history start filters runs before the selected date");
  assert.equal(server.stats.blobReads - readsBeforeWindowedHydration, 3, "windowed hydration reads only the index and two boundary/relevant chunks");
  assert.equal(windowed.state.attemptStats[0]?.total, 4, "derived statistics are rebuilt from the selected device history window");

  // Publish the bounded checkpoint and prove dedicated history GC preserves its
  // reachable index/chunks while removing an unrelated orphan history object.
  const checkpointPath = descriptorPath(SYNC_V9_CHECKPOINT_PREFIX, digest(boundedBytes));
  const uploadedCheckpoint = await client.putImmutable({ path: checkpointPath, bytes: boundedBytes, kind: "checkpoint" });
  const checkpointDescriptor = {
    path: checkpointPath,
    blobSha: uploadedCheckpoint.blobSha,
    sha256: uploadedCheckpoint.sha256,
    size: uploadedCheckpoint.size,
    storedSize: uploadedCheckpoint.storedSize,
    generation: 1,
  };
  const head: SyncHeadV7 = {
    formatVersion: 9,
    vaultId,
    generatedAt: "2026-02-01T00:00:00.000Z",
    generation: 1,
    metadata: { vaultId, deviceId, producer: "v8-history-test" },
    checkpoint: checkpointDescriptor,
    segments: [],
    cursors: {},
  };
  const published = await client.putHead(head);
  assert.equal(published.ok, true);
  if (!published.ok) throw new Error("failed to publish test head");

  const orphanBytes = new TextEncoder().encode(JSON.stringify({ formatVersion: 9, kind: "orphan" }));
  const orphanPath = descriptorPath(SYNC_V9_HISTORY_PREFIX, digest(orphanBytes));
  await client.putImmutable({ path: orphanPath, bytes: orphanBytes, kind: "history" });
  const beforeGc = server.contentPaths().filter((path) => path.startsWith(SYNC_V9_HISTORY_PREFIX));
  assert.ok(beforeGc.includes(orphanPath));
  const gc = await gcSyncV8HistoryRemote(client, head, published.cache);
  assert.equal(gc.deleted, 1, "history GC removes the unreachable orphan");
  const afterGc = server.contentPaths().filter((path) => path.startsWith(SYNC_V9_HISTORY_PREFIX));
  assert.ok(!afterGc.includes(orphanPath));
  assert.ok(bounded.history.index && afterGc.includes(bounded.history.index.path), "current history index remains reachable");
  assert.ok(afterGc.length > 1, "current archive chunks remain reachable");

  console.log("sync v8 history tests passed: bounded checkpoint, full hydration, derived-stat rebuild and dedicated history GC");
} finally {
  await server.close();
  dbV7.close();
}
