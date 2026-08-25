import assert from "node:assert/strict";
import { installFingerprint, projectionNeedsInstall } from "../../src/lib/sync/github-sync-v7";

const checkpoint = {
  path: "sync/v9/checkpoints/base.json",
  blobSha: "b".repeat(40),
  sha256: "a".repeat(64),
  size: 1024,
};
const head = {
  formatVersion: 9 as const,
  vaultId: "qa/ios-sync@main",
  generatedAt: "2026-08-25T00:00:00.000Z",
  generation: 7,
  metadata: { vaultId: "qa/ios-sync@main", producer: "test" },
  checkpoint,
  segments: [],
  cursors: { "device-a": 100 },
};
const cache = { head };
const installed = installFingerprint(cache);

assert.equal(
  projectionNeedsInstall(installed, cache, 1, 0),
  false,
  "ordinary unseen remote changes on the same checkpoint must use incremental local reconciliation instead of full projection restore",
);

console.log("incremental install regression reproduced: ordinary unseen delta must not trigger full projection restore");
