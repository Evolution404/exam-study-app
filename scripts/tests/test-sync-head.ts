import type { ChangeSetQueueRecord } from "../../src/lib/db/db";
import type { CanonicalState } from "../../src/lib/db/types";
import { assetUploadProgressLabel, formatTransferBytes, mergeActiveHistoryState, reconcileInterruptedClaims } from "../../src/lib/sync/sync-orchestrator-model";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SYNC_ASSET_PREFIX, SYNC_CHECKPOINT_PREFIX, SYNC_FORMAT_VERSION, SYNC_HEAD_PATH, SYNC_MAX_HOT_BYTES, SYNC_OBJECT_PREFIX, SYNC_SEGMENT_PREFIX } from "../../src/lib/sync/sync-head-types";
import { assertSyncPath, validateSyncHead, validateSyncDescriptor } from "../../src/lib/sync/sync-head-validation";
import { appendSyncSegments, createSyncAppendPublicationPlan, createSyncCompactionPlan, createSyncObjectRef, createSyncPublicationPlan, encodeSyncEvent, orderSyncSegments, paginateSyncEvents, planSyncCompaction, replaySyncSegments } from "../../src/lib/sync/sync-head-operations";
import type { SyncHead, SyncDescriptor, SyncSegmentDescriptor } from "../../src/lib/sync/sync-head-types";

const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const sha1 = (digit: string) => digit.repeat(40);
const bytes = (text: string) => new TextEncoder().encode(text);
const descriptor = (prefix: string, content: string): SyncDescriptor => {
  const hash = digest(content);
  return { path: `${prefix}${hash}.json`, blobSha: sha1("a"), sha256: hash, size: bytes(content).byteLength, storedSize: bytes(content).byteLength };
};
const vaultId = "vault:test-current";
const createdAt = "2026-08-13T00:00:00.000Z";
const checkpoint = descriptor(SYNC_CHECKPOINT_PREFIX, "initial checkpoint");
const head: SyncHead = {
  formatVersion: SYNC_FORMAT_VERSION,
  vaultId,
  generatedAt: createdAt,
  generation: 0,
  metadata: { vaultId, deviceId: "device-a", producer: "test" },
  checkpoint,
  segments: [],
  cursors: {},
};
validateSyncHead(head);
assertSyncPath(SYNC_HEAD_PATH, "head");
assertSyncPath(`${SYNC_ASSET_PREFIX}${digest("asset")}.webp`, "asset");
assertSyncPath(`${SYNC_OBJECT_PREFIX}${digest("object")}.json`, "object");
assertSyncPath(`${SYNC_SEGMENT_PREFIX}${digest("segment")}.json`, "segment");
assert.throws(() => assertSyncPath(SYNC_HEAD_PATH, "object"), /mutable/);
assert.throws(() => validateSyncHead({ ...head, vaultId: "" }), /vault identity/);
assert.throws(() => validateSyncHead({ ...head, metadata: { ...head.metadata, vaultId: "other" } }), /does not match/);
assert.throws(() => encodeSyncEvent({ text: "x".repeat(300_000) }), /immutable ref/);
assert.throws(() => validateSyncHead({ ...head, segments: [{ path: `${SYNC_SEGMENT_PREFIX}${"0".repeat(64)}.json`, blobSha: sha1("a"), sha256: checkpoint.sha256, size: 1, storedSize: 1, generation: 1, ordinal: 0, count: 1, cursors: {}, metadata: { vaultId, createdAt }}] }), /path digest/);

const segment = (generation: number, ordinal: number, size = 100, pathSeed = `${generation}-${ordinal}`): SyncSegmentDescriptor => {
  const content = `${pathSeed}:${generation}:${ordinal}`;
  const hash = digest(content);
  return { path: `${SYNC_SEGMENT_PREFIX}${hash}.json`, blobSha: sha1("b"), sha256: hash, size, storedSize: size, generation, ordinal, count: 1, cursors: { "device-a": generation * 100 + ordinal }, metadata: { vaultId, createdAt, deviceId: "device-a" } };
};

let appended = head;
for (let index = 0; index < 100; index += 1) {
  const next = appendSyncSegments(appended, [segment(1, index)]);
  const publication = createSyncAppendPublicationPlan({ expectedHead: appended, head: next, segments: [{ path: segment(1, index).path, bytes: "small", kind: "segment" }] });
  assert.equal(publication.checkpoint, undefined);
  assert.deepEqual(publication.order, ["objects", "segments", "head-cas"]);
  appended = next;
}
assert.equal(appended.segments.length, 100);

const repack = planSyncCompaction({ head: appended, hotSegments: Array.from({ length: 5000 }, () => ({ size: 1 })) });
assert.equal(repack.required, false);
assert.equal(repack.reason, "none");
assert.equal(createSyncCompactionPlan({ head: appended, hotBytes: 0, hotSegments: [] }).required, false);

assert.equal(planSyncCompaction({ head: appended, hotBytes: SYNC_MAX_HOT_BYTES }).required, false);
const overflow = planSyncCompaction({ head: appended, hotBytes: SYNC_MAX_HOT_BYTES + 1 });
assert.equal(overflow.required, true);
assert.equal(overflow.reason, "hot-window-overflow");
assert.equal(overflow.segmentCount, 0);
assert.throws(() => createSyncPublicationPlan({ head: appended, checkpoint: { path: checkpoint.path, bytes: "checkpoint", kind: "checkpoint" } }), /explicit initialization/);
const compactedCheckpoint = descriptor(SYNC_CHECKPOINT_PREFIX, "overflow checkpoint");
const compactedHead: SyncHead = { ...appended, checkpoint: compactedCheckpoint, segments: [], generation: appended.generation + 1 };
const compactedPublication = createSyncPublicationPlan({ expectedHead: appended, head: compactedHead, checkpoint: { path: compactedCheckpoint.path, bytes: "overflow checkpoint", kind: "checkpoint" }, compaction: overflow });
assert.equal(compactedPublication.mode, "compaction");
assert.deepEqual(compactedPublication.order, ["checkpoint", "objects", "segments", "head-cas"]);

const replayInput = [
  { generation: 2, ordinal: 0, path: `${SYNC_SEGMENT_PREFIX}ffff.json`, events: ["g2"] },
  { generation: 1, ordinal: 1, path: `${SYNC_SEGMENT_PREFIX}0000.json`, events: ["g1b"] },
  { generation: 1, ordinal: 0, path: `${SYNC_SEGMENT_PREFIX}aaaa.json`, events: ["g1a"] },
];
assert.deepEqual(replaySyncSegments(replayInput), ["g1a", "g1b", "g2"]);
assert.deepEqual(orderSyncSegments(replayInput).map((item) => [item.generation, item.ordinal]), [[1, 0], [1, 1], [2, 0]]);
assert.throws(() => orderSyncSegments([...replayInput, { generation: 1, ordinal: 0, events: ["duplicate"] }]), /duplicate/);

const objectHash = digest("large immutable object");
const objectRef = createSyncObjectRef(`${SYNC_OBJECT_PREFIX}${objectHash}.json`, objectHash, 22);
assert.equal(objectRef.kind, "object");
assert.throws(() => createSyncObjectRef(`${SYNC_OBJECT_PREFIX}${"0".repeat(64)}.json`, objectHash, 22), /sha256/);

const pages = paginateSyncEvents(Array.from({ length: 100 }, (_, index) => ({ id: index, text: "tiny" })));
assert.ok(pages.length >= 1);
assert.ok(pages.every((page) => page.size > 0 && page.count > 0));

{
  const base = { path: SYNC_CHECKPOINT_PREFIX + "a".repeat(64) + ".json", blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 100 };
  const withStored = { ...base, storedSize: 42 };
  assert.ok(validateSyncDescriptor(withStored, "checkpoint") === undefined, "storedSize 合法");
  let rejected = false;
  try { validateSyncDescriptor({ ...base, storedSize: -1 }, "checkpoint"); } catch { rejected = true; }
  assert.equal(rejected, true, "负 storedSize 必须被拒");
}

assert.equal(formatTransferBytes(1023), "1023 B");
assert.equal(formatTransferBytes(1024), "1.0 KB");
assert.equal(formatTransferBytes(1024 * 1024), "1.0 MB");
assert.equal(assetUploadProgressLabel({ completed: 0, total: 8, uploadedBytes: 0, totalBytes: 4096, concurrency: 4 }), "准备并发上传 8 张图片（4 路）");
assert.equal(assetUploadProgressLabel({ completed: 2, total: 8, uploadedBytes: 2048, totalBytes: 4096, concurrency: 4 }), "正在上传图片（2/8，2.0 KB / 4.0 KB）");

const claimed = (id: string, digestValue: string, sequence: number, deviceId = "device-a") => ({
  id,
  digest: digestValue,
  deviceId,
  localSequence: sequence,
  state: "claimed",
  claimId: "claim-1",
  claimedAt: "2026-08-26T00:00:00.000Z",
} as ChangeSetQueueRecord);
const claimedInput = [claimed("conflict", "local-a", 10), claimed("remote", "same-b", 11), claimed("cursor", "local-c", 12), claimed("pending", "local-d", 13)];
const claimedSnapshot = structuredClone(claimedInput);
const reconciled = reconcileInterruptedClaims(
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

const state = {
  banks: [],
  bankFolders: [],
  questions: [],
  memberships: [],
  imageAssets: [],
  attempts: [{ id: "attempt-remote" } as never],
  notes: [],
  practiceRuns: [{ id: "run-remote" } as never],
  practiceRunSources: [{ runId: "run-remote", bankId: "bank-remote", position: 0 } as never],
  practiceRunItems: [{ runId: "run-remote", questionId: "q-remote", position: 0 } as never],
  questionGroups: [],
  questionGroupItems: [],
  reviewRounds: [],
  reviewRoundBanks: [],
  reviewRoundItems: [],
  tombstones: [],
} satisfies CanonicalState;
const mergedHistory = mergeActiveHistoryState(state, {
  runs: [{ id: "run-remote", marker: "local" } as never, { id: "run-local" } as never],
  sources: [{ runId: "run-remote", bankId: "bank-local", marker: "local" } as never, { runId: "run-local", bankId: "bank-local" } as never],
  items: [{ runId: "run-remote", questionId: "q-local", marker: "local" } as never, { runId: "run-local", questionId: "q-local" } as never],
  attempts: [{ id: "attempt-remote", marker: "local" } as never, { id: "attempt-local" } as never],
});
assert.deepEqual(mergedHistory.practiceRuns.map((run) => run.id), ["run-remote", "run-local"]);
assert.deepEqual(mergedHistory.attempts.map((attempt) => attempt.id), ["attempt-remote", "attempt-local"]);
assert.equal((mergedHistory.practiceRuns[0] as unknown as { marker?: string }).marker, "local", "active local run must override the remote row with the same id");
assert.equal((mergedHistory.attempts[0] as unknown as { marker?: string }).marker, "local", "active local attempt must override the remote row with the same id");
assert.deepEqual(mergedHistory.practiceRunSources.map((row) => row.runId), ["run-remote", "run-local"]);
assert.deepEqual(mergedHistory.practiceRunItems.map((row) => row.runId), ["run-remote", "run-local"]);
assert.equal(mergedHistory.questions, state.questions, "history merge must leave unrelated canonical tables untouched");
assert.notEqual(mergedHistory.practiceRuns, state.practiceRuns, "history merge must return a fresh run collection");

console.log("sync head tests passed: vault identity, explicit byte compaction, append-only publication, replay ordering, refs and limits");
