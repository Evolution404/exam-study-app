import assert from "node:assert/strict";
import {
  SYNC_V5_ARCHIVE_CATALOG_PATH,
  SYNC_V5_CHECKPOINT_PREFIX,
  SYNC_V5_EVENT_PREFIX,
  SYNC_V5_MAX_EVENT_BYTES,
  SYNC_V5_MAX_EVENT_PAGE_BYTES,
  SYNC_V5_MAX_EVENT_PAGES,
  appendSyncV5EventPages,
  appendSyncV5EventPagesAfterCas,
  compactSyncV5HeadAfterCas,
  mergeSyncV5EventPages,
  sameSyncV5Descriptor,
  tryCompactSyncV5HeadAfterCas,
  validateSyncHeadV5,
} from "../lib/sync-v5-head";
import type { SyncEventPageDescriptorV5, SyncHeadDescriptorV5, SyncHeadV5 } from "../lib/types";

const generatedAt = "2026-08-09T00:00:00.000Z";
const sha1 = (digit: string) => digit.repeat(40);
const sha256 = (digit: string) => digit.repeat(64);

function descriptor(kind: "checkpoint" | "catalog", digit: string): SyncHeadDescriptorV5 {
  return {
    path: kind === "catalog" ? SYNC_V5_ARCHIVE_CATALOG_PATH : `${SYNC_V5_CHECKPOINT_PREFIX}${digit}.json`,
    blobSha: sha1(digit),
    sha256: sha256(digit),
    size: 128,
  };
}

function page(index: number, size = 128, deviceId = "device-a", digit = ((index % 10) || 1).toString()): SyncEventPageDescriptorV5 {
  return {
    path: `${SYNC_V5_EVENT_PREFIX}${String(index).padStart(5, "0")}.json`,
    blobSha: sha1(digit),
    sha256: sha256(digit),
    size,
    count: Math.min(250, Math.max(1, index + 1)),
    deviceCursors: { [deviceId]: Math.max(1, index + 1) },
  };
}

function head(eventPages: SyncEventPageDescriptorV5[] = []): SyncHeadV5 {
  return {
    formatVersion: 5,
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
validateSyncHeadV5(empty);
assert.equal(sameSyncV5Descriptor(empty.checkpoint, { ...empty.checkpoint }), true);

// Per-page and aggregate byte boundaries are accepted exactly at the limit.
validateSyncHeadV5(head([page(1, SYNC_V5_MAX_EVENT_PAGE_BYTES)]));
const byteBoundary = Array.from({ length: SYNC_V5_MAX_EVENT_BYTES / SYNC_V5_MAX_EVENT_PAGE_BYTES }, (_, index) => page(index + 1, SYNC_V5_MAX_EVENT_PAGE_BYTES));
validateSyncHeadV5(head(byteBoundary));
expectThrow(() => validateSyncHeadV5(head([page(1, SYNC_V5_MAX_EVENT_PAGE_BYTES + 1)])), /byte limit/);
expectThrow(() => validateSyncHeadV5(head([...byteBoundary, page(10_000, 1)])), /aggregate byte/);

// Page-count boundary is independent from the byte budget.
const countBoundary = Array.from({ length: SYNC_V5_MAX_EVENT_PAGES }, (_, index) => page(index + 1, 1));
validateSyncHeadV5(head(countBoundary));
expectThrow(() => validateSyncHeadV5(head([...countBoundary, page(20_000, 1)])), /bounded index/);

// Same immutable page is idempotent; a path collision with another blob is a hard error.
const p1 = page(1);
const sameP1 = { ...p1, deviceCursors: { ...p1.deviceCursors } };
assert.equal(mergeSyncV5EventPages([p1], [sameP1]).length, 1);
const p1DifferentBlob = { ...p1, blobSha: sha1("c"), sha256: sha256("c") };
expectThrow(() => mergeSyncV5EventPages([p1], [p1DifferentBlob]), /path collision/);
const sameBlobDifferentPath = { ...p1, path: `${SYNC_V5_EVENT_PREFIX}other.json` };
assert.equal(mergeSyncV5EventPages([p1], [sameBlobDifferentPath]).length, 2);

// Two devices append concurrently: the CAS loser rebases its page on latest,
// preserving both the winner's and its own immutable page.
const base = head([p1]);
const local = page(2, 128, "device-a", "2");
const remote = page(3, 128, "device-b", "3");
const latest = appendSyncV5EventPages(base, [remote]);
const rebased = appendSyncV5EventPagesAfterCas({ expectedHead: base, latestHead: latest, newPages: [local] });
assert.deepEqual(rebased.eventPages.map((item) => item.path), [p1.path, local.path, remote.path]);
assert.deepEqual(base.eventPages.map((item) => item.path), [p1.path], "append must not mutate the old head");

// Compaction removes only explicitly included pages from the compactor's
// baseline. A page appended after the baseline survives the CAS merge.
const compactionBase = head([p1, local]);
const concurrent = page(3, 128, "device-b", "3");
const compactionLatest = appendSyncV5EventPages(compactionBase, [concurrent]);
const nextCheckpoint = descriptor("checkpoint", "d");
const nextCatalog = descriptor("catalog", "e");
const compacted = tryCompactSyncV5HeadAfterCas({
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
const noBroadDelete = compactSyncV5HeadAfterCas({
  expectedHead: compactionBase,
  latestHead: compactionLatest,
  checkpoint: nextCheckpoint,
  archiveCatalog: nextCatalog,
  includedPaths: [`${SYNC_V5_EVENT_PREFIX}not-present.json`],
});
assert.deepEqual(noBroadDelete.eventPages.map((item) => item.path), [p1.path, local.path, concurrent.path]);

// A concurrent checkpoint/catalog move must reject the overwrite, even if
// event pages only otherwise differ.
const advancedCheckpoint = { ...compactionLatest, checkpoint: nextCheckpoint };
const checkpointRace = tryCompactSyncV5HeadAfterCas({
  expectedHead: compactionBase,
  latestHead: advancedCheckpoint,
  checkpoint: descriptor("checkpoint", "f"),
  archiveCatalog: nextCatalog,
  includedPaths: [p1.path],
});
assert.deepEqual(checkpointRace, { ok: false, reason: "checkpoint-or-catalog-advanced", changed: "checkpoint" });
expectThrow(() => compactSyncV5HeadAfterCas({
  expectedHead: compactionBase,
  latestHead: advancedCheckpoint,
  checkpoint: descriptor("checkpoint", "f"),
  archiveCatalog: nextCatalog,
  includedPaths: [p1.path],
}), /baseline advanced/);

// Paths and digests are hostile input surfaces, not strings to concatenate
// into a tree request.
expectThrow(() => validateSyncHeadV5(head([{ ...p1, path: `${SYNC_V5_EVENT_PREFIX}../escape.json` }])), /safe relative path/);
expectThrow(() => validateSyncHeadV5(head([{ ...p1, path: "sync/v5/events/other.txt" }])), /must be under/);
expectThrow(() => validateSyncHeadV5(head([{ ...p1, blobSha: "../not-a-sha" }])), /blobSha/);
expectThrow(() => validateSyncHeadV5({ ...empty, archiveCatalog: { ...empty.archiveCatalog, path: "../catalog.json" } }), /safe relative path/);

console.log("sync v5 head tests passed: bounded index, immutable dedupe, append CAS, compaction CAS and hostile paths");

