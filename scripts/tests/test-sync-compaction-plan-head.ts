import assert from "node:assert/strict";
import { planSyncV7Compaction } from "../../src/lib/sync/sync-v7-head";

const head = {
  formatVersion: 7 as const,
  vaultId: "vault",
  generatedAt: "2026-08-13T00:00:00.000Z",
  generation: 5,
  metadata: { vaultId: "vault" },
  checkpoint: { path: "sync/v7/checkpoints/checkpoint.json", blobSha: "a".repeat(40), sha256: "b".repeat(64), size: 1024 },
  segments: [
    { path: "sync/v7/segments/1.json", blobSha: "a".repeat(40), sha256: "c".repeat(64), size: 3 * 1024 * 1024, generation: 5, ordinal: 0, count: 1, cursors: {}, metadata: { vaultId: "vault", createdAt: "2026-08-13T00:00:00.000Z" } },
    { path: "sync/v7/segments/2.json", blobSha: "a".repeat(40), sha256: "d".repeat(64), size: 2 * 1024 * 1024, generation: 5, ordinal: 1, count: 1, cursors: {}, metadata: { vaultId: "vault", createdAt: "2026-08-13T00:00:00.000Z" } },
  ],
  cursors: {},
};

const plan = planSyncV7Compaction({ head });
assert.equal(plan.required, true, "已有 head 但热窗口超过 4 MiB 时必须要求压实");
assert.equal(plan.reason, "hot-window-overflow", "压实原因应为热窗口溢出");

console.log("sync compaction plan head tests passed");
