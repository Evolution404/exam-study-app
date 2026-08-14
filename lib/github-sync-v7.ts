import {
  commitChangeSetClaimV7,
  dbV6,
  listChangeSetsV7,
  releaseChangeSetClaimV7,
  claimPendingChangeSetsV7,
  restoreV6Checkpoint,
  type ChangeSetQueueRecordV7,
} from "./db-v6";
import { verifyChangeSetDigestV7, type ChangeSetV7 } from "./change-set-v7";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
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
  type SyncV7PublicationFile,
  type SyncV7SegmentDescriptor,
} from "./sync-v7-head";
import { GitHubV7Remote, type SyncV7HeadCache } from "./github-v7-remote";
import { hydrateSyncV7Events, offloadSyncV7Events } from "./sync-v7-payload";
import type { GitHubSettings } from "./types";

export type SyncProgress = { phase: "prepare" | "download" | "merge" | "upload" | "compact" | "cache" | "history" | "complete"; label: string; percent: number };
export type SyncProgressCallback = (progress: SyncProgress) => void;

const CACHE_PREFIX = "v7:sync:";

function report(callback: SyncProgressCallback | undefined, phase: SyncProgress["phase"], label: string, percent: number): void {
  callback?.({ phase, label, percent: Math.max(0, Math.min(100, Math.round(percent))) });
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

type RemoteCacheV7 = { cachedAt: string; checkpoint: SyncCheckpointV6; head: SyncV7HeadCache };

async function loadRemoteCache(settings: GitHubSettings): Promise<RemoteCacheV7 | undefined> {
  return (await dbV6.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as RemoteCacheV7 | undefined;
}

function headVersion(cache: SyncV7HeadCache): string {
  const head = cache.head;
  return cache.blobSha ?? `${head.generatedAt}:${head.checkpoint?.sha256 ?? "none"}:${head.segments.map((item) => item.sha256).join(":")}`;
}

async function loadInstalledHead(settings: GitHubSettings): Promise<string | undefined> {
  return (await dbV6.syncMeta.get(cacheKey(settings, "installed-head")))?.value as string | undefined;
}

async function saveInstalledHead(settings: GitHubSettings, cache: SyncV7HeadCache): Promise<void> {
  await dbV6.syncMeta.put({ key: cacheKey(settings, "installed-head"), value: headVersion(cache), updatedAt: new Date().toISOString() });
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
  report(callback, "compact", `正在合并 ${smalls.length} 个小分段（保留 ${keep.length} 个大分段）`, 90);
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
  const cursors = { ...head.cursors };
  const segmentFiles: SyncV7PublicationFile[] = [];
  const mergedSegments: SyncV7SegmentDescriptor[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const ordinal = index;
    const segmentBytes = encodeSyncV7Segment({ formatVersion: 7 as const, vaultId: head.vaultId, generation, ordinal, metadata, cursors, events: pages[index].events });
    const digest = await sha256(segmentBytes);
    const path = descriptorPath(SYNC_V7_SEGMENT_PREFIX, digest);
    const base = await uploadedDescriptor(client, path, segmentBytes, "segment");
    mergedSegments.push({ ...base, generation, ordinal, count: pages[index].events.length, cursors, metadata });
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
): Promise<SyncCheckpointV6> {
  const checkpoint: SyncCheckpointV6 = {
    ...(await createSyncCheckpointV6()),
    generatedAt: new Date().toISOString(),
    cursors: { ...cursors },
    state: {
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
    },
  };
  checkpoint.counts = {
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
    tombstones: projection.tombstones.length,
    totalAttempts: projection.attempts.length,
    totalPracticeRuns: projection.practiceRuns.length,
  };
  return checkpoint;
}

function replayInWireOrder(projection: ChangeSetProjectionV7, changes: readonly ChangeSetV7[]): ChangeSetProjectionV7 {
  let next = projection;
  for (const change of changes) next = reduceChangeSetV7(next, change);
  return next;
}

// Replay remote (committed) change-sets defensively. A single poisoned record — e.g. a
// committed upsert for an entity already tombstoned and compacted into the checkpoint —
// throws inside reduceChangeSetV7 (rejectTombstoned). Previously that rejected the ENTIRE
// sync, so one such record permanently blocked a device from pulling anything. Skip poison
// records instead: the checkpoint/tombstone state already won the conflict, so dropping the
// conflicting replay is the correct end state. Skipped ids are surfaced (not silent) and the
// records are still marked committed via the cursor watermark, so they won't re-pull forever.
export function replayRemoteResilient(projection: ChangeSetProjectionV7, changes: readonly ChangeSetV7[]): { projection: ChangeSetProjectionV7; skipped: string[] } {
  let next = projection;
  const skipped: string[] = [];
  for (const change of changes) {
    try {
      next = reduceChangeSetV7(next, change);
    } catch {
      skipped.push(change.id);
    }
  }
  return { projection: next, skipped };
}

async function installProjection(projection: ChangeSetProjectionV7): Promise<void> {
  const checkpoint = await checkpointFromProjection(projection, {});
  await restoreV6Checkpoint(checkpoint.state);
}

function descriptorEqual(a: SyncV7Descriptor, b: SyncV7Descriptor): boolean {
  return a.path === b.path && a.sha256 === b.sha256 && a.size === b.size;
}

async function downloadRemote(client: GitHubV7Remote, head: SyncHeadV7, cached?: RemoteCacheV7): Promise<{ checkpoint: SyncCheckpointV6; changes: ChangeSetV7[]; reusedCache: boolean }> {
  if (!head.checkpoint) throw new Error("v7 远端缺少初始化检查点。");
  const cachedHead = cached?.head.head;
  const canReuse = Boolean(cached && cachedHead?.checkpoint && descriptorEqual(cachedHead.checkpoint, head.checkpoint)
    && cachedHead.segments.every((oldItem) => head.segments.some((item) => descriptorEqual(oldItem, item))));
  const checkpoint = canReuse ? cached!.checkpoint : parseSyncCheckpointV6(await client.readBlob(head.checkpoint));
  const cachedPaths = new Set(canReuse ? cachedHead!.segments.map((item) => item.path) : []);
  const changes: ChangeSetV7[] = [];
  for (const descriptor of [...head.segments].sort((a, b) => a.generation - b.generation || a.ordinal - b.ordinal)) {
    if (cachedPaths.has(descriptor.path)) continue;
    const segment = decodeSyncV7Segment<ChangeSetV7>(await client.readBlob(descriptor), { vaultId: head.vaultId, generation: descriptor.generation, ordinal: descriptor.ordinal });
    // Offloaded events arrive as thin stubs; resolve their bodies to full
    // change-sets before the integrity check + projection, so the reducer and
    // the local queue only ever see complete records.
    const resolved = await hydrateSyncV7Events(segment.events, (ref) => client.readImmutableContents(ref.path, { size: ref.size, sha256: ref.sha256 }));
    for (const change of resolved) {
      if (!await verifyChangeSetDigestV7(change)) throw new Error(`远端变更集 ${change.id} 完整性校验失败。`);
      changes.push(change);
    }
  }
  return { checkpoint, changes, reusedCache: canReuse };
}

async function uploadedDescriptor(client: GitHubV7Remote, path: string, bytes: Uint8Array, kind: "checkpoint" | "segment"): Promise<SyncV7Descriptor> {
  const uploaded = await client.putImmutable({ path, bytes, kind });
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size };
}

function cursorsFor(changes: readonly ChangeSetV7[]): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const change of changes) cursors[change.deviceId] = Math.max(cursors[change.deviceId] ?? 0, change.localSequence);
  return cursors;
}

async function initialize(settings: GitHubSettings, token: string, callback?: SyncProgressCallback, fetchImpl?: SyncWithGitHubOptions["fetch"]): Promise<SyncV7HeadCache> {
  const client = remote(settings, token, fetchImpl);
  const existing = await client.readHead();
  if (existing.initialized) return existing.cache;
  report(callback, "prepare", "正在初始化 v7 热窗口", 8);
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
  let read = await client.readHead(await loadHeadCache(settings));
  if (!read.initialized) { await initialize(settings, token, callback, options?.fetch); read = await client.readHead(); }
  if (!read.initialized) throw new Error("无法初始化 v7 远端。");
  let installedHead = await loadInstalledHead(settings);
  let pulled = 0;
  let receivedSnapshot: SyncCheckpointV6["counts"] | undefined;
  for (let retry = 0; retry < 4; retry += 1) {
    const cached = await loadRemoteCache(settings);
    report(callback, "download", cached ? "正在检查 v7 热窗口增量" : "正在下载远端完整数据", 18);
    const downloaded = await downloadRemote(client, read.head, cached);
    const remoteReplay = replayRemoteResilient(await projectionFromCheckpoint(downloaded.checkpoint), downloaded.changes);
    const remoteProjection = remoteReplay.projection;
    if (remoteReplay.skipped.length) report(callback, "merge", `已跳过 ${remoteReplay.skipped.length} 组与已删数据冲突的远端变更`, 42);
    report(callback, "merge", `正在合并 ${remoteProjection.questions.length.toLocaleString("zh-CN")} 道题与 ${remoteProjection.attempts.length.toLocaleString("zh-CN")} 条作答`, 42);
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
    for (const record of localPending) {
      try {
        rebasedProjection = reduceChangeSetV7(rebasedProjection, record);
      } catch (error) {
        blocked.push({
          ...record,
          state: "blocked",
          blockedReason: error instanceof Error ? error.message : "该操作无法应用到最新远端数据。",
        });
      }
    }
    const firstProjectionInstall = !installedHead;
    const needsInstall = installedHead !== headVersion(read.cache) || unseen.length > 0 || blocked.length > 0;
    if (needsInstall) {
      await installProjection(rebasedProjection);
      installedHead = headVersion(read.cache);
      await saveInstalledHead(settings, read.cache);
      if (firstProjectionInstall || !downloaded.reusedCache) receivedSnapshot = downloaded.checkpoint.counts;
      if (blocked.length) await dbV6.changeSets.bulkPut(blocked);
      await dbV6.changeSets.bulkPut(unseen.map((change) => ({ ...change, state: "committed" as const, committedAt: new Date().toISOString() })));
      pulled += unseen.length;
    }
    const claim = await claimPendingChangeSetsV7();
    if (!claim.records.length) {
      await saveHeadCache(settings, read.cache);
      await saveRemoteCache(settings, await checkpointFromProjection(remoteProjection, read.head.cursors), read.cache);
      await saveQueueBase(remoteProjection);
      const remaining = (await listChangeSetsV7(["blocked"])).length;
      report(callback, "complete", remaining ? `同步完成，${remaining} 组操作需要处理` : "云端和本机已经一致", 100);
      await saveInstalledHead(settings, read.cache);
      await saveInstalledCursors(settings, read.head.cursors);
      await pruneCommittedChangeSets(read.head.cursors);
      return { pulled, pushed: 0, remaining, deferred: 0, formatVersion: 7 as const, compacted: false, coalesced: false, migrated: false, receivedSnapshot };
    }
    try {
      report(callback, "upload", `正在上传 ${claim.records.length} 组变更`, 62);
      const generation = read.head.generation + 1;
      const baseOrdinal = read.head.segments.filter((item) => item.generation === generation).length;
      const now = new Date().toISOString();
      const events = claim.records.map((record) => ({ formatVersion: record.formatVersion, id: record.id, deviceId: record.deviceId, localSequence: record.localSequence, createdAt: record.createdAt, kind: record.kind, mutations: record.mutations, entityRefs: record.entityRefs, payloadRefs: record.payloadRefs, digest: record.digest }));
      const aggregateCursors = cursorsFor(claim.records);
      // A single change-set (a large import, a big practice run) can exceed the
      // 256 KiB inline-event ceiling. Offload any oversized body to a
      // content-addressed immutable object and leave a thin stub in its place;
      // the object files are published alongside the segments in the same plan.
      const offloaded = await offloadSyncV7Events(events as Record<string, unknown>[]);
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
          const segmentBytes = encodeSyncV7Segment({ formatVersion: 7 as const, vaultId, generation, ordinal, metadata, cursors: aggregateCursors, events: page.events });
          const segmentDigest = await sha256(segmentBytes);
          const segmentPath = descriptorPath(SYNC_V7_SEGMENT_PREFIX, segmentDigest);
          const segmentBase = await uploadedDescriptor(client, segmentPath, segmentBytes, "segment");
          newSegments.push({ ...segmentBase, generation, ordinal, count: page.events.length, cursors: aggregateCursors, metadata });
          segmentFiles.push({ path: segmentPath, bytes: segmentBytes, kind: "segment", uploaded: true });
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
          report(callback, "compact", `压实重放失败，退回分段推送：${error instanceof Error ? error.message : String(error)}`, 76);
        }
        if (!compactionProjection) {
          await uploadNewSegments();
          nextSegments = mergeSyncV7Segments(read.head.segments, newSegments, read.head.vaultId);
        } else {
          report(callback, "compact", read.head.checkpoint ? "热窗口超过 4 MiB，正在生成检查点" : "正在生成初始检查点", 78);
          const checkpoint = await checkpointFromProjection(compactionProjection, { ...read.head.cursors, ...aggregateCursors });
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
      const committed = await client.publish(plan);
      if (!committed.ok) { await releaseChangeSetClaimV7(claim.claimId); read = await client.readHead(); if (!read.initialized) throw new Error("v7 远端索引丢失。"); continue; }
      await commitChangeSetClaimV7(claim.claimId, new Map(claim.records.map((record) => [record.id, record.digest])));
      // B3: reuse the already-validated rebasedProjection (createdAt order) rather
      // than re-replaying claim.records in wire/claim order — a tombstone-sensitive
      // mutation pair would throw here (rejectTombstoned) after the push already
      // committed, leaving the local queue-base stale and the sync in an error state.
      const committedProjection = rebasedProjection;
      await saveQueueBase(committedProjection);
      await saveHeadCache(settings, committed.cache);
      await saveRemoteCache(settings, await checkpointFromProjection(committedProjection, nextHead.cursors), committed.cache);
      await saveInstalledHead(settings, committed.cache);
      await saveInstalledCursors(settings, nextHead.cursors);
      await pruneCommittedChangeSets(nextHead.cursors);
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
      const remaining = (await listChangeSetsV7(["pending", "blocked"])).length;
      report(callback, "complete", "同步完成", 100);
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
  report(callback, "download", "正在从远端抓取完整 v7 数据", 20);
  const downloaded = await downloadRemote(client, read.head);
  const projection = replayInWireOrder(await projectionFromCheckpoint(downloaded.checkpoint), downloaded.changes);
  await installProjection(projection);
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
  };
}

export async function restoreLastRemoteCache(settings: GitHubSettings, callback?: SyncProgressCallback) {
  report(callback, "prepare", "正在检查本地 v7 恢复记录", 8);
  const value = (await dbV6.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as { cachedAt: string; checkpoint: SyncCheckpointV6; head: SyncV7HeadCache } | undefined;
  if (!value) throw new Error("本机还没有可恢复的 v7 记录。");
  report(callback, "merge", `正在恢复 ${value.checkpoint.counts.questions.toLocaleString("zh-CN")} 道题`, 45);
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
