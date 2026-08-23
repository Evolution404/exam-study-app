import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { dbV7, putImageAssetV7, resetV7Database } from "../../src/lib/db/db-v7";
import {
  createSyncCheckpointV7,
  encodeSyncCheckpointV7,
  isSyncCheckpointV7,
  parseSyncCheckpointV7,
  validateSyncCheckpointV7,
} from "../../src/lib/sync/sync-v7-checkpoint";
import type { SyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint";

await resetV7Database();
await putImageAssetV7({ id: "a".repeat(64), mimeType: "image/webp", size: 123, width: 10, height: 10 });

// 1) 新建检查点必须是 v7 格式且可 round-trip
{
  const checkpoint = await createSyncCheckpointV7();
  assert.equal(checkpoint.formatVersion, 7);
  const bytes = encodeSyncCheckpointV7(checkpoint);
  const parsed = parseSyncCheckpointV7(bytes);
  assert.equal(parsed.formatVersion, 7);
  assert.deepEqual(parsed.state.imageAssets[0], checkpoint.state.imageAssets[0]);
  assert.ok(isSyncCheckpointV7(parsed));
}

// 2) 退役的 v6 检查点格式必须被拒绝，公开恢复只接受当前格式
{
  const current = await createSyncCheckpointV7();
  const legacy = structuredClone(current) as SyncCheckpointV7 & { formatVersion: number };
  legacy.formatVersion = 6;
  assert.throws(() => validateSyncCheckpointV7(legacy), /formatVersion/, "v6 checkpoint must be rejected after compatibility retirement");
  const bytes = new TextEncoder().encode(JSON.stringify(legacy));
  assert.throws(() => parseSyncCheckpointV7(bytes), /formatVersion/, "parser must reject retired v6 checkpoint bytes");
}

// 3) 退役的 v6/v7/v8 资产命名空间必须被拒绝，只允许当前 v9 资产路径
{
  for (const version of [6, 7, 8]) {
    const current = await createSyncCheckpointV7();
    current.state.imageAssets[0] = {
      ...current.state.imageAssets[0],
      remote: { path: "sync/v" + version + "/assets/" + "a".repeat(64) + ".webp", blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 123 },
    };
    assert.throws(() => validateSyncCheckpointV7(current), /remote\.path/, "sync/v" + version + " asset path must be rejected");
  }
}

// 4) 非法格式与坏 imageAsset 被拒绝
{
  const current = await createSyncCheckpointV7();
  const badFormat = structuredClone(current) as SyncCheckpointV7 & { formatVersion: number };
  badFormat.formatVersion = 5;
  assert.throws(() => validateSyncCheckpointV7(badFormat), /formatVersion/);

  const badAsset = structuredClone(current);
  badAsset.state.imageAssets[0] = {
    ...badAsset.state.imageAssets[0],
    remote: { path: `sync/v9/assets/${"a".repeat(64)}.webp`, blobSha: "b".repeat(40), sha256: "c".repeat(64), size: 123 },
  };
  assert.throws(() => validateSyncCheckpointV7(badAsset), /remote\.sha256 must equal id/);

  const badCounts = structuredClone(current);
  badCounts.counts.banks += 1;
  assert.throws(() => validateSyncCheckpointV7(badCounts), /counts/);
}

// 5) 检查点不接受 blob 字段
{
  const current = await createSyncCheckpointV7();
  const withBlob = structuredClone(current) as SyncCheckpointV7 & { state: { imageAssets: Array<Record<string, unknown>> } };
  (withBlob.state.imageAssets[0] as Record<string, unknown>).blob = new Blob(["x"], { type: "image/webp" });
  assert.throws(() => validateSyncCheckpointV7(withBlob), /must not contain a Blob/);
}

await dbV7.close();
console.log("sync-v7 checkpoint extra tests passed");
process.exit(0);
