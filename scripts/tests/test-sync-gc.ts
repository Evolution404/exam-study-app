import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { createGitHubRemote } from "../../src/lib/sync/github-remote";
import { checkpointFromCanonicalState } from "../../src/lib/sync/sync-checkpoint-bridge";
import { gcSyncRemote } from "../../src/lib/sync/sync-gc";
import { SYNC_CHECKPOINT_PREFIX, SYNC_FORMAT_VERSION, SYNC_SEGMENT_PREFIX, type SyncHead, type SyncDescriptor, type SyncSegmentDescriptor } from "../../src/lib/sync/sync-head-types";
import { encodeSyncSegment } from "../../src/lib/sync/sync-head-operations";
import type { CanonicalState } from "../../src/lib/db/types";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const vaultId = "qa/gc@main";
const deviceId = "device-a";

const emptyState: CanonicalState = {
  banks: [],
  bankFolders: [],
  questions: [],
  memberships: [],
  imageAssets: [],
  attempts: [],
  notes: [],
  practiceRuns: [],
  practiceRunSources: [],
  practiceRunItems: [],
  questionGroups: [],
  questionGroupItems: [],
  reviewRounds: [],
  reviewRoundBanks: [],
  reviewRoundItems: [],
  tombstones: [],
};
const canonicalCheckpoint = await checkpointFromCanonicalState(emptyState, {});
assert.deepEqual(Object.keys(canonicalCheckpoint.state).sort(), Object.keys(emptyState).sort(), "checkpoint must serialize the CanonicalState contract exactly");

const server = await startMockGitHubServer({ cas: true });
try {
  const client = createGitHubRemote({ owner: "qa", repo: "sync-gc", branch: "main", token: "qa-token", apiBaseUrl: server.url, vaultId });

  async function checkpoint(label: string, generation: number): Promise<SyncDescriptor> {
    const bytes = new TextEncoder().encode(JSON.stringify({ label, generation }));
    const path = `${SYNC_CHECKPOINT_PREFIX}${sha256(bytes)}.json`;
    const uploaded = await client.putImmutable({ path, bytes, kind: "checkpoint" });
    return { path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize, generation };
  }

  async function segment(label: string, generation: number): Promise<SyncSegmentDescriptor> {
    const metadata = { vaultId, createdAt: new Date(1_700_000_000_000 + generation * 1_000).toISOString(), producer: "gc-test" };
    const cursors = { [deviceId]: generation + 1 };
    const bytes = encodeSyncSegment({ formatVersion: SYNC_FORMAT_VERSION, vaultId, generation, ordinal: 0, metadata, cursors, events: [{ label, deviceId, localSequence: generation + 1 }] });
    const path = `${SYNC_SEGMENT_PREFIX}${sha256(bytes)}.json`;
    const uploaded = await client.putImmutable({ path, bytes, kind: "segment" });
    return { path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize, generation, ordinal: 0, count: 1, cursors, metadata };
  }

  const [c0, c1, c2] = await Promise.all([checkpoint("checkpoint-0", 0), checkpoint("checkpoint-1", 1), checkpoint("checkpoint-2", 2)]);
  const [s0, s1, s2, orphan] = await Promise.all([segment("segment-0", 0), segment("segment-1", 1), segment("segment-2", 2), segment("orphan", 99)]);

  const head = (generation: number, checkpointDescriptor: SyncDescriptor, segments: SyncSegmentDescriptor[]): SyncHead => ({
    formatVersion: SYNC_FORMAT_VERSION,
    vaultId,
    generatedAt: new Date(1_700_000_100_000 + generation * 1_000).toISOString(),
    generation,
    metadata: { vaultId, deviceId, producer: "gc-test" },
    checkpoint: checkpointDescriptor,
    segments,
    cursors: { [deviceId]: generation + 1 },
  });

  const h0 = head(0, c0, [s0]);
  const p0 = await client.putHead(h0);
  assert.equal(p0.ok, true);
  if (!p0.ok) throw new Error("bootstrap head failed");

  const h1 = head(1, c1, [s1]);
  const p1 = await client.putHead(h1, p0.blobSha);
  assert.equal(p1.ok, true);
  if (!p1.ok) throw new Error("head 1 failed");

  const h2 = head(2, c2, [s2]);
  const p2 = await client.putHead(h2, p1.blobSha);
  assert.equal(p2.ok, true);
  if (!p2.ok) throw new Error("head 2 failed");

  const firstGc = await gcSyncRemote(client, h1, p2.cache, { checkpointChanged: true });
  assert.equal(firstGc.checkpointsDeleted, 1, "checkpoint compaction should prune generations older than current + previous");
  assert.equal(firstGc.segmentsDeleted, 2, "segments unreachable from the current/previous heads should be pruned, including orphaned uploads");
  let checkpointPaths = server.contentPaths().filter((path) => path.startsWith(SYNC_CHECKPOINT_PREFIX));
  let segmentPaths = server.contentPaths().filter((path) => path.startsWith(SYNC_SEGMENT_PREFIX));
  assert.deepEqual(new Set(checkpointPaths), new Set([c1.path, c2.path]), "exactly two checkpoint generations should remain after uncontended compaction GC");
  assert.deepEqual(new Set(segmentPaths), new Set([s1.path, s2.path]), "current and previous head segments must remain available");
  assert.ok(!segmentPaths.includes(orphan.path), "orphaned immutable segment should be removed");

  // A future segment is uploaded only immediately before the head that references
  // it, matching the real immutable-first publication order. It must not exist
  // during the prior GC pass or that pass would correctly classify it as orphaned.
  const s3 = await segment("segment-3", 3);
  const h3 = head(3, c2, [s2, s3]);
  const p3 = await client.putHead(h3, p2.blobSha);
  assert.equal(p3.ok, true);
  if (!p3.ok) throw new Error("head 3 failed");
  const appendGc = await gcSyncRemote(client, h2, p3.cache, { checkpointChanged: false });
  assert.equal(appendGc.checkpointsDeleted, 0, "ordinary append must never sweep the previous recovery checkpoint");
  checkpointPaths = server.contentPaths().filter((path) => path.startsWith(SYNC_CHECKPOINT_PREFIX));
  segmentPaths = server.contentPaths().filter((path) => path.startsWith(SYNC_SEGMENT_PREFIX));
  assert.deepEqual(new Set(checkpointPaths), new Set([c1.path, c2.path]), "previous checkpoint must survive ordinary appends until the next compaction");
  assert.deepEqual(new Set(segmentPaths), new Set([s2.path, s3.path]), "segment grace window advances one head generation at a time");

  console.log("sync GC tests passed: canonical checkpoint schema, post-CAS pruning, two-checkpoint retention, segment grace window and append safety");
} finally {
  await server.close();
}
