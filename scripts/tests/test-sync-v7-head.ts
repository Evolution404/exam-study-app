import type { ChangeSetQueueRecordV7 } from "../../src/lib/db/db-v7";
import type { ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import { assetUploadProgressLabelV7, formatTransferBytesV7, mergeActiveHistoryProjectionV7, reconcileInterruptedClaimsV7 } from "../../src/lib/sync/sync-v7-orchestrator-model";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SYNC_V9_ASSET_PREFIX, SYNC_V9_CHECKPOINT_PREFIX, SYNC_V9_HEAD_PATH, SYNC_V7_MAX_HOT_BYTES, SYNC_V9_OBJECT_PREFIX, SYNC_V9_SEGMENT_PREFIX } from "../../src/lib/sync/sync-v7-head-types";
import { assertSyncV7Path, validateSyncHeadV7, validateSyncV7Descriptor } from "../../src/lib/sync/sync-v7-head-validation";
import { appendSyncV7Segments, createSyncV7AppendPublicationPlan, createSyncV7CompactionPlan, createSyncV7ObjectRef, createSyncV7PublicationPlan, encodeSyncV7Event, orderSyncV7Segments, paginateSyncV7Events, planSyncV7Compaction, replaySyncV7Segments } from "../../src/lib/sync/sync-v7-head-operations";
import type { SyncHeadV7, SyncV7Descriptor, SyncV7SegmentDescriptor } from "../../src/lib/sync/sync-v7-head-types";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sha1 = (digit: string) => digit.repeat(40);
const bytes = (text: string) => new TextEncoder().encode(text);
const descriptor = (prefix: string, content: string): SyncV7Descriptor => {
  const hash = digest(content);
  return { path: `${prefix}${hash}.json`, blobSha: sha1("a"), sha256: hash, size: bytes(content).byteLength, storedSize: bytes(content).byteLength };
};
const vaultId = "vault:test-v7";
const createdAt = "2026-08-13T00:00:00.000Z";
const checkpoint = descriptor(SYNC_V9_CHECKPOINT_PREFIX, "initial checkpoint");
const head: SyncHeadV7 = {
  formatVersion: 9,
  vaultId,
  generatedAt: createdAt,
  generation: 0,
  metadata: { vaultId, deviceId: "device-a", producer: "test" },
  checkpoint,
  segments: [],
  cursors: {},
};
validateSyncHeadV7(head);
assertSyncV7Path(SYNC_V9_HEAD_PATH, "head");
assertSyncV7Path(`${SYNC_V9_ASSET_PREFIX}${digest("asset")}.webp`, "asset");
assertSyncV7Path(`${SYNC_V9_OBJECT_PREFIX}${digest("object")}.json`, "object");
assertSyncV7Path(`${SYNC_V9_SEGMENT_PREFIX}${digest("segment")}.json`, "segment");
assert.throws(() => assertSyncV7Path("sync/v9/head.json", "object"), /mutable/);
assert.throws(() => validateSyncHeadV7({ ...head, vaultId: "" }), /vault identity/);
assert.throws(() => validateSyncHeadV7({ ...head, metadata: { ...head.metadata, vaultId: "other" } }), /does not match/);
assert.throws(() => encodeSyncV7Event({ text: "x".repeat(300_000) }), /immutable ref/);
assert.throws(() => validateSyncHeadV7({ ...head, segments: [{ path: `${SYNC_V9_SEGMENT_PREFIX}${"0".repeat(64)}.json`, blobSha: sha1("a"), sha256: checkpoint.sha256, size: 1, storedSize: 1, generation: 1, ordinal: 0, count: 1, cursors: {}, metadata: { vaultId, createdAt }}] }), /path digest/);

const segment = (generation: number, ordinal: number, size = 100, pathSeed = `${generation}-${ordinal}`): SyncV7SegmentDescriptor => {
  const content = `${pathSeed}:${generation}:${ordinal}`;
  const hash = digest(content);
  return { path: `${SYNC_V9_SEGMENT_PREFIX}${hash}.json`, blobSha: sha1("b"), sha256: hash, size, storedSize: size, generation, ordinal, count: 1, cursors: { "device-a": generation * 100 + ordinal }, metadata: { vaultId, createdAt, deviceId: "device-a" } };
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
const compactedCheckpoint = descriptor(SYNC_V9_CHECKPOINT_PREFIX, "overflow checkpoint");
const compactedHead: SyncHeadV7 = { ...appended, checkpoint: compactedCheckpoint, segments: [], generation: appended.generation + 1 };
const compactedPublication = createSyncV7PublicationPlan({ expectedHead: appended, head: compactedHead, checkpoint: { path: compactedCheckpoint.path, bytes: "overflow checkpoint", kind: "checkpoint" }, compaction: overflow });
assert.equal(compactedPublication.mode, "compaction");
assert.deepEqual(compactedPublication.order, ["checkpoint", "objects", "segments", "head-cas"]);

// Replay order follows generation/ordinal even when paths/hashes are reverse
// ordered. No lexical path tie-breaker is consulted.
const replayInput = [
  { generation: 2, ordinal: 0, path: "sync/v9/segments/ffff.json", events: ["g2"] },
  { generation: 1, ordinal: 1, path: "sync/v9/segments/0000.json", events: ["g1b"] },
  { generation: 1, ordinal: 0, path: "sync/v9/segments/aaaa.json", events: ["g1a"] },
];
assert.deepEqual(replaySyncV7Segments(replayInput), ["g1a", "g1b", "g2"]);
assert.deepEqual(orderSyncV7Segments(replayInput).map((item) => [item.generation, item.ordinal]), [[1, 0], [1, 1], [2, 0]]);
assert.throws(() => orderSyncV7Segments([...replayInput, { generation: 1, ordinal: 0, events: ["duplicate"] }]), /duplicate/);

// Large payloads are represented by immutable refs, not oversized inline
// events. References themselves are typed and path/digest checked.
const objectHash = digest("large immutable object");
const objectRef = createSyncV7ObjectRef(`${SYNC_V9_OBJECT_PREFIX}${objectHash}.json`, objectHash, 22);
assert.equal(objectRef.kind, "object");
assert.throws(() => createSyncV7ObjectRef(`${SYNC_V9_OBJECT_PREFIX}${"0".repeat(64)}.json`, objectHash, 22), /sha256/);

const pages = paginateSyncV7Events(Array.from({ length: 100 }, (_, index) => ({ id: index, text: "tiny" })));
assert.ok(pages.length >= 1);
assert.ok(pages.every((page) => page.size > 0 && page.count > 0));

// storedSize（实际存储/线上字节）：合法可选字段；非法值被拒。
{
  const base = { path: "sync/v9/checkpoints/" + "a".repeat(64) + ".json", blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 100 };
  const withStored = { ...base, storedSize: 42 };
  assert.ok(validateSyncV7Descriptor(withStored, "checkpoint") === undefined, "storedSize 合法");
  let rejected = false;
  try { validateSyncV7Descriptor({ ...base, storedSize: -1 }, "checkpoint"); } catch { rejected = true; }
  assert.equal(rejected, true, "负 storedSize 必须被拒");
}


// Orchestrator structure helpers are behavior contracts: extracting them must
// not change upload labels, interrupted-claim recovery, or history preservation.
assert.equal(formatTransferBytesV7(1023), "1023 B");
assert.equal(formatTransferBytesV7(1024), "1.0 KB");
assert.equal(formatTransferBytesV7(1024 * 1024), "1.0 MB");
assert.equal(assetUploadProgressLabelV7({ completed: 0, total: 8, uploadedBytes: 0, totalBytes: 4096, concurrency: 4 }), "准备并发上传 8 张图片（4 路）");
assert.equal(assetUploadProgressLabelV7({ completed: 2, total: 8, uploadedBytes: 2048, totalBytes: 4096, concurrency: 4 }), "正在上传图片（2/8，2.0 KB / 4.0 KB）");

const claimed = (id: string, digestValue: string, sequence: number, deviceId = "device-a") => ({
  id,
  digest: digestValue,
  deviceId,
  localSequence: sequence,
  state: "claimed",
  claimId: "claim-1",
  claimedAt: "2026-08-26T00:00:00.000Z",
} as ChangeSetQueueRecordV7);
const claimedInput = [claimed("conflict", "local-a", 10), claimed("remote", "same-b", 11), claimed("cursor", "local-c", 12), claimed("pending", "local-d", 13)];
const claimedSnapshot = structuredClone(claimedInput);
const reconciled = reconcileInterruptedClaimsV7(
  claimedInput,
  [{ id: "conflict", digest: "remote-a" }, { id: "remote", digest: "same-b" }],
  { "device-a": 12 },
  () => "2026-08-26T01:00:00.000Z",
);
assert.equal(reconciled[0].state, "blocked");
assert.match(reconciled[0].blockedReason ?? "", /内容不同/);
assert.equal(reconciled[0].claimId, undefined);
assert.equal(reconciled[1].state, "committed");
assert.equal(reconciled[1].committedAt, "2026-08-26T01:00:00.000Z");
assert.equal(reconciled[2].state, "committed", "cursor coverage must recover an interrupted claim even when its id was GC'd remotely");
assert.equal(reconciled[3].state, "pending", "uncovered interrupted claims must return to the pending queue");
assert.deepEqual(claimedInput, claimedSnapshot, "claim reconciliation must not mutate the queue snapshot");

const projection = {
  banks: [], bankFolders: [], questions: [], memberships: [], imageAssets: [],
  attempts: [{ id: "attempt-remote" } as never], attemptStats: [], attemptDailyStats: [], notes: [],
  practiceRuns: [{ id: "run-remote" } as never], practiceRunStats: [], questionGroups: [],
  reviewRounds: [], reviewRoundProgress: [], tombstones: [],
} satisfies ChangeSetProjectionV7;
const mergedHistory = mergeActiveHistoryProjectionV7(
  projection,
  [{ id: "run-remote", marker: "local" } as never, { id: "run-local" } as never],
  [{ id: "attempt-remote", marker: "local" } as never, { id: "attempt-local" } as never],
);
assert.deepEqual(mergedHistory.practiceRuns.map((run) => run.id), ["run-remote", "run-local"]);
assert.deepEqual(mergedHistory.attempts.map((attempt) => attempt.id), ["attempt-remote", "attempt-local"]);
assert.equal((mergedHistory.practiceRuns[0] as unknown as { marker?: string }).marker, "local", "active local run must override the remote row with the same id");
assert.equal((mergedHistory.attempts[0] as unknown as { marker?: string }).marker, "local", "active local attempt must override the remote row with the same id");
assert.equal(mergedHistory.questions, projection.questions, "history merge must leave unrelated projection tables untouched");
assert.notEqual(mergedHistory.practiceRuns, projection.practiceRuns, "history merge must return a fresh run collection");

console.log("sync v7 head tests passed: vault identity, explicit byte compaction, append-only publication, replay ordering, refs and limits");
