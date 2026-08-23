import { listChangeSetsV7, restoreV7Checkpoint } from "../db/db-v7";
import type { GitHubSettings } from "../../types/types";
import { verifyChangeSetDigestV7, type ChangeSetV7 } from "./change-set-v7";
import { assertChangeSetProjectionV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import { cursorsFor, descriptorPath, remote, report, sha256, type SyncProgressCallback, type SyncWithGitHubOptions } from "./sync-v7-context";
import { loadHeadCache, loadRemoteCache, saveHeadCache, saveInstalledCursors, saveInstalledHead } from "./sync-v7-cache";
import { checkpointFromProjection, projectionFromCheckpoint, replayRemoteResilient, saveQueueBase } from "./sync-v7-checkpoint-bridge";
import { createSyncCheckpointV7, type SyncCheckpointV7 } from "./sync-v7-checkpoint";
import { createRemoteCheckpointV8, decodeRemoteCheckpoint, encodeSyncCheckpointV8, gcSyncV8HistoryRemote } from "./sync-v8-history";
import {
  SYNC_V7_CHECKPOINT_PREFIX,
  SYNC_V7_MAX_HOT_BYTES,
  decodeSyncV7Segment,
  type SyncHeadV7,
  type SyncV7Descriptor,
  type SyncV7SegmentDescriptor,
} from "./sync-v7-head";
import { hydrateSyncV7Events } from "./sync-v7-payload";
import { uploadedDescriptor } from "./sync-v7-upload";
import { installFingerprint } from "./sync-v7-watermark";
import { withSyncLock } from "./sync-lock";
import { filterProjectionHistoryV7, historySyncStartFor } from "./history-sync-range";
import { getGitHubTransport, resolveGitHubApiBaseUrl } from "../../platform/github-transport";

export async function getGitHubLogin(token: string, apiBaseUrl?: string, options?: SyncWithGitHubOptions): Promise<string> {
  const transport = options?.transport ?? getGitHubTransport();
  const base = resolveGitHubApiBaseUrl(apiBaseUrl, transport).replace(/\/$/, "");
  const response = await (options?.fetch ?? transport.fetch)(`${base}/user`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）`);
  const value = await response.json() as { login?: unknown };
  if (typeof value.login !== "string" || !value.login) throw new Error("GitHub 未返回登录名。");
  return value.login;
}

export async function getLastRemoteCache(settings: GitHubSettings) {
  const value = await loadRemoteCache(settings);
  if (value?.historySyncStart !== historySyncStartFor(settings)) return null;
  return value ? { cachedAt: value.cachedAt, counts: value.checkpoint.counts, formatVersion: 9 as const } : null;
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
  return withSyncLock(async () => {
    report(callback, "prepare", "正在检查本地 v7 恢复记录", 4, 8);
    const value = await loadRemoteCache(settings);
    if (!value) throw new Error("本机还没有可恢复的 v7 记录。");
    if (value.historySyncStart !== historySyncStartFor(settings)) throw new Error("同步时间起点已经改变，请先从远端同步以建立新的本地恢复记录。");
    // 缓存恢复仍允许用户明确丢弃快照时已有的待同步变更，但只允许丢弃
    // 恢复开始时的那一批。若下载/重建期间出现新编辑，事务守卫会拒绝，
    // 避免把刚发生的本地修改连同队列一起吞掉。
    const queueSnapshot = await listChangeSetsV7();
    report(callback, "merge", `正在恢复 ${value.checkpoint.counts.questions.toLocaleString("zh-CN")} 道题`, 40, 92);
    const filtered = filterProjectionHistoryV7(await projectionFromCheckpoint(value.checkpoint), historySyncStartFor(settings));
    const installed = await restoreV7Checkpoint(filtered, { queueGuard: queueSnapshot, clearChangeSets: true });
    if (!installed) throw new Error("恢复期间检测到新的本地更改，请重试。");
    await saveQueueBase(await projectionFromCheckpoint(value.checkpoint));
    await saveHeadCache(settings, value.head);
    await saveInstalledHead(settings, installFingerprint(value.head));
    await saveInstalledCursors(settings, value.checkpoint.cursors ?? {});
    report(callback, "complete", "本地数据恢复完成", 100);
    return { cachedAt: value.cachedAt, counts: value.checkpoint.counts, formatVersion: 9 as const, pulled: 0, deferred: 0 };
  });
}

export async function verifyGitHubVault(settings: GitHubSettings, token: string, options?: SyncWithGitHubOptions) { return (await remote(settings, token, options?.fetch, options?.transport).readHead()).initialized ? 7 as const : 0 as const; }
export async function getSyncStats() { const checkpoint = await createSyncCheckpointV7(); return { ...checkpoint.counts, pendingEvents: (await listChangeSetsV7(["pending", "blocked"])).length }; }

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
  counts?: SyncCheckpointV7["counts"];
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
  const client = remote(settings, token, options?.fetch, options?.transport);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await client.readHead();
    if (!read.initialized) throw new Error("远端还没有 v7 数据，无需迁移。");
    const head = read.head;
    if (!head.checkpoint) throw new Error("远端缺少检查点，无法迁移。");

    // ---- Phase 1: read-only verification ----------------------------------
    onProgress?.(`验证检查点（${(head.checkpoint.size / 1024).toFixed(0)} KiB）`);
    const decodedCheckpoint = await decodeRemoteCheckpoint(client, await client.readBlob(head.checkpoint));
    const checkpoint = decodedCheckpoint.checkpoint;
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
    const fullCheckpoint = await checkpointFromProjection(compacted, nextCursors);
    const newCheckpoint = await createRemoteCheckpointV8(client, fullCheckpoint);
    const bytes = encodeSyncCheckpointV8(newCheckpoint);
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
    try { await gcSyncV8HistoryRemote(client, head, published.cache); } catch { /* best-effort */ }
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
  const client = remote(settings, token, options?.fetch, options?.transport);
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
