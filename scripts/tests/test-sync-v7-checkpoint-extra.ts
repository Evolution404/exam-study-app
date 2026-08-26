import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, putImageAssetV7, resetV7Database } from "../../src/lib/db/db-v7";
import { isSyncCheckpointV7, validateSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint-validation";
import { createSyncCheckpointV7, encodeSyncCheckpointV7, parseSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint-store";
import type { SyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint-types";

await resetV7Database();
await putImageAssetV7({ id: "a".repeat(64), mimeType: "image/webp", size: 123, width: 10, height: 10 });

// 回归：当前正式 QuestionType 已包含“填空/简答”。远端恢复的 checkpoint
// validator 必须接受与本地数据模型相同的完整题型集合，不能保留旧四题型硬编码。
const typeBank = await createBankV7("恢复题型回归");
await createQuestionV7(typeBank.id, {
  type: "填空",
  content: [{ id: "fill-stem", type: "text", text: "填空恢复题" }],
  options: [],
  answer: "填空答案",
  tags: ["恢复"],
});
await createQuestionV7(typeBank.id, {
  type: "简答",
  content: [{ id: "short-stem", type: "text", text: "简答恢复题" }],
  options: [],
  answer: "简答参考答案",
  tags: ["恢复"],
});

// 1) 新建检查点必须是 v7 格式且可 round-trip，包括新增正式题型
{
  const checkpoint = await createSyncCheckpointV7();
  assert.equal(checkpoint.formatVersion, 7);
  assert.deepEqual(checkpoint.state.questions.map((question) => question.type).sort(), ["填空", "简答"].sort());
  const bytes = encodeSyncCheckpointV7(checkpoint);
  const parsed = parseSyncCheckpointV7(bytes);
  assert.equal(parsed.formatVersion, 7);
  assert.deepEqual(parsed.state.imageAssets[0], checkpoint.state.imageAssets[0]);
  assert.deepEqual(parsed.state.questions.map((question) => question.type).sort(), ["填空", "简答"].sort());
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

// 3) 旧单图 remote 元数据已完全退役；当前 checkpoint 出现该字段直接拒绝
{
  const current = await createSyncCheckpointV7();
  const asset = current.state.imageAssets[0] as typeof current.state.imageAssets[number] & { remote?: unknown };
  asset.remote = { path: `sync/v9/assets/${"a".repeat(64)}.webp`, blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 123 };
  assert.throws(() => validateSyncCheckpointV7(current), /retired remote metadata/, "current checkpoint must reject retired per-image remote metadata");
}

// 4) 非法格式与坏 imageAsset 被拒绝
{
  const current = await createSyncCheckpointV7();
  const badFormat = structuredClone(current) as SyncCheckpointV7 & { formatVersion: number };
  badFormat.formatVersion = 5;
  assert.throws(() => validateSyncCheckpointV7(badFormat), /formatVersion/);


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
