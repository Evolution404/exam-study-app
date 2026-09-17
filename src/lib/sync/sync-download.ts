import { type ChangeSet } from "./change-set-types";
import { verifyChangeSetDigest } from "./change-set-codec";
import type { GitHubRemote } from "./github-remote";
import { SYNC_DOWNLOAD_CONCURRENCY, descriptorEqual, mapWithConcurrency } from "./sync-context";
import type { RemoteCache } from "./sync-cache";
import type { SyncCheckpoint } from "./sync-checkpoint-types";
import { decodeRemoteCheckpoint } from "./sync-history";
import { normalizeHistorySyncStart } from "./history-sync-range";
import { type SyncHead, type SyncSegmentDescriptor } from "./sync-head-types";
import { decodeSyncSegment } from "./sync-head-operations";
import { hydrateSyncEvents } from "./sync-payload";

/** Exported for the install-fingerprint suite: drives the tiered cache-reuse
 *  decision directly against a remote head + an arbitrary cached view. */
export async function downloadRemote(client: GitHubRemote, head: SyncHead, cached?: RemoteCache, onStep?: (fraction: number, label: string) => void, options: { historySyncStart?: string } = {}): Promise<{ checkpoint: SyncCheckpoint; changes: ChangeSet[]; reusedCache: boolean; archivedAttempts: number; archivedPracticeRuns: number; skippedArchivedAttempts: number; skippedArchivedPracticeRuns: number; historySyncStart?: string }> {
  if (!head.checkpoint) throw new Error("v9 远端缺少初始化检查点。");
  const checkpointDescriptor = head.checkpoint;
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
  const historySyncStart = normalizeHistorySyncStart(options.historySyncStart);
  const checkpointReusable = Boolean(cached && cached.historySyncStart === historySyncStart && cachedHead?.checkpoint && descriptorEqual(cachedHead.checkpoint, head.checkpoint));
  const canReuse = checkpointReusable;
  const coveredCursors = checkpointReusable ? (cached!.checkpoint.cursors ?? {}) : {};
  const cachedSegmentPaths = new Set((cachedHead?.segments ?? []).map((item) => item.path));
  const segmentCovered = (descriptor: SyncSegmentDescriptor): boolean => {
    if (cachedSegmentPaths.has(descriptor.path)) return true;
    const cursors = descriptor.cursors ?? {};
    return Object.keys(cursors).length > 0 && Object.entries(cursors).every(([device, sequence]) => sequence <= (coveredCursors[device] ?? -1));
  };
  // Weight the download steps by their actual bytes so a many-segment pull
  // advances the bar per segment instead of stalling on one flat report.
  const checkpointBytes = canReuse ? 0 : checkpointDescriptor.storedSize;
  const pendingSegments = [...head.segments].sort((a, b) => a.generation - b.generation || a.ordinal - b.ordinal).filter((descriptor) => !(canReuse && segmentCovered(descriptor)));
  const segmentBytes = pendingSegments.reduce((sum, descriptor) => sum + descriptor.storedSize, 0);
  const totalBytes = Math.max(1, checkpointBytes + segmentBytes);
  let checkpointLoadedBytes = 0;
  let completedSegmentBytes = 0;
  const combinedFraction = () => (checkpointLoadedBytes + completedSegmentBytes) / totalBytes;
  const checkpointPromise = canReuse ? Promise.resolve({
    checkpoint: cached!.checkpoint,
    archivedAttempts: 0,
    archivedPracticeRuns: 0,
    skippedArchivedAttempts: 0,
    skippedArchivedPracticeRuns: 0,
    
  }) : (async () => {
    const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    const sizeLabel = `实际 ${megabytes(checkpointDescriptor.storedSize)} / 解压后 ${megabytes(checkpointDescriptor.size)}`;
    onStep?.(0.01, `正在下载检查点（${sizeLabel}）`);
    const bytes = await client.readBlob(checkpointDescriptor, {
      onProgress: (loaded, total) => {
        const ratio = Math.max(0, Math.min(1, total > 0 ? loaded / total : 0));
        checkpointLoadedBytes = checkpointBytes * ratio;
        onStep?.(combinedFraction(), `正在下载检查点（${sizeLabel}）${Math.round(ratio * 100)}%`);
      },
    });
    checkpointLoadedBytes = checkpointBytes;
    onStep?.(combinedFraction(), "检查点已下载");
    const decoded = await decodeRemoteCheckpoint(client, bytes, { historySyncStart });
    return {
      checkpoint: decoded.checkpoint,
      archivedAttempts: decoded.archivedAttempts,
      archivedPracticeRuns: decoded.archivedPracticeRuns,
      skippedArchivedAttempts: decoded.skippedArchivedAttempts,
      skippedArchivedPracticeRuns: decoded.skippedArchivedPracticeRuns,
      
    };
  })();
  // Segments download through a bounded-concurrency pool: each lane fetches,
  // decodes and digest-verifies whole segments; per-segment progress reports
  // accumulate monotonic byte counts, so the bar never moves backwards.
  let doneSegments = 0;
  const changes: ChangeSet[] = [];
  // Reserve one lane for the checkpoint so both sources begin immediately
  // without exceeding the existing overall network concurrency budget.
  const segmentConcurrency = canReuse ? SYNC_DOWNLOAD_CONCURRENCY : Math.max(1, SYNC_DOWNLOAD_CONCURRENCY - 1);
  const segmentChangesPromise = mapWithConcurrency(pendingSegments, segmentConcurrency, async (descriptor) => {
    const segment = decodeSyncSegment<ChangeSet>(await client.readBlob(descriptor), { vaultId: head.vaultId, generation: descriptor.generation, ordinal: descriptor.ordinal });
    // Offloaded events arrive as thin stubs; resolve their bodies to full
    // change-sets before the integrity check + projection, so the reducer and
    // the local queue only ever see complete records.
    const resolved = await hydrateSyncEvents(segment.events, (ref) => client.readImmutableContents(ref.path, { size: ref.size, sha256: ref.sha256 }));
    for (const change of resolved) {
      if (!await verifyChangeSetDigest(change)) throw new Error(`远端变更集 ${change.id} 完整性校验失败。`);
    }
    completedSegmentBytes += descriptor.storedSize;
    doneSegments += 1;
    onStep?.(combinedFraction(), `正在下载热窗口分段（${doneSegments}/${pendingSegments.length}）`);
    return resolved;
  });
  const [checkpointResult, segmentChanges] = await Promise.all([checkpointPromise, segmentChangesPromise]);
  // Flatten in wire order (generation/ordinal) — completion order is irrelevant.
  for (let index = 0; index < pendingSegments.length; index += 1) changes.push(...segmentChanges[index]);
  return { ...checkpointResult, changes, reusedCache: canReuse, historySyncStart };
}
