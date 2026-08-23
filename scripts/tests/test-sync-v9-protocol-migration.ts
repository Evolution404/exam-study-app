import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, dropLegacyLocalDatabases, putImageAssetV7, resetV7Database } from "../../src/lib/db/db-v7";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7";
import { createGitHubV7Remote } from "../../src/lib/sync/github-v7-remote";
import { encodeSyncCheckpointV7, createSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint";
import { encodeSyncV7JsonBytes } from "../../src/lib/sync/sync-v7-codec";
import { decodeRemoteCheckpoint } from "../../src/lib/sync/sync-v8-history";
import { migrateVaultToSyncV9Protocol } from "../../src/lib/sync/sync-v9-protocol-migration";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

const text = new TextEncoder();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
});

const server = await startMockGitHubServer({ cas: true });
const settings = { owner: "qa", repo: "legacy-v7-vault", branch: "main", apiBaseUrl: server.url };
const vaultId = "qa/legacy-v7-vault@main";

async function put(path: string, bytes: Uint8Array): Promise<string> {
  const response = await fetch(`${server.url}/repos/${settings.owner}/${settings.repo}/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `seed ${path}`, branch: settings.branch, content: toBase64(bytes) }),
  });
  assert.ok(response.ok, `seed PUT ${path} failed: ${response.status}`);
  const body = await response.json() as { content: { sha: string } };
  return body.content.sha;
}

try {
  await resetV7Database();
  const bank = await createBankV7("旧 v7 检查点题库");

  const assetBytes = text.encode("legacy-v7-image-bytes");
  const assetId = sha256(assetBytes);
  const legacyAssetPath = `sync/v7/assets/${assetId}.png`;
  const assetBlobSha = await put(legacyAssetPath, assetBytes);
  await putImageAssetV7({
    id: assetId,
    mimeType: "image/png",
    size: assetBytes.byteLength,
    width: 1,
    height: 1,
    remote: { path: legacyAssetPath, blobSha: assetBlobSha, sha256: assetId, size: assetBytes.byteLength },
  });

  const checkpoint = await createSyncCheckpointV7();
  const checkpointBytes = encodeSyncCheckpointV7(checkpoint);
  const checkpointDigest = sha256(checkpointBytes);
  const checkpointPath = `sync/v7/checkpoints/${checkpointDigest}.json`;
  const storedCheckpoint = await encodeSyncV7JsonBytes(checkpointBytes);
  const checkpointBlobSha = await put(checkpointPath, storedCheckpoint);

  const hotBank = { ...bank, id: "bank-from-hot-segment", name: "旧 v7 热分段题库", sortOrder: bank.sortOrder + 1 };
  const change = await createChangeSetV7({
    id: "legacy-hot-change",
    deviceId: "legacy-device",
    localSequence: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    mutation: { kind: "bank.create", bank: hotBank },
  });
  const segmentBytes = text.encode(JSON.stringify({
    formatVersion: 7,
    vaultId,
    generation: 10,
    ordinal: 0,
    metadata: { vaultId, createdAt: "2026-08-20T00:00:00.000Z", deviceId: "legacy-device" },
    cursors: { "legacy-device": 1 },
    events: [change],
  }));
  const segmentDigest = sha256(segmentBytes);
  const segmentPath = `sync/v7/segments/${segmentDigest}.json`;
  const storedSegment = await encodeSyncV7JsonBytes(segmentBytes);
  const segmentBlobSha = await put(segmentPath, storedSegment);

  const legacyHead = {
    formatVersion: 7,
    vaultId,
    generatedAt: "2026-08-20T00:00:00.000Z",
    generation: 10,
    metadata: { vaultId, producer: "legacy-v7-test" },
    checkpoint: { path: checkpointPath, blobSha: checkpointBlobSha, sha256: checkpointDigest, size: checkpointBytes.byteLength, storedSize: storedCheckpoint.byteLength, generation: 9 },
    segments: [{
      path: segmentPath,
      blobSha: segmentBlobSha,
      sha256: segmentDigest,
      size: segmentBytes.byteLength,
      storedSize: storedSegment.byteLength,
      generation: 10,
      ordinal: 0,
      count: 1,
      cursors: { "legacy-device": 1 },
      metadata: { vaultId, createdAt: "2026-08-20T00:00:00.000Z", deviceId: "legacy-device" },
    }],
    cursors: { "legacy-device": 1 },
  };
  await put("sync/v7/head.json", text.encode(JSON.stringify(legacyHead)));

  const preview = await migrateVaultToSyncV9Protocol(settings, "qa-token", undefined, { verifyOnly: true });
  assert.equal(preview.verified, true);
  assert.equal(preview.migrated, false);
  assert.equal(preview.hotEvents, 1);
  assert.equal(preview.copiedAssets, 1);
  assert.equal(preview.counts.banks, 2);
  assert.ok(!server.contentPaths().includes("sync/v9/head.json"), "预检不得写入 v9 head");

  const migrated = await migrateVaultToSyncV9Protocol(settings, "qa-token");
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.verified, true);
  assert.equal(migrated.generation, 11);
  assert.equal(migrated.counts.banks, 2);
  assert.equal(migrated.copiedAssets, 1);
  assert.ok(server.contentPaths().includes("sync/v7/head.json"), "迁移不得删除旧 v7 head");
  assert.ok(server.contentPaths().includes("sync/v9/head.json"));
  assert.ok(server.contentPaths().includes(`sync/v9/assets/${assetId}.png`));
  assert.ok(server.contentPaths().some((path) => path.startsWith("sync/v9/checkpoints/")));

  const remote = createGitHubV7Remote({ ...settings, token: "qa-token", vaultId });
  const current = await remote.readHead();
  assert.equal(current.initialized, true);
  assert.equal(current.head.formatVersion, 9);
  assert.equal(current.head.segments.length, 0, "完整迁移将热事件折叠进新检查点");
  assert.equal(current.head.metadata.migratedFrom?.blobSha, migrated.legacyHeadSha);
  assert.ok(current.head.checkpoint);
  const restored = await decodeRemoteCheckpoint(remote, await remote.readBlob(current.head.checkpoint!));
  assert.deepEqual(new Set(restored.checkpoint.state.banks.map((item) => item.id)), new Set([bank.id, hotBank.id]));
  assert.equal(restored.checkpoint.state.imageAssets[0]?.remote?.path, `sync/v9/assets/${assetId}.png`);

  const idempotent = await migrateVaultToSyncV9Protocol(settings, "qa-token");
  assert.equal(idempotent.migrated, false);
  assert.equal(idempotent.v9HeadSha, migrated.v9HeadSha);

  // === v8 source: bounded checkpoint with a history archive migrates v8→v9 ===
  const v8Settings = { owner: "qa", repo: "legacy-v8-vault", branch: "main", apiBaseUrl: server.url };
  const v8VaultId = "qa/legacy-v8-vault@main";
  const v8Put = (path: string, bytes: Uint8Array) => fetch(`${server.url}/repos/${v8Settings.owner}/${v8Settings.repo}/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `seed ${path}`, branch: v8Settings.branch, content: toBase64(bytes) }),
  }).then(async (response) => {
    assert.ok(response.ok, `v8 seed PUT ${path} failed: ${response.status}`);
    return (await response.json() as { content: { sha: string } }).content.sha;
  });

  await resetV7Database();
  const v8Bank = await createBankV7("旧 v8 题库");
  const v8Question = await createQuestionV7(v8Bank.id, { type: "单选", stem: "旧 v8 题目", options: ["对", "错"], answer: "A" });
  const archivedAttempt = {
    id: "archived-attempt-1",
    runId: "archived-run",
    questionId: v8Question.id,
    selected: "A",
    correct: true,
    elapsedMs: 900,
    createdAt: "2026-08-01T00:00:00.000Z",
    deviceId: "legacy-v8-device",
    sourceBankId: v8Bank.id,
  };
  const recentAttempt = { ...archivedAttempt, id: "recent-attempt-1", createdAt: "2026-08-10T00:00:00.000Z" };
  const fullCheckpoint = await createSyncCheckpointV7();
  const v8AssetPath = `sync/v8/assets/${assetId}.png`;
  const v8AssetBlobSha = await v8Put(v8AssetPath, assetBytes);
  const bounded = {
    formatVersion: 8,
    generatedAt: "2026-08-10T00:00:00.000Z",
    state: { ...fullCheckpoint.state, banks: [{ ...v8Bank }], questions: [{ ...v8Question }], attempts: [recentAttempt], attemptStats: [], attemptDailyStats: [], practiceRunStats: [], reviewRoundProgress: [], imageAssets: [{ id: assetId, mimeType: "image/png", size: assetBytes.byteLength, width: 1, height: 1, remote: { path: v8AssetPath, blobSha: v8AssetBlobSha, sha256: assetId, size: assetBytes.byteLength } }] },
    cursors: { "legacy-v8-device": 5 },
    counts: { ...fullCheckpoint.counts, totalAttempts: 2 },
    retention: { recentAttemptLimit: 5_000, recentPracticeRunLimit: 500, oldestRecentAttemptAt: recentAttempt.createdAt },
    history: { index: null, archivedAttempts: 1, archivedPracticeRuns: 0 },
  };
  const chunkBytes = text.encode(JSON.stringify({ formatVersion: 8, kind: "attempts", generatedAt: "2026-08-10T00:00:00.000Z", items: [archivedAttempt] }));
  const chunkDigest = sha256(chunkBytes);
  const chunkPath = `sync/v8/history/${chunkDigest}.json`;
  const chunkBlobSha = await v8Put(chunkPath, await encodeSyncV7JsonBytes(chunkBytes));
  const indexBytes = text.encode(JSON.stringify({ formatVersion: 8, generatedAt: "2026-08-10T00:00:00.000Z", attempts: [{ path: chunkPath, blobSha: chunkBlobSha, sha256: chunkDigest, size: chunkBytes.byteLength, kind: "attempts", count: 1, firstAt: archivedAttempt.createdAt, lastAt: archivedAttempt.createdAt }], practiceRuns: [], counts: { attempts: 1, practiceRuns: 0 } }));
  const indexDigest = sha256(indexBytes);
  const indexPath = `sync/v8/history/${indexDigest}.json`;
  const indexBlobSha = await v8Put(indexPath, await encodeSyncV7JsonBytes(indexBytes));
  bounded.history = { index: { path: indexPath, blobSha: indexBlobSha, sha256: indexDigest, size: indexBytes.byteLength }, archivedAttempts: 1, archivedPracticeRuns: 0 };
  const boundedBytes = text.encode(JSON.stringify(bounded));
  const boundedDigest = sha256(boundedBytes);
  const boundedPath = `sync/v8/checkpoints/${boundedDigest}.json`;
  const boundedBlobSha = await v8Put(boundedPath, await encodeSyncV7JsonBytes(boundedBytes));
  await v8Put("sync/v8/head.json", text.encode(JSON.stringify({
    formatVersion: 8,
    vaultId: v8VaultId,
    generatedAt: "2026-08-10T00:00:00.000Z",
    generation: 3,
    metadata: { vaultId: v8VaultId, producer: "legacy-v8-test" },
    checkpoint: { path: boundedPath, blobSha: boundedBlobSha, sha256: boundedDigest, size: boundedBytes.byteLength, generation: 3 },
    segments: [],
    cursors: { "legacy-v8-device": 5 },
  })));

  const v8Migrated = await migrateVaultToSyncV9Protocol(v8Settings, "qa-token");
  assert.equal(v8Migrated.migrated, true);
  assert.equal(v8Migrated.generation, 4);
  assert.equal(v8Migrated.copiedAssets, 1);
  assert.equal(v8Migrated.counts.attempts, 2, "v8 历史归档与近期作答都应水合");
  assert.equal(v8Migrated.counts.banks, 1);
  assert.ok(server.contentPaths().includes("sync/v8/head.json"), "迁移不得删除旧 v8 head");
  assert.ok(server.contentPaths().includes("sync/v9/head.json"));
  assert.ok(server.contentPaths().includes(`sync/v9/assets/${assetId}.png`), "v8 资产应复制到 v9 命名空间");

  const v8Remote = createGitHubV7Remote({ ...v8Settings, token: "qa-token", vaultId: v8VaultId });
  const v8Current = await v8Remote.readHead();
  assert.equal(v8Current.head.metadata.migratedFrom?.path, "sync/v8/head.json");
  assert.ok(v8Current.head.checkpoint);
  const v8Restored = await decodeRemoteCheckpoint(v8Remote, await v8Remote.readBlob(v8Current.head.checkpoint!));
  assert.equal(v8Restored.checkpoint.state.attempts.length, 2, "v9 侧应保留全部作答（重新归档）");
  assert.equal(v8Restored.checkpoint.state.imageAssets[0]?.remote?.path, `sync/v9/assets/${assetId}.png`);

  console.log("sync v9 protocol migration tests passed: v7/v8 sources, history hydration, asset copy, v9 publish and idempotency");

  // === Local cleanup: the first successful v9 restore releases old namespaces ===
  {
    const createLegacy = (name: string) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("banks");
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    await createLegacy("shijuan-study-v7");
    await createLegacy("shijuan-study-v6");
    await dropLegacyLocalDatabases();
    const openFresh = (name: string) => new Promise<{ stores: string[]; version: number }>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        const database = request.result;
        const stores = [...database.objectStoreNames];
        database.close();
        // Reopening a deleted name yields a fresh empty database (version 0/1,
        // no stores) instead of the seeded `banks` store.
        resolve({ stores, version: database.version });
      };
      request.onerror = () => reject(request.error);
    });
    assert.deepEqual((await openFresh("shijuan-study-v7")).stores, [], "旧 v7 本地库应在恢复后清理");
    assert.deepEqual((await openFresh("shijuan-study-v6")).stores, [], "旧 v6 本地库应在恢复后清理");
    console.log("legacy local database cleanup passed: v7/v6 namespaces released after restore");
  }
} finally {
  await server.close();
  dbV7.close();
}
