import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  SYNC_V7_ASSET_PREFIX,
  SYNC_V7_CHECKPOINT_PREFIX,
  SYNC_V7_HEAD_PATH,
  SYNC_V7_MAX_HOT_BYTES,
  SYNC_V7_OBJECT_PREFIX,
  SYNC_V7_SEGMENT_PREFIX,
  appendSyncV7Segments,
  assertSyncV7Path,
  createSyncV7AppendPublicationPlan,
  createSyncV7CompactionPlan,
  createSyncV7ObjectRef,
  createSyncV7PublicationPlan,
  encodeSyncV7Event,
  orderSyncV7Segments,
  paginateSyncV7Events,
  planSyncV7Compaction,
  replaySyncV7Segments,
  validateSyncHeadV7,
} from "../lib/sync-v7-head";
import type { SyncHeadV7, SyncV7Descriptor, SyncV7SegmentDescriptor } from "../lib/sync-v7-head";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sha1 = (digit: string) => digit.repeat(40);
const bytes = (text: string) => new TextEncoder().encode(text);
const descriptor = (prefix: string, content: string): SyncV7Descriptor => {
  const hash = digest(content);
  return { path: `${prefix}${hash}.json`, blobSha: sha1("a"), sha256: hash, size: bytes(content).byteLength };
};
const vaultId = "vault:test-v7";
const createdAt = "2026-08-13T00:00:00.000Z";
const checkpoint = descriptor(SYNC_V7_CHECKPOINT_PREFIX, "initial checkpoint");
const head: SyncHeadV7 = {
  formatVersion: 7,
  vaultId,
  generatedAt: createdAt,
  generation: 0,
  metadata: { vaultId, deviceId: "device-a", producer: "test" },
  checkpoint,
  segments: [],
  cursors: {},
};
validateSyncHeadV7(head);
assertSyncV7Path(SYNC_V7_HEAD_PATH, "head");
assertSyncV7Path(`${SYNC_V7_ASSET_PREFIX}${digest("asset")}.webp`, "asset");
assertSyncV7Path(`${SYNC_V7_OBJECT_PREFIX}${digest("object")}.json`, "object");
assertSyncV7Path(`${SYNC_V7_SEGMENT_PREFIX}${digest("segment")}.json`, "segment");
assert.throws(() => assertSyncV7Path("sync/v7/head.json", "object"), /mutable/);
assert.throws(() => validateSyncHeadV7({ ...head, vaultId: "" }), /vault identity/);
assert.throws(() => validateSyncHeadV7({ ...head, metadata: { ...head.metadata, vaultId: "other" } }), /does not match/);
assert.throws(() => encodeSyncV7Event({ text: "x".repeat(300_000) }), /immutable ref/);
assert.throws(() => validateSyncHeadV7({ ...head, segments: [{ path: `${SYNC_V7_SEGMENT_PREFIX}${"0".repeat(64)}.json`, blobSha: sha1("a"), sha256: checkpoint.sha256, size: 1, generation: 1, ordinal: 0, count: 1, cursors: {}, metadata: { vaultId, createdAt }}] }), /path digest/);

const segment = (generation: number, ordinal: number, size = 100, pathSeed = `${generation}-${ordinal}`): SyncV7SegmentDescriptor => {
  const content = `${pathSeed}:${generation}:${ordinal}`;
  const hash = digest(content);
  return { path: `${SYNC_V7_SEGMENT_PREFIX}${hash}.json`, blobSha: sha1("b"), sha256: hash, size, generation, ordinal, count: 1, cursors: { "device-a": generation * 100 + ordinal }, metadata: { vaultId, createdAt, deviceId: "device-a" } };
};

// One hundred ordinary appends retain the original checkpoint and never ask
// for a checkpoint publication merely because the segment/page count grew.
let appended = head;
for (let index = 0; index < 100; index += 1) {
  const next = appendSyncV7Segments(appended, [segment(1, index)]);
  const publication = createSyncV7AppendPublicationPlan({ expectedHead: appended, head: next, segments: [{ path: segment(1, index).path, bytes: "small", kind: "segment" }] });
  assert.equal(publication.checkpoint, undefined);
  assert.deepEqual(publication.order, ["objects", "segments", "head-cas"]);
  appended = next;
}
assert.equal(appended.segments.length, 100);

// Repack/page count and CAS retries are not checkpoint reasons.
const repack = planSyncV7Compaction({ head: appended, hotSegments: Array.from({ length: 5000 }, () => ({ size: 1 })) });
assert.equal(repack.required, false);
assert.equal(repack.reason, "none");
assert.equal(createSyncV7CompactionPlan({ head: appended, hotBytes: 0, hotSegments: [] }).required, false);

// The byte threshold is strict: exactly 4 MiB does not compact, one byte over
// requires one explicit checkpoint publication.
assert.equal(planSyncV7Compaction({ head: appended, hotBytes: SYNC_V7_MAX_HOT_BYTES }).required, false);
const overflow = planSyncV7Compaction({ head: appended, hotBytes: SYNC_V7_MAX_HOT_BYTES + 1 });
assert.equal(overflow.required, true);
assert.equal(overflow.reason, "hot-window-overflow");
assert.equal(overflow.segmentCount, 0);
assert.throws(() => createSyncV7PublicationPlan({ head: appended, checkpoint: { path: checkpoint.path, bytes: "checkpoint", kind: "checkpoint" } }), /explicit initialization/);

// Replay order follows generation/ordinal even when paths/hashes are reverse
// ordered. No lexical path tie-breaker is consulted.
const replayInput = [
  { generation: 2, ordinal: 0, path: "sync/v7/segments/ffff.json", events: ["g2"] },
  { generation: 1, ordinal: 1, path: "sync/v7/segments/0000.json", events: ["g1b"] },
  { generation: 1, ordinal: 0, path: "sync/v7/segments/aaaa.json", events: ["g1a"] },
];
assert.deepEqual(replaySyncV7Segments(replayInput), ["g1a", "g1b", "g2"]);
assert.deepEqual(orderSyncV7Segments(replayInput).map((item) => [item.generation, item.ordinal]), [[1, 0], [1, 1], [2, 0]]);
assert.throws(() => orderSyncV7Segments([...replayInput, { generation: 1, ordinal: 0, events: ["duplicate"] }]), /duplicate/);

// Large payloads are represented by immutable refs, not oversized inline
// events. References themselves are typed and path/digest checked.
const objectHash = digest("large immutable object");
const objectRef = createSyncV7ObjectRef(`${SYNC_V7_OBJECT_PREFIX}${objectHash}.json`, objectHash, 22);
assert.equal(objectRef.kind, "object");
assert.throws(() => createSyncV7ObjectRef(`${SYNC_V7_OBJECT_PREFIX}${"0".repeat(64)}.json`, objectHash, 22), /sha256/);

const pages = paginateSyncV7Events(Array.from({ length: 100 }, (_, index) => ({ id: index, text: "tiny" })));
assert.ok(pages.length >= 1);
assert.ok(pages.every((page) => page.size > 0 && page.count > 0));

console.log("sync v7 head tests passed: vault identity, explicit byte compaction, append-only publication, replay ordering, refs and limits");
