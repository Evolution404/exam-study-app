import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGitHubV7Remote } from "../../src/lib/sync/github-v7-remote";
import { gcSyncV7Remote } from "../../src/lib/sync/sync-v7-gc";
import {
  SYNC_V7_CHECKPOINT_PREFIX,
  SYNC_V7_SEGMENT_PREFIX,
  encodeSyncV7Segment,
  type SyncHeadV7,
  type SyncV7Descriptor,
  type SyncV7SegmentDescriptor,
} from "../../src/lib/sync/sync-v7-head";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const vaultId = "qa/v7-gc@main";
const deviceId = "device-a";

const server = await startMockGitHubServer({ cas: true });
try {
  const client = createGitHubV7Remote({ owner: "qa", repo: "v7-gc", branch: "main", token: "qa-token", apiBaseUrl: server.url, vaultId });

  async function checkpoint(label: string, generation: number): Promise<SyncV7Descriptor> {
    const bytes = new TextEncoder().encode(JSON.stringify({ label, generation }));
    const path = `${SYNC_V7_CHECKPOINT_PREFIX}${sha256(bytes)}.json`;
    const uploaded = await client.putImmutable({ path, bytes, kind: "checkpoint" });
    return { path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize, generation };
  }

  async function segment(label: string, generation: number): Promise<SyncV7SegmentDescriptor> {
    const metadata = { vaultId, createdAt: new Date(1_700_000_000_000 + generation * 1_000).toISOString(), producer: "gc-test" };
    const cursors = { [deviceId]: generation + 1 };
    const bytes = encodeSyncV7Segment({ formatVersion: 7, vaultId, generation, ordinal: 0, metadata, cursors, events: [{ label, deviceId, localSequence: generation + 1 }] });
    const path = `${SYNC_V7_SEGMENT_PREFIX}${sha256(bytes)}.json`;
    const uploaded = await client.putImmutable({ path, bytes, kind: "segment" });
    return { path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize, generation, ordinal: 0, count: 1, cursors, metadata };
  }

  const [c0, c1, c2] = await Promise.all([checkpoint("checkpoint-0", 0), checkpoint("checkpoint-1", 1), checkpoint("checkpoint-2", 2)]);
  const [s0, s1, s2, s3] = await Promise.all([segment("segment-0", 0), segment("segment-1", 1), segment("segment-2", 2), segment("segment-3", 3)]);

  const head = (generation: number, checkpointDescriptor: SyncV7Descriptor, segments: SyncV7SegmentDescriptor[]): SyncHeadV7 => ({
    formatVersion: 7,
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

  const firstGc = await gcSyncV7Remote(client, h1, p2.cache, { checkpointChanged: true });
  assert.equal(firstGc.checkpointsDeleted, 1, "checkpoint compaction should prune generations older than current + previous");
  assert.equal(firstGc.segmentsDeleted, 2, "segments unreachable from the current/previous heads should be pruned (including never-referenced test segment)");
  let checkpointPaths = server.contentPaths().filter((path) => path.startsWith(SYNC_V7_CHECKPOINT_PREFIX));
  let segmentPaths = server.contentPaths().filter((path) => path.startsWith(SYNC_V7_SEGMENT_PREFIX));
  assert.deepEqual(new Set(checkpointPaths), new Set([c1.path, c2.path]), "exactly two checkpoint generations should remain after uncontended compaction GC");
  assert.deepEqual(new Set(segmentPaths), new Set([s1.path, s2.path]), "current and previous head segments must remain available");

  const h3 = head(3, c2, [s2, s3]);
  const p3 = await client.putHead(h3, p2.blobSha);
  assert.equal(p3.ok, true);
  if (!p3.ok) throw new Error("head 3 failed");
  const appendGc = await gcSyncV7Remote(client, h2, p3.cache, { checkpointChanged: false });
  assert.equal(appendGc.checkpointsDeleted, 0, "ordinary append must never sweep the previous recovery checkpoint");
  checkpointPaths = server.contentPaths().filter((path) => path.startsWith(SYNC_V7_CHECKPOINT_PREFIX));
  segmentPaths = server.contentPaths().filter((path) => path.startsWith(SYNC_V7_SEGMENT_PREFIX));
  assert.deepEqual(new Set(checkpointPaths), new Set([c1.path, c2.path]), "previous checkpoint must survive ordinary appends until the next compaction");
  assert.deepEqual(new Set(segmentPaths), new Set([s2.path, s3.path]), "segment grace window advances one head generation at a time");

  console.log("sync v7 GC tests passed: post-CAS pruning, two-checkpoint retention, segment grace window and append safety");
} finally {
  await server.close();
}
