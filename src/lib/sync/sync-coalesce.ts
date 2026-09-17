import type { GitHubRemote, SyncHeadCache } from "./github-remote";
import { cursorsFor, descriptorPath, report, sha256, type SyncProgressCallback } from "./sync-context";
import { SYNC_FORMAT_VERSION, SYNC_MAX_SEGMENT_BYTES, SYNC_SEGMENT_PREFIX, type SyncHead, type SyncPublicationFile, type SyncSegmentDescriptor } from "./sync-head-types";
import { createSyncPublicationPlan, decodeSyncSegment, encodeSyncSegment, paginateSyncEvents } from "./sync-head-operations";
import { uploadedDescriptor } from "./sync-upload";
import { gcSyncRemote } from "./sync-gc";

/**
 * Re-pack the hot window into fewer segments once this many have accumulated,
 * even when the byte compaction threshold (4 MiB) has not been reached. Frequent
 * small syncs otherwise leave many tiny segments that a fresh device must fetch
 * one by one. Events are unchanged (same ids/digests); only their grouping does.
 */
const SYNC_COALESCE_SEGMENT_THRESHOLD = 24;
/**
 * Segments at least this large are LEFT UNTOUCHED by coalescing. A near-full
 * segment (≥ half the 1 MiB per-segment ceiling) can absorb little more, so
 * re-packing it would just download + re-upload ~1 MiB and let paginate split it
 * straight back out — pure waste. Only the smaller segments trailing behind the
 * last large one get merged.
 */
const SYNC_COALESCE_LEAVE_BYTES = Math.floor(SYNC_MAX_SEGMENT_BYTES / 2);

/**
 * Coalesce the hot window: merge only the trailing run of SMALL segments into
 * fewer fuller segments and publish a replacement head. Large segments (≥
 * SYNC_COALESCE_LEAVE_BYTES) are left in place — they are already near-full,
 * so re-packing them is pure waste. Only the small segments after the last large
 * one are touched, which keeps replay order intact: the kept prefix stays at its
 * original generation and the merged suffix gets the next generation, so it
 * replays last exactly as before. Events (including offload stubs) are passed
 * through untouched, so referenced immutable objects stay valid. Returns the new
 * head cache when a replacement was published, otherwise null (below threshold,
 * nothing small to merge, no improvement, or a concurrent publish won the CAS).
 */
export async function maybeCoalesceHotWindow(client: GitHubRemote, cache: SyncHeadCache, callback?: SyncProgressCallback): Promise<SyncHeadCache | null> {
  const head = cache.head;
  if (head.segments.length < SYNC_COALESCE_SEGMENT_THRESHOLD) return null;
  const ordered = [...head.segments].sort((a, b) => a.generation - b.generation || a.ordinal - b.ordinal);
  // The kept prefix runs up to and including the last large segment; only the
  // small segments trailing after it are worth merging.
  let suffixStart = ordered.length;
  while (suffixStart > 0 && ordered[suffixStart - 1].size < SYNC_COALESCE_LEAVE_BYTES) suffixStart -= 1;
  const keep = ordered.slice(0, suffixStart);
  const smalls = ordered.slice(suffixStart);
  if (smalls.length < 2) return null;
  report(callback, "compact", `正在合并 ${smalls.length} 个小分段（保留 ${keep.length} 个大分段）`, 94, 98);
  const events: Array<Record<string, unknown>> = [];
  for (const descriptor of smalls) {
    const segment = decodeSyncSegment<Record<string, unknown>>(await client.readBlob(descriptor), { vaultId: head.vaultId, generation: descriptor.generation, ordinal: descriptor.ordinal });
    events.push(...segment.events);
  }
  const pages = paginateSyncEvents(events);
  if (pages.length >= smalls.length) return null;
  const generation = head.generation + 1;
  const now = new Date().toISOString();
  const metadata = { vaultId: head.vaultId, createdAt: now, producer: "exam-study-app" };
  // Head cursors keep the FULL watermark; each coalesced page records its own
  // real coverage (cursorsFor of its events), so a peer can prove the page's
  // events are already folded into its cached checkpoint and skip re-downloading
  // after a re-pack — the previous full-watermark copy made that undecidable.
  const cursors = { ...head.cursors };
  const segmentFiles: SyncPublicationFile[] = [];
  const mergedSegments: SyncSegmentDescriptor[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const ordinal = index;
    const pageCursors = cursorsFor(pages[index].events as Array<{ deviceId: string; localSequence: number }>);
    const segmentBytes = encodeSyncSegment({ formatVersion: SYNC_FORMAT_VERSION, vaultId: head.vaultId, generation, ordinal, metadata, cursors: pageCursors, events: pages[index].events });
    const digest = await sha256(segmentBytes);
    const path = descriptorPath(SYNC_SEGMENT_PREFIX, digest);
    const base = await uploadedDescriptor(client, path, segmentBytes, "segment");
    mergedSegments.push({ ...base, generation, ordinal, count: pages[index].events.length, cursors: pageCursors, metadata });
    segmentFiles.push({ path, bytes: segmentBytes, kind: "segment", uploaded: true });
  }
  const nextHead: SyncHead = { ...head, generatedAt: now, generation, segments: [...keep, ...mergedSegments], cursors };
  const plan = createSyncPublicationPlan({ expectedHead: head, expectedHeadSha: cache.blobSha, head: nextHead, segments: segmentFiles });
  const published = await client.publish(plan);
  if (!published.ok) return null;
  try { await gcSyncRemote(client, head, published.cache, { checkpointChanged: false }); } catch { /* best-effort */ }
  return published.cache;
}
