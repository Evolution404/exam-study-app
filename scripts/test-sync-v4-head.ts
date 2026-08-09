import assert from "node:assert/strict";
import {
  SYNC_V4_ARCHIVE_CATALOG_PATH,
  SYNC_V4_CHECKPOINT_PREFIX,
  SYNC_V4_EVENT_PREFIX,
  SYNC_V4_MAX_EVENT_BYTES,
  SYNC_V4_MAX_EVENT_PAGE_BYTES,
  SYNC_V4_MAX_EVENT_PAGES,
  appendSyncV4EventPages,
  appendSyncV4EventPagesAfterCas,
  compactSyncV4HeadAfterCas,
  mergeSyncV4EventPages,
  sameSyncV4Descriptor,
  tryCompactSyncV4HeadAfterCas,
  validateSyncHeadV4,
} from "../lib/sync-v4-head";
import type { SyncEventPageDescriptorV4, SyncHeadDescriptorV4, SyncHeadV4 } from "../lib/types";

const generatedAt = "2026-08-09T00:00:00.000Z";
const sha1 = (digit: string) => digit.repeat(40);
const sha256 = (digit: string) => digit.repeat(64);

function descriptor(kind: "checkpoint" | "catalog", digit: string): SyncHeadDescriptorV4 {
  return {
    path: kind === "catalog" ? SYNC_V4_ARCHIVE_CATALOG_PATH : `${SYNC_V4_CHECKPOINT_PREFIX}${digit}.json`,
    blobSha: sha1(digit),
    sha256: sha256(digit),
    size: 128,
  };
}

function page(index: number, size = 128, deviceId = "device-a", digit = ((index % 10) || 1).toString()): SyncEventPageDescriptorV4 {
  return {
    path: `${SYNC_V4_EVENT_PREFIX}${String(index).padStart(5, "0")}.json`,
    blobSha: sha1(digit),
    sha256: sha256(digit),
    size,
    count: Math.min(250, Math.max(1, index + 1)),
    deviceCursors: { [deviceId]: Math.max(1, index + 1) },
  };
}

function head(eventPages: SyncEventPageDescriptorV4[] = []): SyncHeadV4 {
  return {
    formatVersion: 4,
    generatedAt,
    checkpoint: descriptor("checkpoint", "a"),
    archiveCatalog: descriptor("catalog", "b"),
    eventPages,
  };
}

function expectThrow(action: () => unknown, message: RegExp) {
  assert.throws(action, message);
}

// A minimal head validates and is not mutated by pure operations.
const empty = head();
validateSyncHeadV4(empty);
assert.equal(sameSyncV4Descriptor(empty.checkpoint, { ...empty.checkpoint }), true);

// Per-page and aggregate byte boundaries are accepted exactly at the limit.
validateSyncHeadV4(head([page(1, SYNC_V4_MAX_EVENT_PAGE_BYTES)]));
const byteBoundary = Array.from({ length: SYNC_V4_MAX_EVENT_BYTES / SYNC_V4_MAX_EVENT_PAGE_BYTES }, (_, index) => page(index + 1, SYNC_V4_MAX_EVENT_PAGE_BYTES));
validateSyncHeadV4(head(byteBoundary));
expectThrow(() => validateSyncHeadV4(head([page(1, SYNC_V4_MAX_EVENT_PAGE_BYTES + 1)])), /byte limit/);
expectThrow(() => validateSyncHeadV4(head([...byteBoundary, page(10_000, 1)])), /aggregate byte/);

// Page-count boundary is independent from the byte budget.
const countBoundary = Array.from({ length: SYNC_V4_MAX_EVENT_PAGES }, (_, index) => page(index + 1, 1));
validateSyncHeadV4(head(countBoundary));
expectThrow(() => validateSyncHeadV4(head([...countBoundary, page(20_000, 1)])), /bounded index/);

// Same immutable page is idempotent; a path collision with another blob is a hard error.
const p1 = page(1);
const sameP1 = { ...p1, deviceCursors: { ...p1.deviceCursors } };
assert.equal(mergeSyncV4EventPages([p1], [sameP1]).length, 1);
const p1DifferentBlob = { ...p1, blobSha: sha1("c"), sha256: sha256("c") };
expectThrow(() => mergeSyncV4EventPages([p1], [p1DifferentBlob]), /path collision/);
const sameBlobDifferentPath = { ...p1, path: `${SYNC_V4_EVENT_PREFIX}other.json` };
assert.equal(mergeSyncV4EventPages([p1], [sameBlobDifferentPath]).length, 2);

// Two devices append concurrently: the CAS loser rebases its page on latest,
// preserving both the winner's and its own immutable page.
const base = head([p1]);
const local = page(2, 128, "device-a", "2");
const remote = page(3, 128, "device-b", "3");
const latest = appendSyncV4EventPages(base, [remote]);
const rebased = appendSyncV4EventPagesAfterCas({ expectedHead: base, latestHead: latest, newPages: [local] });
assert.deepEqual(rebased.eventPages.map((item) => item.path), [p1.path, local.path, remote.path]);
assert.deepEqual(base.eventPages.map((item) => item.path), [p1.path], "append must not mutate the old head");

// Compaction removes only explicitly included pages from the compactor's
// baseline. A page appended after the baseline survives the CAS merge.
const compactionBase = head([p1, local]);
const concurrent = page(3, 128, "device-b", "3");
const compactionLatest = appendSyncV4EventPages(compactionBase, [concurrent]);
const nextCheckpoint = descriptor("checkpoint", "d");
const nextCatalog = descriptor("catalog", "e");
const compacted = tryCompactSyncV4HeadAfterCas({
  expectedHead: compactionBase,
  latestHead: compactionLatest,
  checkpoint: nextCheckpoint,
  archiveCatalog: nextCatalog,
  includedPaths: [p1.path],
});
assert.equal(compacted.ok, true);
if (compacted.ok) {
  assert.deepEqual(compacted.removedPaths, [p1.path]);
  assert.deepEqual(compacted.head.eventPages.map((item) => item.path), [local.path, concurrent.path]);
  assert.deepEqual(compacted.head.checkpoint, nextCheckpoint);
}
// An unknown included path is not inferred into a broad delete operation.
const noBroadDelete = compactSyncV4HeadAfterCas({
  expectedHead: compactionBase,
  latestHead: compactionLatest,
  checkpoint: nextCheckpoint,
  archiveCatalog: nextCatalog,
  includedPaths: [`${SYNC_V4_EVENT_PREFIX}not-present.json`],
});
assert.deepEqual(noBroadDelete.eventPages.map((item) => item.path), [p1.path, local.path, concurrent.path]);

// A concurrent checkpoint/catalog move must reject the overwrite, even if
// event pages only otherwise differ.
const advancedCheckpoint = { ...compactionLatest, checkpoint: nextCheckpoint };
const checkpointRace = tryCompactSyncV4HeadAfterCas({
  expectedHead: compactionBase,
  latestHead: advancedCheckpoint,
  checkpoint: descriptor("checkpoint", "f"),
  archiveCatalog: nextCatalog,
  includedPaths: [p1.path],
});
assert.deepEqual(checkpointRace, { ok: false, reason: "checkpoint-or-catalog-advanced", changed: "checkpoint" });
expectThrow(() => compactSyncV4HeadAfterCas({
  expectedHead: compactionBase,
  latestHead: advancedCheckpoint,
  checkpoint: descriptor("checkpoint", "f"),
  archiveCatalog: nextCatalog,
  includedPaths: [p1.path],
}), /baseline advanced/);

// Paths and digests are hostile input surfaces, not strings to concatenate
// into a tree request.
expectThrow(() => validateSyncHeadV4(head([{ ...p1, path: `${SYNC_V4_EVENT_PREFIX}../escape.json` }])), /safe relative path/);
expectThrow(() => validateSyncHeadV4(head([{ ...p1, path: "sync/v4/events/other.txt" }])), /must be under/);
expectThrow(() => validateSyncHeadV4(head([{ ...p1, blobSha: "../not-a-sha" }])), /blobSha/);
expectThrow(() => validateSyncHeadV4({ ...empty, archiveCatalog: { ...empty.archiveCatalog, path: "../catalog.json" } }), /safe relative path/);

console.log("sync v4 head tests passed: bounded index, immutable dedupe, append CAS, compaction CAS and hostile paths");

