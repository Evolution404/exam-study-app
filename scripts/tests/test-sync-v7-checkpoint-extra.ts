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

// 2) 旧 v6 格式检查点可读，读入后归一化为 v7
{
  const current = await createSyncCheckpointV7();
  const legacy = structuredClone(current) as SyncCheckpointV7 & { formatVersion: number };
  legacy.formatVersion = 6;
  // 旧资产路径允许 sync/v6/assets
  legacy.state.imageAssets[0] = {
    ...legacy.state.imageAssets[0],
    remote: { path: `sync/v6/assets/${"a".repeat(64)}.webp`, blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 123 },
  };
  const parsed = parseSyncCheckpointV7(encodeSyncCheckpointV7(legacy));
  assert.equal(parsed.formatVersion, 7, "旧格式读入后升为 7");
  assert.equal(parsed.state.imageAssets[0].remote?.path, `sync/v6/assets/${"a".repeat(64)}.webp`, "旧资产路径保留以便继续下载旧 blob");
}

// 3) 旧 v6 格式但带 v7 资产路径也可读
{
  const current = await createSyncCheckpointV7();
  const legacy = structuredClone(current) as SyncCheckpointV7 & { formatVersion: number };
  legacy.formatVersion = 6;
  legacy.state.imageAssets[0] = {
    ...legacy.state.imageAssets[0],
    remote: { path: `sync/v9/assets/${"a".repeat(64)}.webp`, blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 123 },
  };
  const parsed = parseSyncCheckpointV7(encodeSyncCheckpointV7(legacy));
  assert.equal(parsed.formatVersion, 7);
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
