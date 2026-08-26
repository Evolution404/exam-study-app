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
    solution: { kind: "choice", correctOptionIds: ["option-1y6l9uk"] },
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

  const checkpoint = await createSyncCheckpointV7();
  validateSyncCheckpointV7(checkpoint);
  const checkpointBytes = encodeSyncCheckpointV7(checkpoint);
  const remote = createGitHubV7Remote({
    owner: "test-owner",
    repo: "test-repo",
    branch: "main",
    token: "test-token",
    vaultId: "test-owner/test-repo@main",
    apiBaseUrl: server.url,
  });
  const checkpointUpload = await remote.putImmutable({
    path: descriptorPath(SYNC_V9_CHECKPOINT_PREFIX, digest(checkpointBytes)),
    bytes: checkpointBytes,
    kind: "checkpoint",
  });
  const head: SyncHeadV7 = {
    formatVersion: 9,
    vaultId: "test-owner/test-repo@main",
    generatedAt: new Date(base + 9 * 86_400_000).toISOString(),
    generation: 1,
    metadata: { vaultId: "test-owner/test-repo@main", deviceId },
    checkpoint: {
      path: checkpointUpload.path,
      blobSha: checkpointUpload.blobSha,
      sha256: checkpointUpload.sha256,
      size: checkpointUpload.size,
      storedSize: checkpointUpload.storedSize,
      generation: 1,
    },
    segments: [],
    cursors: { [deviceId]: 8 },
  };

  const archived = await createRemoteCheckpointV8(remote, head, checkpoint, {
    historyCutoff: new Date(base + 4 * 86_400_000).toISOString(),
  });
  assert.ok(archived.descriptor, "history archive should be created when old records exist");
  assert.ok(archived.checkpoint.state.attempts.length < checkpoint.state.attempts.length, "hot checkpoint should drop archived attempts");
  assert.ok(archived.checkpoint.state.practiceRuns.length < checkpoint.state.practiceRuns.length, "hot checkpoint should drop archived practice runs");

  const restored = await hydrateSyncCheckpointV8(remote, archived.checkpoint);
  assert.equal(restored.checkpoint.state.attempts.length, checkpoint.state.attempts.length, "history hydrate must restore all attempts");
  assert.equal(restored.checkpoint.state.practiceRuns.length, checkpoint.state.practiceRuns.length, "history hydrate must restore all practice runs");
  assert.equal(restored.archivedAttempts, checkpoint.state.attempts.length - archived.checkpoint.state.attempts.length);
  assert.equal(restored.archivedPracticeRuns, checkpoint.state.practiceRuns.length - archived.checkpoint.state.practiceRuns.length);

  const encodedV8 = encodeSyncCheckpointV8(archived.checkpoint);
  validateSyncCheckpointV8(JSON.parse(new TextDecoder().decode(encodedV8)));
  assert.ok(archived.descriptor.path.startsWith(SYNC_V9_HISTORY_PREFIX));

  const gc = await gcSyncV8HistoryRemote(remote, [archived.descriptor], { keep: [] });
  assert.equal(gc.deleted.length, 1);

  console.log("sync v8 history tests passed: bounded archive, full hydrate, strict validation and remote GC");
} finally {
  await server.close();
}
