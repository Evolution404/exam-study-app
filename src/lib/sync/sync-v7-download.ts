import { verifyChangeSetDigestV7, type ChangeSetV7 } from "./change-set-v7";
import type { GitHubV7Remote } from "./github-v7-remote";
import { SYNC_V7_DOWNLOAD_CONCURRENCY, descriptorEqual, mapWithConcurrency } from "./sync-v7-context";
import type { RemoteCacheV7 } from "./sync-v7-cache";
import type { SyncCheckpointV7 } from "./sync-v7-checkpoint";
import { decodeRemoteCheckpoint } from "./sync-v8-history";
import { decodeSyncV7Segment, type SyncHeadV7, type SyncV7SegmentDescriptor } from "./sync-v7-head";
import { hydrateSyncV7Events } from "./sync-v7-payload";

/** Exported for the install-fingerprint suite: drives the tiered cache-reuse
 *  decision directly against a remote head + an arbitrary cached view. */
export async function downloadRemoteV7(client: GitHubV7Remote, head: SyncHeadV7, cached?: RemoteCacheV7, onStep?: (fraction: number, label: string) => void): Promise<{ checkpoint: SyncCheckpointV7; changes: ChangeSetV7[]; reusedCache: boolean; archivedAttempts: number; archivedPracticeRuns: number; remoteCheckpointFormat: 7 | 8 }> {
  if (!head.checkpoint) throw new Error("v8 远端缺少初始化检查点。");
  // Tiered cache reuse, keyed on CHECKPOINT identity (not on segment layout):
  //  tier 1 — checkpoint descriptor unchanged: the cached FOLDED checkpoint
  //           (original checkpoint + every segment replayed at save time) is a
  //           valid base and costs zero network.  A segment is skipped when its
  //           path is byte-identical to a cached one, OR when its page cursors
  //           are entirely below the cached checkpoint's watermark — the second
  //           rule is what survives a coalesce re-pack, where every path changes
  //           but the events are the same.  (Previously ANY re-pack invalidated
  //           the whole cache and re-downloaded the unchanged checkpoint.)
  //  tier 2 — checkpoint descriptor changed (real compaction): download the new
  //           checkpoint and every segment, replay from scratch.
  const cachedHead = cached?.head.head;
  const checkpointReusable = Boolean(cached && cachedHead?.checkpoint && descriptorEqual(cachedHead.checkpoint, head.checkpoint));
  const canReuse = checkpointReusable;
  const coveredCursors = checkpointReusable ? (cached!.checkpoint.cursors ?? {}) : {};
  const cachedSegmentPaths = new Set((cachedHead?.segments ?? []).map((item) => item.path));
  const segmentCovered = (descriptor: SyncV7SegmentDescriptor): boolean => {
    if (cachedSegmentPaths.has(descriptor.path)) return true;
    const cursors = descriptor.cursors ?? {};
    return Object.keys(cursors).length > 0 && Object.entries(cursors).every(([device, sequence]) => sequence <= (coveredCursors[device] ?? -1));
  };
  // Weight the download steps by their actual bytes so a many-segment pull
  // advances the bar per segment instead of stalling on one flat report.
  const checkpointBytes = canReuse ? 0 : head.checkpoint.size;
  const pendingSegments = [...head.segments].sort((a, b) => a.generation - b.generation || a.ordinal - b.ordinal).filter((descriptor) => !(canReuse && segmentCovered(descriptor)));
  const segmentBytes = pendingSegments.reduce((sum, descriptor) => sum + descriptor.size, 0);
  const totalBytes = Math.max(1, checkpointBytes + segmentBytes);
  let doneBytes = 0;
  let checkpoint: SyncCheckpointV7;
  let archivedAttempts = 0;
  let archivedPracticeRuns = 0;
  let remoteCheckpointFormat: 7 | 8 = 7;
  if (canReuse) {
    checkpoint = cached!.checkpoint;
  } else {
    const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    const sizeLabel = head.checkpoint.storedSize !== undefined
      ? `实际 ${megabytes(head.checkpoint.storedSize)} / 解压后 ${megabytes(head.checkpoint.size)}`
      : `解压后 ${megabytes(head.checkpoint.size)}`;
    onStep?.(0.01, `正在下载检查点（${sizeLabel}）`);
    const decoded = await decodeRemoteCheckpoint(client, await client.readBlob(head.checkpoint));
    checkpoint = decoded.checkpoint;
    archivedAttempts = decoded.archivedAttempts;
    archivedPracticeRuns = decoded.archivedPracticeRuns;
    remoteCheckpointFormat = decoded.remoteFormatVersion;
  }
  if (!canReuse) {
    doneBytes += checkpointBytes;
    onStep?.(doneBytes / totalBytes, "检查点已下载");
  }
  // Segments download through a bounded-concurrency pool: each lane fetches,
  // decodes and digest-verifies whole segments; per-segment progress reports
  // accumulate monotonic byte counts, so the bar never moves backwards.
  let doneSegments = 0;
  const changes: ChangeSetV7[] = [];
  const segmentChanges = await mapWithConcurrency(pendingSegments, SYNC_V7_DOWNLOAD_CONCURRENCY, async (descriptor) => {
    const segment = decodeSyncV7Segment<ChangeSetV7>(await client.readBlob(descriptor), { vaultId: head.vaultId, generation: descriptor.generation, ordinal: descriptor.ordinal });
    // Offloaded events arrive as thin stubs; resolve their bodies to full
    // change-sets before the integrity check + projection, so the reducer and
    // the local queue only ever see complete records.
    const resolved = await hydrateSyncV7Events(segment.events, (ref) => client.readImmutableContents(ref.path, { size: ref.size, sha256: ref.sha256 }));
    for (const change of resolved) {
      if (!await verifyChangeSetDigestV7(change)) throw new Error(`远端变更集 ${change.id} 完整性校验失败。`);
    }
    doneBytes += descriptor.size;
    doneSegments += 1;
    onStep?.(doneBytes / totalBytes, `正在下载热窗口分段（${doneSegments}/${pendingSegments.length}）`);
    return resolved;
  });
  // Flatten in wire order (generation/ordinal) — completion order is irrelevant.
  for (let index = 0; index < pendingSegments.length; index += 1) changes.push(...segmentChanges[index]!);
  return { checkpoint, changes, reusedCache: canReuse, archivedAttempts, archivedPracticeRuns, remoteCheckpointFormat };
}
