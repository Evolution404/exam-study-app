import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "fake-indexeddb/auto";
import { createBankV7, dbV7, putImageAssetV7, resetV7Database } from "../../src/lib/db/db-v7";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7";
import { createGitHubV7Remote } from "../../src/lib/sync/github-v7-remote";
import { encodeSyncCheckpointV7, createSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint";
import { encodeSyncV7JsonBytes } from "../../src/lib/sync/sync-v7-codec";
import { decodeRemoteCheckpoint } from "../../src/lib/sync/sync-v8-history";
import { migrateVaultToSyncV8Protocol } from "../../src/lib/sync/sync-v8-protocol-migration";
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

  const preview = await migrateVaultToSyncV8Protocol(settings, "qa-token", undefined, { verifyOnly: true });
  assert.equal(preview.verified, true);
  assert.equal(preview.migrated, false);
  assert.equal(preview.hotEvents, 1);
  assert.equal(preview.copiedAssets, 1);
  assert.equal(preview.counts.banks, 2);
  assert.ok(!server.contentPaths().includes("sync/v9/head.json"), "预检不得写入 v8 head");

  const migrated = await migrateVaultToSyncV8Protocol(settings, "qa-token");
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

  const idempotent = await migrateVaultToSyncV8Protocol(settings, "qa-token");
  assert.equal(idempotent.migrated, false);
  assert.equal(idempotent.v8HeadSha, migrated.v8HeadSha);
  console.log("sync v8 protocol migration tests passed: verify-only, strict replay, asset copy, v8 publish and idempotency");
} finally {
  await server.close();
  dbV7.close();
}
