import {
  commitChangeSetClaimV7,
  dbV6,
  getV6DeviceId,
  listChangeSetsV7,
  releaseChangeSetClaimV7,
  claimPendingChangeSetsV7,
  restoreV6Checkpoint,
  type ChangeSetQueueRecordV7,
} from "../db/db-v6";
import { verifyChangeSetDigestV7, type ChangeSetV7 } from "./change-set-v7";
import { assertChangeSetProjectionV7, reduceChangeSetV7, replayChangeSetBatchV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import { createSyncCheckpointV6, encodeSyncCheckpointV6, parseSyncCheckpointV6, type SyncCheckpointV6 } from "./sync-v6-checkpoint";
import {
  SYNC_V7_CHECKPOINT_PREFIX,
  SYNC_V7_MAX_HOT_BYTES,
  SYNC_V7_MAX_SEGMENT_BYTES,
  SYNC_V7_SEGMENT_PREFIX,
  createSyncV7PublicationPlan,
  decodeSyncV7Segment,
  encodeSyncV7Segment,
  mergeSyncV7Segments,
  paginateSyncV7Events,
  planSyncV7Compaction,
  type SyncHeadV7,
  type SyncV7Descriptor,
  type SyncV7DeviceWatermark,
  type SyncV7PublicationFile,
  type SyncV7SegmentDescriptor,
} from "./sync-v7-head";
import type { TombstoneV6 } from "../db/v6-types";
import { GitHubV7Remote, type SyncV7HeadCache } from "./github-v7-remote";
import { hydrateSyncV7Events, offloadSyncV7Events } from "./sync-v7-payload";
import type { GitHubSettings } from "../../types/types";

export type SyncProgress = { phase: "prepare" | "download" | "merge" | "upload" | "compact" | "cache" | "history" | "complete"; label: string; percent: number; /** Planned end-of-phase percent — the UI creeps toward it while a step runs long. */ to?: number };
export type SyncProgressCallback = (progress: SyncProgress) => void;

/**
 * Phase percent bands for one sync run, laid out over 0–100 so the bar always
 * advances inside the phase that is actually doing the work.  The layout
 * adapts to whether a push is expected: a pull-only run stretches download /
 * merge / install instead of reserving an upload band it will never enter.
 */
interface SyncBands { download: readonly [number, number]; merge: readonly [number, number]; install: readonly [number, number]; upload?: readonly [number, number]; cache: readonly [number, number]; }

function syncBands(hasPush: boolean): SyncBands {
  return hasPush
    ? { download: [6, 34], merge: [34, 46], install: [46, 56], upload: [56, 92], cache: [92, 98] }
    : { download: [6, 50], merge: [50, 70], install: [70, 92], cache: [92, 98] };
}

function bandPercent(band: readonly [number, number], fraction: number): number {
  return band[0] + (band[1] - band[0]) * Math.max(0, Math.min(1, fraction));
}

/**
 * Wrap a callback so a run's reported percent never moves backwards — a CAS
 * retry restarts the download/upload steps, and the bar should hold its
 * position (labels still update) instead of snapping back to the start.
 */
function monotonicProgress(callback?: SyncProgressCallback): SyncProgressCallback | undefined {
  if (!callback) return undefined;
  let floor = 0;
  return (progress) => {
    const percent = Math.max(progress.percent, floor);
    floor = percent;
    callback({ ...progress, percent });
  };
}

const CACHE_PREFIX = "v7:sync:";

function report(callback: SyncProgressCallback | undefined, phase: SyncProgress["phase"], label: string, percent: number, to?: number): void {
  callback?.({ phase, label, percent: Math.max(0, Math.min(100, Math.round(percent))), ...(to !== undefined ? { to: Math.max(0, Math.min(100, Math.round(to))) } : {}) });
}

function branch(settings: GitHubSettings): string { return settings.branch?.trim() || "main"; }
function vaultId(settings: GitHubSettings): string { return `${settings.owner.toLocaleLowerCase("en-US")}/${settings.repo.toLocaleLowerCase("en-US")}@${branch(settings)}`; }
function cacheKey(settings: GitHubSettings, suffix: string): string { return `${CACHE_PREFIX}${suffix}:${vaultId(settings)}`; }

/**
 * Optional injection seam for tests. `fetch` lets a test substitute a flaky or
 * fault-injecting fetch to exercise network-error / retry paths through the full
 * sync loop without touching the mock server. Production callers omit it.
 */
export type SyncWithGitHubOptions = { fetch?: typeof fetch };

function remote(settings: GitHubSettings, token: string, fetchImpl?: SyncWithGitHubOptions["fetch"]): GitHubV7Remote { return new GitHubV7Remote({ owner: settings.owner, repo: settings.repo, branch: branch(settings), token, apiBaseUrl: settings.apiBaseUrl, vaultId: vaultId(settings), ...(fetchImpl ? { fetch: fetchImpl } : {}) }); }

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function descriptorPath(prefix: string, digest: string): string { return `${prefix}${digest}.json`; }

async function loadHeadCache(settings: GitHubSettings): Promise<SyncV7HeadCache | undefined> {
  return (await dbV6.syncMeta.get(cacheKey(settings, "head")))?.value as SyncV7HeadCache | undefined;
}

async function saveHeadCache(settings: GitHubSettings, cache: SyncV7HeadCache): Promise<void> {
  await dbV6.syncMeta.put({ key: cacheKey(settings, "head"), value: cache, updatedAt: new Date().toISOString() });
}

async function saveRemoteCache(settings: GitHubSettings, checkpoint: SyncCheckpointV6, head: SyncV7HeadCache): Promise<void> {
  await dbV6.syncMeta.put({ key: cacheKey(settings, "checkpoint"), value: { cachedAt: new Date().toISOString(), checkpoint, head }, updatedAt: new Date().toISOString() });
}

export type RemoteCacheV7 = { cachedAt: string; checkpoint: SyncCheckpointV6; head: SyncV7HeadCache };

async function loadRemoteCache(settings: GitHubSettings): Promise<RemoteCacheV7 | undefined> {
  return (await dbV6.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as RemoteCacheV7 | undefined;
}

/** A device that has not reported a watermark for this long stops blocking
 *  tombstone GC (Riak-style reaping): a phone lost for 90+ days must not pin
 *  every tombstone forever.  Its un-pulled deletions simply win — the same
 *  resolution rule the compareClock tie-break already applies elsewhere. */
export const SYNC_V7_DEVICE_RETIRE_DAYS = 90;

/** Causally-stable tombstone GC (Yorkie minVersionVector / Riak reaping):
 *  a tombstone is reclaimable once every non-retired known device has reported
 *  a watermark for the deleting device at or beyond the tombstone's deletion
 *  sequence.  Key soundness insight: a pending change-set referencing entity X
 *  can only be created while X exists locally — i.e. BEFORE that device pulled
 *  the deletion — so once its watermark passes the deletion sequence it can no
 *  longer produce a resurrection.  Devices that never reported stay
 *  conservative (block reclamation); the self device just performed the
 *  install and counts as confirmed.  Tombstones without a sequence anchor
 *  (legacy data predating H1) are always kept. */
export function reclaimableTombstonesV7(
  tombstones: readonly TombstoneV6[],
  input: { devices: Record<string, SyncV7DeviceWatermark>; headCursors: Record<string, number>; selfDeviceId: string; now?: string },
): { keep: TombstoneV6[]; dropped: number } {
  const now = input.now ?? new Date().toISOString();
  const retireCutoff = Date.parse(now) - SYNC_V7_DEVICE_RETIRE_DAYS * 86_400_000;
  const decisionSet = [...new Set([...Object.keys(input.devices), ...Object.keys(input.headCursors)])].filter((device) => {
    if (device === input.selfDeviceId) return false;
    const watermark = input.devices[device];
    if (!watermark) return true; // never reported: unconfirmed (blocks reclamation)
    return Date.parse(watermark.syncedAt) >= retireCutoff; // retired devices stop blocking
  });
  const keep: TombstoneV6[] = [];
  let dropped = 0;
  for (const tombstone of tombstones) {
    if (typeof tombstone.sequence !== "number" || !Number.isFinite(tombstone.sequence)) { keep.push(tombstone); continue; }
    const confirmed = decisionSet.every((device) => (input.devices[device]?.cursors[tombstone.deviceId] ?? -1) >= tombstone.sequence);
    if (confirmed) dropped += 1;
    else keep.push(tombstone);
  }
  return { keep, dropped };
}

/** Best-effort device watermark publish (H2): report this device's installed
 *  cursors on the head so tombstone GC can prove causal stability.  Writes
 *  only when the watermark actually advanced (idle syncs stay zero-write); a
 *  CAS conflict skips silently — the next sync republishes. */
async function publishDeviceWatermark(client: GitHubV7Remote, settings: GitHubSettings, deviceId: string, cursors: Record<string, number>): Promise<void> {
  const read = await client.readHead();
  if (!read.initialized) return;
  const previous = read.head.devices?.[deviceId];
  const advanced = Object.entries(cursors).some(([device, sequence]) => sequence > (previous?.cursors[device] ?? -1));
  if (!advanced) return;
  const nextHead: SyncHeadV7 = { ...read.head, devices: { ...(read.head.devices ?? {}), [deviceId]: { cursors, syncedAt: new Date().toISOString() } } };
  const result = await client.putHead(nextHead, read.cache); // conflict → throw → caller swallows
  if (result.ok) await saveHeadCache(settings, { head: nextHead }); // 让本地缓存 head 带上水位（面板「上次同步/设备」据此展示）
}

/** Content fingerprint of what the installed projection covers: the checkpoint
 *  identity plus the per-device cursor watermark at install time.  Deliberately
 *  excludes head.generatedAt and segment digests — a coalesce re-pack or a peer's
 *  timestamp bump does not change the installed tables, so it must not trigger a
 *  full re-install (the old headVersion did exactly that). */
export function installFingerprint(cache: SyncV7HeadCache): string {
  const head = cache.head;
  const cursors = Object.keys(head.cursors).sort().map((device) => `${device}=${head.cursors[device]}`).join(",");
  return `${head.checkpoint?.sha256 ?? "none"}:${cursors}`;
}

/** Pure install decision (unit-testable): reinstall only when the checkpoint
 *  identity or cursor watermark moved, or when there are unseen remote changes /
 *  blocked rebase outcomes that must be persisted. */
export function projectionNeedsInstall(installedFingerprint: string | undefined, cache: SyncV7HeadCache, unseenCount: number, blockedCount: number): boolean {
  return installedFingerprint !== installFingerprint(cache) || unseenCount > 0 || blockedCount > 0;
}

async function loadInstalledHead(settings: GitHubSettings): Promise<string | undefined> {
  return (await dbV6.syncMeta.get(cacheKey(settings, "installed-head")))?.value as string | undefined;
}

async function saveInstalledHead(settings: GitHubSettings, cache: SyncV7HeadCache): Promise<void> {
  await dbV6.syncMeta.put({ key: cacheKey(settings, "installed-head"), value: installFingerprint(cache), updatedAt: new Date().toISOString() });
}

/**
 * The highest remote `localSequence` per device that this client has already
 * installed into its projection. Used to dedup downloaded changes by cursor
 * instead of by committed-record id, so committed records can be garbage
 * collected without re-pulling/re-counting them.
 */
async function loadInstalledCursors(settings: GitHubSettings): Promise<Record<string, number>> {
  return ((await dbV6.syncMeta.get(cacheKey(settings, "installed-cursors")))?.value ?? {}) as Record<string, number>;
}

async function saveInstalledCursors(settings: GitHubSettings, cursors: Record<string, number>): Promise<void> {
  await dbV6.syncMeta.put({ key: cacheKey(settings, "installed-cursors"), value: cursors, updatedAt: new Date().toISOString() });
}

/** Keep at most this many committed change-sets for the "已同步" history. */
const SYNC_V7_COMMITTED_KEEP_RECENT = 500;

/**
 * Re-pack the hot window into fewer segments once this many have accumulated,
 * even when the byte compaction threshold (4 MiB) has not been reached. Frequent
 * small syncs otherwise leave many tiny segments that a fresh device must fetch
 * one by one. Events are unchanged (same ids/digests); only their grouping does.
 */
const SYNC_V7_COALESCE_SEGMENT_THRESHOLD = 24;
/**
 * Segments at least this large are LEFT UNTOUCHED by coalescing. A near-full
 * segment (≥ half the 1 MiB per-segment ceiling) can absorb little more, so
 * re-packing it would just download + re-upload ~1 MiB and let paginate split it
 * straight back out — pure waste. Only the smaller segments trailing behind the
 * last large one get merged.
 */
const SYNC_V7_COALESCE_LEAVE_BYTES = Math.floor(SYNC_V7_MAX_SEGMENT_BYTES / 2);

/**
 * Garbage-collect committed change-sets whose `localSequence` has been absorbed
 * by the installed cursor watermark, keeping only the most recent `keepRecent`
 * for the sync-drawer history. Unabsorbed committed records are always kept.
 */
async function pruneCommittedChangeSets(cursors: Record<string, number>, keepRecent = SYNC_V7_COMMITTED_KEEP_RECENT): Promise<void> {
  const committed = await listChangeSetsV7(["committed"]);
  const absorbed = committed.filter((record) => (cursors[record.deviceId] ?? 0) >= record.localSequence);
  if (absorbed.length <= keepRecent) return;
  const excess = absorbed
    .sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? "") || b.localSequence - a.localSequence || b.id.localeCompare(a.id))
    .slice(keepRecent);
  if (excess.length) await dbV6.changeSets.bulkDelete(excess.map((record) => record.id));
}

/**
 * Coalesce the hot window: merge only the trailing run of SMALL segments into
 * fewer fuller segments and publish a replacement head. Large segments (≥
 * SYNC_V7_COALESCE_LEAVE_BYTES) are left in place — they are already near-full,
 * so re-packing them is pure waste. Only the small segments after the last large
 * one are touched, which keeps replay order intact: the kept prefix stays at its
 * original generation and the merged suffix gets the next generation, so it
 * replays last exactly as before. Events (including offload stubs) are passed
 * through untouched, so referenced immutable objects stay valid. Returns the new
 * head cache when a replacement was published, otherwise null (below threshold,
 * nothing small to merge, no improvement, or a concurrent publish won the CAS).
 */
async function maybeCoalesceHotWindow(client: GitHubV7Remote, cache: SyncV7HeadCache, callback?: SyncProgressCallback): Promise<SyncV7HeadCache | null> {
  const head = cache.head;
  if (head.segments.length < SYNC_V7_COALESCE_SEGMENT_THRESHOLD) return null;
  const ordered = [...head.segments].sort((a, b) => a.generation - b.generation || a.ordinal - b.ordinal);
  // The kept prefix runs up to and including the last large segment; only the
  // small segments trailing after it are worth merging.
  let suffixStart = ordered.length;
  while (suffixStart > 0 && ordered[suffixStart - 1].size < SYNC_V7_COALESCE_LEAVE_BYTES) suffixStart -= 1;
  const keep = ordered.slice(0, suffixStart);
  const smalls = ordered.slice(suffixStart);
  if (smalls.length < 2) return null;
  report(callback, "compact", `正在合并 ${smalls.length} 个小分段（保留 ${keep.length} 个大分段）`, 94, 98);
  const events: Array<Record<string, unknown>> = [];
  for (const descriptor of smalls) {
    const segment = decodeSyncV7Segment<Record<string, unknown>>(await client.readBlob(descriptor), { vaultId: head.vaultId, generation: descriptor.generation, ordinal: descriptor.ordinal });
    events.push(...segment.events);
  }
  const pages = paginateSyncV7Events(events);
  if (pages.length >= smalls.length) return null;
  const generation = head.generation + 1;
  const now = new Date().toISOString();
  const metadata = { vaultId: head.vaultId, createdAt: now, producer: "exam-study-app" };
  // Head cursors keep the FULL watermark; each coalesced page records its own
  // real coverage (cursorsFor of its events), so a peer can prove the page's
  // events are already folded into its cached checkpoint and skip re-downloading
  // after a re-pack — the previous full-watermark copy made that undecidable.
  const cursors = { ...head.cursors };
  const segmentFiles: SyncV7PublicationFile[] = [];
  const mergedSegments: SyncV7SegmentDescriptor[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const ordinal = index;
    const pageCursors = cursorsFor(pages[index].events as Array<{ deviceId: string; localSequence: number }>);
    const segmentBytes = encodeSyncV7Segment({ formatVersion: 7 as const, vaultId: head.vaultId, generation, ordinal, metadata, cursors: pageCursors, events: pages[index].events });
    const digest = await sha256(segmentBytes);
    const path = descriptorPath(SYNC_V7_SEGMENT_PREFIX, digest);
    const base = await uploadedDescriptor(client, path, segmentBytes, "segment");
    mergedSegments.push({ ...base, generation, ordinal, count: pages[index].events.length, cursors: pageCursors, metadata });
    segmentFiles.push({ path, bytes: segmentBytes, kind: "segment", uploaded: true });
  }
  const nextHead: SyncHeadV7 = { ...head, generatedAt: now, generation, segments: [...keep, ...mergedSegments], cursors };
  const plan = createSyncV7PublicationPlan({ expectedHead: head, expectedHeadSha: cache.blobSha, head: nextHead, segments: segmentFiles });
  const published = await client.publish(plan);
  if (!published.ok) return null;
  return published.cache;
}

async function saveQueueBase(projection: ChangeSetProjectionV7): Promise<void> {
  await dbV6.syncMeta.put({ key: "v7:queue-base", value: projection, updatedAt: new Date().toISOString() });
}

async function projectionFromCheckpoint(checkpoint: SyncCheckpointV6): Promise<ChangeSetProjectionV7> {
  return { ...checkpoint.state, memberships: checkpoint.state.memberships, imageAssets: checkpoint.state.imageAssets };
}

async function checkpointFromProjection(
  projection: ChangeSetProjectionV7,
  cursors: Record<string, number>,
  options?: { tombstoneGc?: { devices: Record<string, SyncV7DeviceWatermark>; headCursors: Record<string, number>; selfDeviceId: string; now?: string } },
): Promise<SyncCheckpointV6> {
  // Causally-stable tombstone GC (H3/H4): reclaim tombstones every known
  // device has observed; the compaction checkpoint is the only place old
  // tombstones would otherwise persist forever.
  let tombstones = projection.tombstones;
  if (options?.tombstoneGc) {
    const gc = reclaimableTombstonesV7(tombstones, options.tombstoneGc);
    tombstones = gc.keep;
  }
  // Direct construction: the old spread of createSyncCheckpointV6() read and
  // deep-cloned all 16 tables out of IndexedDB, then discarded every field —
  // up to three wasted full snapshots per sync.
  const checkpoint: SyncCheckpointV6 = {
    formatVersion: 6,
    generatedAt: new Date().toISOString(),
    cursors: { ...cursors },
    state: {
      ...projection,
      tombstones,
      memberships: projection.memberships,
      imageAssets: projection.imageAssets.map((asset) => ({
        id: asset.id,
        mimeType: asset.mimeType,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        remote: asset.remote,
      })),
    },
    counts: {
      banks: projection.banks.length,
      bankFolders: projection.bankFolders.length,
      questions: projection.questions.length,
      memberships: projection.memberships.length,
      imageAssets: projection.imageAssets.length,
      attempts: projection.attempts.length,
      attemptStats: projection.attemptStats.length,
      attemptDailyStats: projection.attemptDailyStats.length,
      notes: projection.notes.length,
      practiceRuns: projection.practiceRuns.length,
      practiceRunStats: projection.practiceRunStats.length,
      questionGroups: projection.questionGroups.length,
      reviewRounds: projection.reviewRounds.length,
      reviewRoundProgress: projection.reviewRoundProgress.length,
      tombstones: tombstones.length,
      totalAttempts: projection.attempts.length,
      totalPracticeRuns: projection.practiceRuns.length,
    },
  };
  return checkpoint;
}

function replayInWireOrder(projection: ChangeSetProjectionV7, changes: readonly ChangeSetV7[], onStep?: (done: number, total: number) => void): ChangeSetProjectionV7 {
  // Strict batch replay: compaction/restore must fail loudly on any bad record,
  // but derived tables recompute + validate once instead of per record.
  return replayChangeSetBatchV7(projection, changes, onStep, { onConflict: "throw" }).projection;
}

// Replay remote (committed) change-sets defensively. A single poisoned record — e.g. a
// committed upsert for an entity already tombstoned and compacted into the checkpoint —
// throws inside the batch applier (rejectTombstoned). Previously that rejected the ENTIRE
// sync, so one such record permanently blocked a device from pulling anything. Skip poison
// records instead: the checkpoint/tombstone state already won the conflict, so dropping the
// conflicting replay is the correct end state. Skipped ids are surfaced (not silent) and the
// records are still marked committed via the cursor watermark, so they won't re-pull forever.
export function replayRemoteResilient(projection: ChangeSetProjectionV7, changes: readonly ChangeSetV7[], onStep?: (done: number, total: number) => void): { projection: ChangeSetProjectionV7; skipped: string[] } {
  return replayChangeSetBatchV7(projection, changes, onStep);
}

async function installProjection(projection: ChangeSetProjectionV7): Promise<void> {
  // Restore directly from the projection state — building a full checkpoint
  // envelope (with counts/cursors) just to unwrap it was pure overhead.
  await restoreV6Checkpoint({
    ...projection,
    memberships: projection.memberships,
    imageAssets: projection.imageAssets.map((asset) => ({
      id: asset.id,
      mimeType: asset.mimeType,
      size: asset.size,
      width: asset.width,
      height: asset.height,
      remote: asset.remote,
    })),
  });
}

function descriptorEqual(a: SyncV7Descriptor, b: SyncV7Descriptor): boolean {
  return a.path === b.path && a.sha256 === b.sha256 && a.size === b.size;
}

/** Hot-window segments download concurrently (bounded): results are collected
 *  by original index, so the replay order below stays the generation/ordinal
 *  wire order regardless of completion order. */
export const SYNC_V7_DOWNLOAD_CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!, index);
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}

/** Exported for the install-fingerprint suite: drives the tiered cache-reuse
 *  decision directly against a remote head + an arbitrary cached view. */
export async function downloadRemoteV7(client: GitHubV7Remote, head: SyncHeadV7, cached?: RemoteCacheV7, onStep?: (fraction: number, label: string) => void): Promise<{ checkpoint: SyncCheckpointV6; changes: ChangeSetV7[]; reusedCache: boolean }> {
  if (!head.checkpoint) throw new Error("v7 远端缺少初始化检查点。");
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
  let checkpoint: SyncCheckpointV6;
  if (canReuse) {
    checkpoint = cached!.checkpoint;
  } else {
    const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    const sizeLabel = head.checkpoint.storedSize !== undefined
      ? `实际 ${megabytes(head.checkpoint.storedSize)} / 解压后 ${megabytes(head.checkpoint.size)}`
      : `解压后 ${megabytes(head.checkpoint.size)}`;
    onStep?.(0.01, `正在下载检查点（${sizeLabel}）`);
    checkpoint = parseSyncCheckpointV6(await client.readBlob(head.checkpoint));
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
  return { checkpoint, changes, reusedCache: canReuse };
}

async function uploadedDescriptor(client: GitHubV7Remote, path: string, bytes: Uint8Array, kind: "checkpoint" | "segment"): Promise<SyncV7Descriptor> {
  const uploaded = await client.putImmutable({ path, bytes, kind });
  // storedSize 让读端在下载前就知道实际传输量（descriptor.size 按设计是解压后字节）。
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize };
}

/** Per-device max localSequence over the given events — the true coverage
 *  watermark of a page, as opposed to the full head watermark. */
function cursorsFor(changes: ReadonlyArray<{ deviceId: string; localSequence: number }>): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const change of changes) cursors[change.deviceId] = Math.max(cursors[change.deviceId] ?? 0, change.localSequence);
  return cursors;
}

async function initialize(settings: GitHubSettings, token: string, callback?: SyncProgressCallback, fetchImpl?: SyncWithGitHubOptions["fetch"]): Promise<SyncV7HeadCache> {
  const client = remote(settings, token, fetchImpl);
  const existing = await client.readHead();
  if (existing.initialized) return existing.cache;
  report(callback, "prepare", "正在初始化 v7 热窗口", 4, 6);
  const checkpoint = await createSyncCheckpointV6();
  const bytes = encodeSyncCheckpointV6(checkpoint);
  const digest = await sha256(bytes);
  const path = descriptorPath(SYNC_V7_CHECKPOINT_PREFIX, digest);
  const descriptor: SyncV7Descriptor = { ...(await uploadedDescriptor(client, path, bytes, "checkpoint")), generation: 0 };
  const now = new Date().toISOString();
  const head: SyncHeadV7 = { formatVersion: 7, vaultId: vaultId(settings), generatedAt: now, generation: 0, metadata: { vaultId: vaultId(settings), producer: "exam-study-app" }, checkpoint: descriptor, segments: [], cursors: {} };
  const committed = await client.putHead(head);
  if (!committed.ok) {
    const winner = await client.readHead();
    if (!winner.initialized) throw new Error("v7 初始化冲突，请重试。");
    return winner.cache;
  }
  // B4: a GitHub-compatible layer may return ok on an un-CAS'd PUT and let the
  // last writer silently win, overwriting a concurrent bootstrap. Re-read the
  // head to confirm ownership; if another device actually won, adopt its cache
  // instead of marking our pending changes committed against a head we don't own.
  const confirmed = await client.readHead();
  if (!confirmed.initialized) throw new Error("v7 初始化冲突，请重试。");
  if (confirmed.cache.blobSha !== committed.blobSha) return confirmed.cache;
  await saveHeadCache(settings, committed.cache);
  await saveRemoteCache(settings, checkpoint, committed.cache);
  const covered = await listChangeSetsV7(["pending", "blocked"]);
  if (covered.length) await dbV6.changeSets.bulkPut(covered.map((record) => ({ ...record, state: "committed" as const, committedAt: now })));
  await saveQueueBase(await projectionFromCheckpoint(checkpoint));
  await saveInstalledHead(settings, committed.cache);
  return committed.cache;
}

async function syncWithGitHubInternal(settings: GitHubSettings, token: string, callback?: SyncProgressCallback, options?: SyncWithGitHubOptions) {
  const client = remote(settings, token, options?.fetch);
  const progress = monotonicProgress(callback);
  report(progress, "prepare", "正在连接远端", 2, 6);
  let read = await client.readHead(await loadHeadCache(settings));
  if (!read.initialized) { await initialize(settings, token, callback, options?.fetch); read = await client.readHead(); }
  if (!read.initialized) throw new Error("无法初始化 v7 远端。");
  let installedHead = await loadInstalledHead(settings);
  let pulled = 0;
  let receivedSnapshot: SyncCheckpointV6["counts"] | undefined;
  // Band layout is decided once per run from whether there is anything to push,
  // so the bar spans 0–100 over the phases this run will actually enter.
  const bands = syncBands((await listChangeSetsV7(["pending"])).length > 0);
  for (let retry = 0; retry < 4; retry += 1) {
    const cached = await loadRemoteCache(settings);
    report(progress, "download", cached ? "正在检查 v7 热窗口增量" : "正在下载远端完整数据", bandPercent(bands.download, cached ? 0.05 : 0.01), bands.download[1]);
    let downloadSteps = 0;
    const downloaded = await downloadRemoteV7(client, read.head, cached, (fraction, label) => {
      downloadSteps += 1;
      report(progress, "download", label, bandPercent(bands.download, fraction), bands.download[1]);
    });
    if (!downloadSteps) report(progress, "download", "热窗口没有新数据", bands.download[1], bands.download[1]);
    const remoteReplay = replayRemoteResilient(await projectionFromCheckpoint(downloaded.checkpoint), downloaded.changes, (done, total) => report(progress, "merge", `正在回放远端变更（${done}/${total}）`, bandPercent(bands.merge, total ? done / total / 2 : 1), bands.merge[1]));
    const remoteProjection = remoteReplay.projection;
    if (remoteReplay.skipped.length) report(progress, "merge", `已跳过 ${remoteReplay.skipped.length} 组与已删数据冲突的远端变更`, bandPercent(bands.merge, 0.5), bands.merge[1]);
    const remoteById = new Map(downloaded.changes.map((change) => [change.id, change]));
    const remoteCursors = read.head.cursors;
    const interruptedClaims = (await listChangeSetsV7(["claimed"])).map((record) => {
      const remoteChange = remoteById.get(record.id);
      // B2: a claimed record whose id already exists remotely with a DIFFERENT
      // digest means the local locked version is stale (crashed mid-publish, then
      // the same id was re-edited). Previously this threw and froze ALL sync for
      // the device. Downgrade to blocked so unrelated remote data still pulls.
      if (remoteChange && remoteChange.digest !== record.digest) {
        return { ...record, state: "blocked" as const, blockedReason: "远端已存在同 id 但内容不同的变更集，本地锁定版本已过期。", claimId: undefined, claimedAt: undefined };
      }
      const coveredByRemote = Boolean(remoteChange) || (remoteCursors[record.deviceId] ?? 0) >= record.localSequence;
      return coveredByRemote
        ? { ...record, state: "committed" as const, committedAt: new Date().toISOString(), claimId: undefined, claimedAt: undefined }
        : { ...record, state: "pending" as const, claimId: undefined, claimedAt: undefined };
    });
    if (interruptedClaims.length) await dbV6.changeSets.bulkPut(interruptedClaims);
    // Dedup by cursor watermark instead of by committed-record id: a change whose
    // localSequence the installed cursor already covers has been applied before,
    // even if its local committed record was garbage-collected.
    const installedCursors = await loadInstalledCursors(settings);
    const unseen = downloaded.changes.filter((change) => change.localSequence > (installedCursors[change.deviceId] ?? 0));
    const localPending = await listChangeSetsV7(["pending"]);
    let rebasedProjection = remoteProjection;
    const blocked: ChangeSetQueueRecordV7[] = [];
    const localEvery = Math.max(1, Math.floor(localPending.length / 12));
    for (let localIndex = 0; localIndex < localPending.length; localIndex += 1) {
      const record = localPending[localIndex];
      try {
        rebasedProjection = reduceChangeSetV7(rebasedProjection, record);
        if ((localIndex + 1) % localEvery === 0 || localIndex + 1 === localPending.length) {
          report(progress, "merge", `正在归并本机待上传变更（${localIndex + 1}/${localPending.length}）`, bandPercent(bands.merge, 0.5 + 0.5 * (localIndex + 1) / localPending.length), bands.merge[1]);
        }
      } catch (error) {
        blocked.push({
          ...record,
          state: "blocked",
          blockedReason: error instanceof Error ? error.message : "该操作无法应用到最新远端数据。",
        });
      }
    }
    const firstProjectionInstall = !installedHead;
    const needsInstall = projectionNeedsInstall(installedHead, read.cache, unseen.length, blocked.length);
    if (needsInstall) {
      report(progress, "merge", `正在写入 ${rebasedProjection.questions.length.toLocaleString("zh-CN")} 道题与 ${rebasedProjection.attempts.length.toLocaleString("zh-CN")} 条作答到本机`, bandPercent(bands.install, 0.3), bands.install[1]);
      await installProjection(rebasedProjection);
      report(progress, "merge", "本机数据已更新", bandPercent(bands.install, 1), bands.install[1]);
      installedHead = installFingerprint(read.cache);
      await saveInstalledHead(settings, read.cache);
      if (firstProjectionInstall || !downloaded.reusedCache) receivedSnapshot = downloaded.checkpoint.counts;
      if (blocked.length) await dbV6.changeSets.bulkPut(blocked);
      await dbV6.changeSets.bulkPut(unseen.map((change) => ({ ...change, state: "committed" as const, committedAt: new Date().toISOString() })));
      pulled += unseen.length;
    }
    if (!needsInstall && !unseen.length) report(progress, "merge", "远端与本机已一致，无需合并", bands.merge[1], bands.merge[1]);
    const claim = await claimPendingChangeSetsV7();
    if (!claim.records.length) {
      report(progress, "cache", "正在更新本机缓存", bandPercent(bands.cache, 0.4), bands.cache[1]);
      await saveHeadCache(settings, read.cache);
      await saveRemoteCache(settings, await checkpointFromProjection(remoteProjection, read.head.cursors), read.cache);
      await saveQueueBase(remoteProjection);
      const remaining = (await listChangeSetsV7(["blocked"])).length;
      report(progress, "complete", remaining ? `同步完成，${remaining} 组操作需要处理` : "云端和本机已经一致", 100);
      await saveInstalledHead(settings, read.cache);
      await saveInstalledCursors(settings, read.head.cursors);
      // H2：游标前进才写设备水位（空闲同步零 head 写入）；冲突静默跳过。
      // 必须先于 prune：prune 清空队列会让同步页的 changeSets 查询触发面板刷新，
      // 此时本地 head 缓存必须已带上最新水位/代数，否则面板读到旧缓存而不过期。
      try { await publishDeviceWatermark(client, settings, getV6DeviceId(), read.head.cursors); } catch { /* best-effort */ }
      await pruneCommittedChangeSets(read.head.cursors);
      return { pulled, pushed: 0, remaining, deferred: 0, formatVersion: 7 as const, compacted: false, coalesced: false, migrated: false, receivedSnapshot };
    }
    try {
      report(progress, "upload", `正在上传 ${claim.records.length} 组变更`, bandPercent(bands.upload!, 0.02), bandPercent(bands.upload!, 0.12));
      const generation = read.head.generation + 1;
      const baseOrdinal = read.head.segments.filter((item) => item.generation === generation).length;
      const now = new Date().toISOString();
      const events = claim.records.map((record) => ({ formatVersion: record.formatVersion, id: record.id, deviceId: record.deviceId, localSequence: record.localSequence, createdAt: record.createdAt, kind: record.kind, mutations: record.mutations, entityRefs: record.entityRefs, payloadRefs: record.payloadRefs, digest: record.digest }));
      const aggregateCursors = cursorsFor(claim.records);
      // A single change-set (a large import, a big practice run) can exceed the
      // 256 KiB inline-event ceiling. Offload any oversized body to a
      // content-addressed immutable object and leave a thin stub in its place;
      // the object files are published alongside the segments in the same plan.
      report(progress, "upload", `正在整理 ${events.length} 组变更`, bandPercent(bands.upload!, 0.1), bandPercent(bands.upload!, 0.2));
      const offloaded = await offloadSyncV7Events(events as Record<string, unknown>[]);
      if (offloaded.objects.length) report(progress, "upload", `已卸载 ${offloaded.objects.length} 个大对象`, bandPercent(bands.upload!, 0.2), bandPercent(bands.upload!, 0.3));
      const objectFiles: SyncV7PublicationFile[] = offloaded.objects;
      // Paginate the (now stub-slender) events into one or more 1 MiB segments
      // that share one generation and publish together.
      const pages = paginateSyncV7Events(offloaded.events);
      // Decide compaction from the PROJECTED byte total (existing + new) BEFORE
      // uploading or merging. Previously the merge guard threw at > 4 MiB before
      // compaction could run, so an overflow push failed ("compact explicitly
      // first") instead of snapshotting — the documented "hot window fills →
      // checkpoint" behaviour was unreachable. Under compaction the new events
      // fold into the checkpoint and the hot window clears, so the new segments
      // are neither uploaded nor referenced (no orphaned immutables).
      const existingHotBytes = read.head.segments.reduce((sum, item) => sum + item.size, 0);
      const projectedHotBytes = existingHotBytes + pages.reduce((sum, page) => sum + page.size, 0);
      const compaction = planSyncV7Compaction({ head: read.head, hotBytes: projectedHotBytes });
      const newSegments: SyncV7SegmentDescriptor[] = [];
      const segmentFiles: SyncV7PublicationFile[] = [];
      const vaultId = read.head.vaultId;
      const uploadNewSegments = async (): Promise<void> => {
        for (let index = 0; index < pages.length; index += 1) {
          const page = pages[index];
          const ordinal = baseOrdinal + index;
          const metadata = { vaultId, createdAt: now, producer: "exam-study-app" };
          // Page-local coverage cursors (see maybeCoalesceHotWindow): lets a peer
          // skip this page when its events are below the peer's cached watermark.
          const pageCursors = cursorsFor(page.events as Array<{ deviceId: string; localSequence: number }>);
          const segmentBytes = encodeSyncV7Segment({ formatVersion: 7 as const, vaultId, generation, ordinal, metadata, cursors: pageCursors, events: page.events });
          const segmentDigest = await sha256(segmentBytes);
          const segmentPath = descriptorPath(SYNC_V7_SEGMENT_PREFIX, segmentDigest);
          const segmentBase = await uploadedDescriptor(client, segmentPath, segmentBytes, "segment");
          newSegments.push({ ...segmentBase, generation, ordinal, count: page.events.length, cursors: pageCursors, metadata });
          segmentFiles.push({ path: segmentPath, bytes: segmentBytes, kind: "segment", uploaded: true });
          report(progress, "upload", `正在上传分段（${index + 1}/${pages.length}）`, bandPercent(bands.upload!, 0.3 + 0.4 * (index + 1) / pages.length), bandPercent(bands.upload!, 0.7));
        }
      };
      if (!compaction.required) await uploadNewSegments();
      let checkpointFile: { path: string; bytes: Uint8Array; kind: "checkpoint"; uploaded: true } | undefined;
      let checkpointDescriptor = read.head.checkpoint;
      let nextSegments: SyncV7SegmentDescriptor[];
      if (compaction.required) {
        // B3: compacting replays the claimed records in wire order. A single
        // poisoned record (e.g. an upsert rejected by a tombstone that only
        // surfaces under wire-order rather than createdAt-order replay) would
        // previously abort the whole sync. Fall back to ordinary segment push
        // instead of crashing — the events still publish, just uncompressed.
        let compactionProjection: ChangeSetProjectionV7 | undefined;
        try {
          compactionProjection = replayInWireOrder(remoteProjection, claim.records);
        } catch (error) {
          report(progress, "compact", `压实重放失败，退回分段推送：${error instanceof Error ? error.message : String(error)}`, bandPercent(bands.upload!, 0.45), bandPercent(bands.upload!, 0.7));
        }
        if (!compactionProjection) {
          await uploadNewSegments();
          nextSegments = mergeSyncV7Segments(read.head.segments, newSegments, read.head.vaultId);
        } else {
          report(progress, "compact", read.head.checkpoint ? "热窗口超过 4 MiB，正在生成检查点" : "正在生成初始检查点", bandPercent(bands.upload!, 0.5), bandPercent(bands.upload!, 0.7));
          const checkpoint = await checkpointFromProjection(compactionProjection, { ...read.head.cursors, ...aggregateCursors }, { tombstoneGc: { devices: read.head.devices ?? {}, headCursors: { ...read.head.cursors, ...aggregateCursors }, selfDeviceId: getV6DeviceId() } });
          const bytes = encodeSyncCheckpointV6(checkpoint);
          const digest = await sha256(bytes);
          const path = descriptorPath(SYNC_V7_CHECKPOINT_PREFIX, digest);
          const uploaded = await uploadedDescriptor(client, path, bytes, "checkpoint");
          checkpointFile = { path, bytes, kind: "checkpoint", uploaded: true };
          checkpointDescriptor = { ...uploaded, generation };
          nextSegments = [];
        }
      } else {
        // Safe: projectedHotBytes <= 4 MiB here, so the merge guard cannot trip.
        nextSegments = mergeSyncV7Segments(read.head.segments, newSegments, read.head.vaultId);
      }
      const nextHead: SyncHeadV7 = { ...read.head, generatedAt: now, generation, checkpoint: checkpointDescriptor, segments: nextSegments, cursors: { ...read.head.cursors, ...aggregateCursors } };
      const plan = createSyncV7PublicationPlan({ expectedHead: read.head, expectedHeadSha: read.cache.blobSha, head: nextHead, segments: segmentFiles, ...(objectFiles.length ? { objects: objectFiles } : {}), ...(checkpointFile ? { checkpoint: checkpointFile, compaction } : {}) });
      report(progress, "upload", "正在发布新版索引", bandPercent(bands.upload!, 0.72), bandPercent(bands.upload!, 0.8));
      const committed = await client.publish(plan);
      if (committed.ok) report(progress, "upload", "远端已接受本次变更", bandPercent(bands.upload!, 0.8), bandPercent(bands.upload!, 0.88));
      if (!committed.ok) { await releaseChangeSetClaimV7(claim.claimId); read = await client.readHead(); if (!read.initialized) throw new Error("v7 远端索引丢失。"); continue; }
      await commitChangeSetClaimV7(claim.claimId, new Map(claim.records.map((record) => [record.id, record.digest])));
      // B3: reuse the already-validated rebasedProjection (createdAt order) rather
      // than re-replaying claim.records in wire/claim order — a tombstone-sensitive
      // mutation pair would throw here (rejectTombstoned) after the push already
      // committed, leaving the local queue-base stale and the sync in an error state.
      const committedProjection = rebasedProjection;
      report(progress, "cache", "正在更新本机缓存", bandPercent(bands.upload!, 0.86), bands.cache[1]);
      await saveQueueBase(committedProjection);
      await saveHeadCache(settings, committed.cache);
      await saveRemoteCache(settings, await checkpointFromProjection(committedProjection, nextHead.cursors), committed.cache);
      await saveInstalledHead(settings, committed.cache);
      await saveInstalledCursors(settings, nextHead.cursors);
      // The push is already durable. Coalescing is a best-effort maintenance write
      // (re-packs many small segments into fewer); isolate its failures so a
      // transient error never reverts the committed change-sets above.
      let coalesced = false;
      try {
        const replacement = await maybeCoalesceHotWindow(client, committed.cache, callback);
        if (replacement) {
          await saveHeadCache(settings, replacement);
          await saveInstalledHead(settings, replacement);
          coalesced = true;
        }
      } catch { /* best-effort: a later sync will retry coalescing */ }
      // 同拉取路径：水位（含本地 head 缓存保存）必须先于 prune，否则 changeSets
      // 查询触发的同步页刷新读到旧缓存。
      try { await publishDeviceWatermark(client, settings, getV6DeviceId(), nextHead.cursors); } catch { /* best-effort */ }
      await pruneCommittedChangeSets(nextHead.cursors);
      const remaining = (await listChangeSetsV7(["pending", "blocked"])).length;
      report(progress, "complete", "同步完成", 100);
      return { pulled, pushed: claim.records.length, remaining, deferred: 0, formatVersion: 7 as const, compacted: compaction.required, coalesced, migrated: false, receivedSnapshot };
    } catch (error) { await releaseChangeSetClaimV7(claim.claimId); throw error; }
  }
  throw new Error("远端持续发生并发更新，本地变更已保留，请稍后重试。");
}

// B5: serialize all in-realm callers of syncWithGitHub. Manual sync, auto-sync,
// quick-sync and loadAttemptHistory all funnel here; a module-level mutex makes
// concurrent calls share the single in-flight run instead of racing the claim /
// install / head-CAS steps. (Cross-tab remains a Web Locks follow-up.)
let syncInFlight: ReturnType<typeof syncWithGitHubInternal> | null = null;
export async function syncWithGitHub(settings: GitHubSettings, token: string, callback?: SyncProgressCallback, options?: SyncWithGitHubOptions) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = syncWithGitHubInternal(settings, token, callback, options);
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

export async function restoreFullHistoryFromGitHub(settings: GitHubSettings, token: string, callback?: SyncProgressCallback, options?: SyncWithGitHubOptions) {
  const client = remote(settings, token, options?.fetch);
  const read = await client.readHead();
  if (!read.initialized) throw new Error("远端还没有 v7 数据。");
  // B1: restore wipes the whole local change-set queue. Guard against silently
  // discarding un-synced local edits — surface them so the caller can sync (or
  // explicitly discard) before overwriting from remote.
  const unsynced = await listChangeSetsV7(["pending", "blocked", "claimed"]);
  if (unsynced.length) throw new Error(`还有 ${unsynced.length} 组未同步的本地更改，请先同步或处理后再恢复远程历史。`);
  const bands = { download: [6, 55] as const, merge: [55, 75] as const, install: [75, 92] as const, cache: [92, 98] as const };
  const progress = monotonicProgress(callback);
  report(progress, "download", "正在从远端抓取完整 v7 数据", bandPercent(bands.download, 0.02), bands.download[1]);
  const downloaded = await downloadRemoteV7(client, read.head, undefined, (fraction, label) => report(progress, "download", label, bandPercent(bands.download, fraction), bands.download[1]));
  const projection = replayInWireOrder(await projectionFromCheckpoint(downloaded.checkpoint), downloaded.changes, (done, total) => report(progress, "merge", `正在回放远端变更（${done}/${total}）`, bandPercent(bands.merge, total ? done / total : 1), bands.merge[1]));
  report(progress, "merge", `正在写入 ${projection.questions.length.toLocaleString("zh-CN")} 道题到本机`, bandPercent(bands.install, 0.3), bands.install[1]);
  await installProjection(projection);
  report(progress, "cache", "正在重建本机同步状态", bandPercent(bands.cache, 0.4), bands.cache[1]);
  await dbV6.changeSets.clear();
  await dbV6.changeSets.bulkPut(downloaded.changes.map((change) => ({ ...change, state: "committed" as const, committedAt: new Date().toISOString() })));
  await saveHeadCache(settings, read.cache);
  const checkpoint = await createSyncCheckpointV6();
  await saveRemoteCache(settings, checkpoint, read.cache);
  await saveQueueBase(projection);
  await saveInstalledHead(settings, read.cache);
  await saveInstalledCursors(settings, read.head.cursors);
  await pruneCommittedChangeSets(read.head.cursors);
  report(callback, "complete", "v7 远端恢复完成", 100);
  return { pulled: downloaded.changes.length, formatVersion: 7 as const, counts: checkpoint.counts, deferred: 0, cachedAt: new Date().toISOString(), archivedAttempts: 0, archivedPracticeRuns: 0 };
}

export const restoreFromGitHub = restoreFullHistoryFromGitHub;
export const pullFromGitHub = async (settings: GitHubSettings, token: string, callback?: SyncProgressCallback) => syncWithGitHub(settings, token, callback);
export const initializeGitHubVault = initialize;

export async function getGitHubLogin(token: string): Promise<string> {
  const response = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）`);
  const value = await response.json() as { login?: unknown };
  if (typeof value.login !== "string" || !value.login) throw new Error("GitHub 未返回登录名。");
  return value.login;
}

export async function getLastRemoteCache(settings: GitHubSettings) {
  const value = (await dbV6.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as { cachedAt: string; checkpoint: SyncCheckpointV6 } | undefined;
  return value ? { cachedAt: value.cachedAt, counts: value.checkpoint.counts, formatVersion: 7 as const } : null;
}

export interface SyncHotWindowState {
  /** Immutable segment files currently listed in the mutable head. */
  segmentCount: number;
  /** Aggregate bytes of those segments — the hot-window fill level. */
  hotBytes: number;
  /** Hard cap on hotBytes before compaction folds segments into a checkpoint. */
  hotBytesMax: number;
  /** Monotonic publication generation of the head. */
  generation: number;
  /** Generation at which the current checkpoint snapshot was written (0 = initial). */
  checkpointGeneration: number;
  /** False only before the vault has been initialised. */
  hasCheckpoint: boolean;
  /** Per-segment byte sizes, in replay order. Empty when there are no segments. */
  segmentSizes: number[];
  /** Logical (decompressed) size of the checkpoint snapshot, when one exists. */
  checkpointSize?: number;
  /** Actual stored (compressed) bytes of the checkpoint blob, when the descriptor carries it. */
  checkpointStoredSize?: number;
  /** Change events held in the hot-window segments (sum of per-segment counts). */
  segmentEvents: number;
}

/**
 * Read the locally cached head and summarise the hot-window state (segment
 * count, fill bytes vs the compaction cap, generation). Offline — no network;
 * reflects the head as of this device's last successful sync. Returns null when
 * this device has never synced the vault.
 */
export async function getSyncHotWindowState(settings: GitHubSettings): Promise<SyncHotWindowState | null> {
  const cache = await loadHeadCache(settings);
  if (!cache) return null;
  const head = cache.head;
  return {
    segmentCount: head.segments.length,
    hotBytes: head.segments.reduce((sum, segment) => sum + segment.size, 0),
    hotBytesMax: SYNC_V7_MAX_HOT_BYTES,
    generation: head.generation,
    // The checkpoint descriptor records the generation it was written at.  Legacy
    // heads predate that field; fall back to deriving it from the oldest segment
    // (one below its generation) or the head generation for an empty window.
    checkpointGeneration: head.checkpoint?.generation ?? (head.segments.length ? head.segments[0].generation - 1 : head.generation),
    hasCheckpoint: Boolean(head.checkpoint),
    segmentSizes: head.segments.map((segment) => segment.size),
    ...(head.checkpoint ? { checkpointSize: head.checkpoint.size, ...(head.checkpoint.storedSize !== undefined ? { checkpointStoredSize: head.checkpoint.storedSize } : {}) } : {}),
    segmentEvents: head.segments.reduce((sum, segment) => sum + segment.count, 0),
  };
}

export async function restoreLastRemoteCache(settings: GitHubSettings, callback?: SyncProgressCallback) {
  report(callback, "prepare", "正在检查本地 v7 恢复记录", 4, 8);
  const value = (await dbV6.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as { cachedAt: string; checkpoint: SyncCheckpointV6; head: SyncV7HeadCache } | undefined;
  if (!value) throw new Error("本机还没有可恢复的 v7 记录。");
  report(callback, "merge", `正在恢复 ${value.checkpoint.counts.questions.toLocaleString("zh-CN")} 道题`, 40, 92);
  await restoreV6Checkpoint(value.checkpoint.state);
  await dbV6.changeSets.clear();
  await saveQueueBase(await projectionFromCheckpoint(value.checkpoint));
  await saveHeadCache(settings, value.head);
  await saveInstalledHead(settings, value.head);
  report(callback, "complete", "本地数据恢复完成", 100);
  return { cachedAt: value.cachedAt, counts: value.checkpoint.counts, formatVersion: 7 as const, pulled: 0, deferred: 0 };
}

export async function verifyGitHubVault(settings: GitHubSettings, token: string, options?: SyncWithGitHubOptions) { return (await remote(settings, token, options?.fetch).readHead()).initialized ? 7 as const : 0 as const; }
export async function getSyncStats() { const checkpoint = await createSyncCheckpointV6(); return { ...checkpoint.counts, pendingEvents: (await listChangeSetsV7(["pending", "blocked"])).length }; }
export async function loadAttemptHistory(settings: GitHubSettings, token: string, options: { month?: string; questionId?: string } = {}) { await syncWithGitHub(settings, token); const rows = (await dbV6.attempts.toArray()).filter((attempt) => (!options.questionId || attempt.questionId === options.questionId) && (!options.month || attempt.createdAt.startsWith(options.month))); return { loaded: rows.length, segments: 0 }; }

export type { ChangeSetQueueRecordV7 };

export interface MigrateVaultResult {
  migrated: boolean;
  /** Why no migration happened (migrated: false only). */
  reason?: string;
  /** True when the read-only verification phase completed successfully. */
  verified: boolean;
  /** Legacy tombstones dropped under the all-devices-rebuilt-from-remote premise. */
  droppedTombstones: number;
  hotEvents: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Counts of the verified projection (verification / dry-run only). */
  counts?: SyncCheckpointV6["counts"];
}

/**
 * One-shot remote migration to the compressed storage envelope (Part G).
 *
 * Phase 1 — VERIFY (read-only; any failure aborts with ZERO remote changes):
 * download head + checkpoint + every hot segment, check each object's sha256/
 * size descriptor, verify every event digest, replay the projection and
 * validate referential integrity.
 *
 * Phase 2 — MIGRATE: fold「checkpoint projection + all hot events」into ONE new
 * checkpoint stored through the DEFLATE envelope (a controlled compaction),
 * clear the hot window, CAS-publish the new head, then re-read the published
 * checkpoint and re-verify its digest.  head.json stays plain JSON by design.
 * Old immutable objects are left in place (harmless; content-addressed).
 * Under the「all devices wiped and re-sync from remote」premise every legacy
 * tombstone is dropped (nothing offline can resurrect an entity) and the count
 * reported.  CAS conflicts re-read and retry (≤4); the migration never
 * overwrites a concurrent write.
 *
 * Idempotent: an empty hot window (or an already-folded checkpoint) reports
 * `migrated: false` with a reason and touches nothing.
 */
export async function migrateVaultToCompressed(settings: GitHubSettings, token: string, onProgress?: (label: string) => void, options?: SyncWithGitHubOptions & { verifyOnly?: boolean }): Promise<MigrateVaultResult> {
  const client = remote(settings, token, options?.fetch);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await client.readHead();
    if (!read.initialized) throw new Error("远端还没有 v7 数据，无需迁移。");
    const head = read.head;
    if (!head.checkpoint) throw new Error("远端缺少检查点，无法迁移。");

    // ---- Phase 1: read-only verification ----------------------------------
    onProgress?.(`验证检查点（${(head.checkpoint.size / 1024).toFixed(0)} KiB）`);
    const checkpoint = parseSyncCheckpointV6(await client.readBlob(head.checkpoint));
    const ordered = [...head.segments].sort((a, b) => a.generation - b.generation || a.ordinal - b.ordinal);
    const changes: ChangeSetV7[] = [];
    for (const descriptor of ordered) {
      onProgress?.(`验证热窗口分段 ${descriptor.generation}/${descriptor.ordinal}`);
      const segment = decodeSyncV7Segment<ChangeSetV7>(await client.readBlob(descriptor), { vaultId: head.vaultId, generation: descriptor.generation, ordinal: descriptor.ordinal });
      const resolved = await hydrateSyncV7Events(segment.events, (ref) => client.readImmutableContents(ref.path, { size: ref.size, sha256: ref.sha256 }));
      for (const change of resolved) {
        if (!await verifyChangeSetDigestV7(change)) throw new Error(`远端变更集 ${change.id} 完整性校验失败，迁移中止（远端未改动）。`);
      }
      changes.push(...resolved);
    }
    const replayed = replayRemoteResilient(await projectionFromCheckpoint(checkpoint), changes);
    assertChangeSetProjectionV7(replayed.projection);

    // ---- Verify-only dry run: report and touch nothing ---------------------
    const hotBytes = ordered.reduce((sum, descriptor) => sum + descriptor.size, 0);
    const checkpointBytes0 = head.checkpoint.size;
    const dryRun = (reason: string): MigrateVaultResult => ({
      migrated: false,
      reason,
      verified: true,
      droppedTombstones: replayed.projection.tombstones.length,
      hotEvents: changes.length,
      bytesBefore: checkpointBytes0 + hotBytes,
      bytesAfter: checkpointBytes0 + hotBytes,
      counts: { ...checkpoint.counts, tombstones: replayed.projection.tombstones.length },
    });
    if (options?.verifyOnly) return dryRun("验证通过（只读，未改动远端）");

    // ---- Idempotence: nothing to fold --------------------------------------
    if (!head.segments.length) {
      return { migrated: false, verified: true, reason: "热窗口为空，检查点保持原样（读取端自动兼容新旧格式）", droppedTombstones: 0, hotEvents: 0, bytesBefore: head.checkpoint.size, bytesAfter: head.checkpoint.size };
    }

    // ---- Phase 2: fold into one compressed checkpoint ----------------------
    const bytesBefore = head.checkpoint.size + ordered.reduce((sum, descriptor) => sum + descriptor.size, 0);
    const droppedTombstones = replayed.projection.tombstones.length;
    // 全部设备将从远端重建（本地已清空）→ 存量墓碑无从复活，直接丢弃。
    const compacted = { ...replayed.projection, tombstones: [] as ChangeSetProjectionV7["tombstones"] };
    const generation = head.generation + 1;
    const nextCursors = { ...head.cursors, ...cursorsFor(changes) };
    const newCheckpoint = await checkpointFromProjection(compacted, nextCursors);
    const bytes = encodeSyncCheckpointV6(newCheckpoint);
    const digest = await sha256(bytes);
    const path = descriptorPath(SYNC_V7_CHECKPOINT_PREFIX, digest);
    onProgress?.(`上传压缩检查点（逻辑 ${(bytes.byteLength / 1024).toFixed(0)} KiB）`);
    const uploaded = await uploadedDescriptor(client, path, bytes, "checkpoint");
    const nextHead: SyncHeadV7 = { ...head, generatedAt: new Date().toISOString(), generation, checkpoint: { ...uploaded, generation }, segments: [], cursors: nextCursors };
    const published = await client.putHead(nextHead, read.cache);
    if (!published.ok) {
      onProgress?.("远端索引被并发更新，重新校验后重试");
      continue;
    }
    // 发布后复核：重读新检查点对象，确认 digest 与逻辑字节一致。
    const verifyBytes = await client.readBlob({ ...uploaded, generation });
    if (verifyBytes.byteLength !== bytes.byteLength || await sha256(verifyBytes) !== digest) throw new Error("迁移后复核失败：新检查点读回不一致。");
    return { migrated: true, verified: true, droppedTombstones, hotEvents: changes.length, bytesBefore, bytesAfter: bytes.byteLength };
  }
  throw new Error("远端持续发生并发更新，迁移未执行（远端数据未损坏）。");
}

export interface BackfillStoredSizeResult {
  /** True when the head was re-published with filled storedSize fields. */
  updated: boolean;
  /** Descriptors examined (checkpoint + segments). */
  descriptors: number;
  /** Descriptors that were missing storedSize and got it filled. */
  filled: number;
}

/**
 * One-shot backfill of `storedSize` on legacy descriptors: measure each
 * referenced blob's actual wire bytes (one raw GET per object — the only way
 * to learn it for objects uploaded before the field existed) and CAS-publish
 * an updated head.  Objects already carrying storedSize are not re-measured;
 * a fully annotated head is a no-op with zero writes.  CAS conflicts re-read
 * and retry (≤4); concurrent writers are never overwritten.
 */
export async function backfillVaultStoredSizes(settings: GitHubSettings, token: string, onProgress?: (label: string) => void, options?: SyncWithGitHubOptions): Promise<BackfillStoredSizeResult> {
  const client = remote(settings, token, options?.fetch);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await client.readHead();
    if (!read.initialized) throw new Error("远端还没有 v7 数据，无需补填。");
    const head = read.head;
    const candidates: Array<SyncV7Descriptor | null> = [head.checkpoint, ...head.segments];
    const targets = candidates.filter((descriptor): descriptor is SyncV7Descriptor => descriptor !== null && descriptor.storedSize === undefined);
    if (!targets.length) return { updated: false, descriptors: 1 + head.segments.length, filled: 0 };
    let filled = 0;
    const annotate = async (descriptor: SyncV7Descriptor): Promise<SyncV7Descriptor> => {
      if (descriptor.storedSize !== undefined) return descriptor;
      onProgress?.(`测量 ${descriptor.path} 的实际字节`);
      const storedSize = await client.readBlobWireSize(descriptor.blobSha);
      filled += 1;
      return { ...descriptor, storedSize };
    };
    const checkpoint = await annotate(head.checkpoint!);
    const segments: SyncV7SegmentDescriptor[] = [];
    for (const descriptor of head.segments) segments.push({ ...(await annotate(descriptor)) } as SyncV7SegmentDescriptor);
    const nextHead: SyncHeadV7 = { ...head, generatedAt: new Date().toISOString(), checkpoint, segments };
    const published = await client.putHead(nextHead, read.cache);
    if (!published.ok) {
      onProgress?.("远端索引被并发更新，重读后重试");
      continue;
    }
    return { updated: true, descriptors: 1 + head.segments.length, filled };
  }
  throw new Error("远端持续并发更新，补填未执行（远端数据未损坏）。");
}
