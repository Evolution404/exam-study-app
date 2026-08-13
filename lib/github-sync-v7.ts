import {
  commitChangeSetClaimV7,
  dbV6,
  listChangeSetsV7,
  releaseChangeSetClaimV7,
  claimPendingChangeSetsV7,
  restoreV6CheckpointAndEvents,
  type ChangeSetQueueRecordV7,
} from "./db-v6";
import { verifyChangeSetDigestV7, type ChangeSetV7 } from "./change-set-v7";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import { createSyncCheckpointV6, encodeSyncCheckpointV6, parseSyncCheckpointV6, type SyncCheckpointV6 } from "./sync-v6-checkpoint";
import {
  SYNC_V7_CHECKPOINT_PREFIX,
  SYNC_V7_SEGMENT_PREFIX,
  createSyncV7PublicationPlan,
  decodeSyncV7Segment,
  encodeSyncV7Segment,
  mergeSyncV7Segments,
  planSyncV7Compaction,
  type SyncHeadV7,
  type SyncV7Descriptor,
  type SyncV7SegmentDescriptor,
} from "./sync-v7-head";
import { GitHubV7Remote, type SyncV7HeadCache } from "./github-v7-remote";
import { getGitHubLoginV6 } from "./github-sync-v6";
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
function remote(settings: GitHubSettings, token: string): GitHubV7Remote { return new GitHubV7Remote({ owner: settings.owner, repo: settings.repo, branch: branch(settings), token, apiBaseUrl: settings.apiBaseUrl, vaultId: vaultId(settings) }); }

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

async function installProjection(projection: ChangeSetProjectionV7): Promise<void> {
  const checkpoint = await checkpointFromProjection(projection, {});
  await restoreV6CheckpointAndEvents(checkpoint.state, [], { preservePending: false });
}

async function downloadRemote(client: GitHubV7Remote, head: SyncHeadV7): Promise<{ checkpoint: SyncCheckpointV6; changes: ChangeSetV7[] }> {
  if (!head.checkpoint) throw new Error("v7 远端缺少初始化检查点。");
  const checkpoint = parseSyncCheckpointV6(await client.readBlob(head.checkpoint));
  const changes: ChangeSetV7[] = [];
  for (const descriptor of [...head.segments].sort((a, b) => a.generation - b.generation || a.ordinal - b.ordinal)) {
    const segment = decodeSyncV7Segment<ChangeSetV7>(await client.readBlob(descriptor), { vaultId: head.vaultId, generation: descriptor.generation, ordinal: descriptor.ordinal });
    for (const change of segment.events) {
      if (!await verifyChangeSetDigestV7(change)) throw new Error(`远端变更集 ${change.id} 完整性校验失败。`);
      changes.push(change);
    }
  }
  return { checkpoint, changes };
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

async function initialize(settings: GitHubSettings, token: string, callback?: SyncProgressCallback): Promise<SyncV7HeadCache> {
  const client = remote(settings, token);
  const existing = await client.readHead();
  if (existing.initialized) return existing.cache;
  report(callback, "prepare", "正在初始化 v7 热窗口", 8);
  const checkpoint = await createSyncCheckpointV6();
  const bytes = encodeSyncCheckpointV6(checkpoint);
  const digest = await sha256(bytes);
  const path = descriptorPath(SYNC_V7_CHECKPOINT_PREFIX, digest);
  const descriptor = await uploadedDescriptor(client, path, bytes, "checkpoint");
  const now = new Date().toISOString();
  const head: SyncHeadV7 = { formatVersion: 7, vaultId: vaultId(settings), generatedAt: now, generation: 0, metadata: { vaultId: vaultId(settings), producer: "exam-study-app" }, checkpoint: descriptor, segments: [], cursors: {} };
  const committed = await client.putHead(head);
  if (!committed.ok) {
    const winner = await client.readHead();
    if (!winner.initialized) throw new Error("v7 初始化冲突，请重试。");
    return winner.cache;
  }
  await saveHeadCache(settings, committed.cache);
  await saveRemoteCache(settings, checkpoint, committed.cache);
  const covered = await listChangeSetsV7(["pending", "blocked"]);
  if (covered.length) await dbV6.changeSets.bulkPut(covered.map((record) => ({ ...record, state: "committed" as const, committedAt: now })));
  await saveQueueBase(await projectionFromCheckpoint(checkpoint));
  return committed.cache;
}

export async function syncWithGitHub(settings: GitHubSettings, token: string, callback?: SyncProgressCallback) {
  const client = remote(settings, token);
  let read = await client.readHead(await loadHeadCache(settings));
  if (!read.initialized) { await initialize(settings, token, callback); read = await client.readHead(); }
  if (!read.initialized) throw new Error("无法初始化 v7 远端。");
  let hasQueueBase = Boolean(await dbV6.syncMeta.get("v7:queue-base"));
  let pulled = 0;
  for (let retry = 0; retry < 4; retry += 1) {
    report(callback, "download", "正在读取 v7 热窗口", 18);
    const downloaded = await downloadRemote(client, read.head);
    const remoteProjection = replayInWireOrder(await projectionFromCheckpoint(downloaded.checkpoint), downloaded.changes);
    const remoteById = new Map(downloaded.changes.map((change) => [change.id, change]));
    const remoteCursors = read.head.cursors;
    const interruptedClaims = (await listChangeSetsV7(["claimed"])).map((record) => {
      const remoteChange = remoteById.get(record.id);
      if (remoteChange && remoteChange.digest !== record.digest) throw new Error(`远端变更集 ${record.id} 与本地锁定版本不一致。`);
      const coveredByRemote = Boolean(remoteChange) || (remoteCursors[record.deviceId] ?? 0) >= record.localSequence;
      return coveredByRemote
        ? { ...record, state: "committed" as const, committedAt: new Date().toISOString(), claimId: undefined, claimedAt: undefined }
        : { ...record, state: "pending" as const, claimId: undefined, claimedAt: undefined };
    });
    if (interruptedClaims.length) await dbV6.changeSets.bulkPut(interruptedClaims);
    const committedIds = new Set((await listChangeSetsV7(["committed"])).map((record) => record.id));
    const unseen = downloaded.changes.filter((change) => !committedIds.has(change.id));
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
    if (!hasQueueBase || unseen.length || blocked.length) {
      await installProjection(rebasedProjection);
      hasQueueBase = true;
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
      return { pulled, pushed: 0, remaining, deferred: 0, formatVersion: 7 as const, compacted: false, migrated: false };
    }
    try {
      report(callback, "upload", `正在上传 ${claim.records.length} 组变更`, 62);
      const generation = read.head.generation + 1;
      const ordinal = read.head.segments.filter((item) => item.generation === generation).length;
      const now = new Date().toISOString();
      const segmentValue = { formatVersion: 7 as const, vaultId: read.head.vaultId, generation, ordinal, metadata: { vaultId: read.head.vaultId, createdAt: now, producer: "exam-study-app" }, cursors: cursorsFor(claim.records), events: claim.records.map((record) => ({ formatVersion: record.formatVersion, id: record.id, deviceId: record.deviceId, localSequence: record.localSequence, createdAt: record.createdAt, kind: record.kind, mutations: record.mutations, entityRefs: record.entityRefs, payloadRefs: record.payloadRefs, digest: record.digest })) };
      const segmentBytes = encodeSyncV7Segment(segmentValue);
      const segmentDigest = await sha256(segmentBytes);
      const segmentPath = descriptorPath(SYNC_V7_SEGMENT_PREFIX, segmentDigest);
      const segmentBase = await uploadedDescriptor(client, segmentPath, segmentBytes, "segment");
      const segment: SyncV7SegmentDescriptor = { ...segmentBase, generation, ordinal, count: claim.records.length, cursors: segmentValue.cursors, metadata: segmentValue.metadata };
      const segments = mergeSyncV7Segments(read.head.segments, [segment], read.head.vaultId);
      const hotBytes = segments.reduce((sum, item) => sum + item.size, 0);
      const compaction = planSyncV7Compaction({ head: read.head, hotBytes });
      let checkpointFile: { path: string; bytes: Uint8Array; kind: "checkpoint" } | undefined;
      let checkpointDescriptor = read.head.checkpoint;
      let nextSegments = segments;
      if (compaction.required) {
        report(callback, "compact", "热窗口超过 4 MiB，正在生成检查点", 78);
        const checkpoint = await checkpointFromProjection(
          replayInWireOrder(remoteProjection, claim.records),
          { ...read.head.cursors, ...segmentValue.cursors },
        );
        const bytes = encodeSyncCheckpointV6(checkpoint);
        const digest = await sha256(bytes);
        const path = descriptorPath(SYNC_V7_CHECKPOINT_PREFIX, digest);
        const uploaded = await uploadedDescriptor(client, path, bytes, "checkpoint");
        checkpointFile = { path, bytes, kind: "checkpoint" };
        checkpointDescriptor = uploaded;
        nextSegments = [];
      }
      const nextHead: SyncHeadV7 = { ...read.head, generatedAt: now, generation, checkpoint: checkpointDescriptor, segments: nextSegments, cursors: { ...read.head.cursors, ...segmentValue.cursors } };
      const plan = createSyncV7PublicationPlan({ expectedHead: read.head, expectedHeadSha: read.cache.blobSha, head: nextHead, segments: [{ path: segmentPath, bytes: segmentBytes, kind: "segment" }], ...(checkpointFile ? { checkpoint: checkpointFile, compaction } : {}) });
      const committed = await client.publish(plan);
      if (!committed.ok) { await releaseChangeSetClaimV7(claim.claimId); read = await client.readHead(); if (!read.initialized) throw new Error("v7 远端索引丢失。"); continue; }
      await commitChangeSetClaimV7(claim.claimId, new Map(claim.records.map((record) => [record.id, record.digest])));
      const committedProjection = replayInWireOrder(remoteProjection, claim.records);
      await saveQueueBase(committedProjection);
      await saveHeadCache(settings, committed.cache);
      await saveRemoteCache(settings, await checkpointFromProjection(committedProjection, nextHead.cursors), committed.cache);
      const remaining = (await listChangeSetsV7(["pending", "blocked"])).length;
      report(callback, "complete", "同步完成", 100);
      return { pulled, pushed: claim.records.length, remaining, deferred: 0, formatVersion: 7 as const, compacted: compaction.required, migrated: false };
    } catch (error) { await releaseChangeSetClaimV7(claim.claimId); throw error; }
  }
  throw new Error("远端持续发生并发更新，本地变更已保留，请稍后重试。");
}

export async function restoreFullHistoryFromGitHub(settings: GitHubSettings, token: string, callback?: SyncProgressCallback) {
  const client = remote(settings, token);
  const read = await client.readHead();
  if (!read.initialized) throw new Error("远端还没有 v7 数据。");
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
  report(callback, "complete", "v7 远端恢复完成", 100);
  return { pulled: downloaded.changes.length, formatVersion: 7 as const, counts: checkpoint.counts, deferred: 0, cachedAt: new Date().toISOString(), archivedAttempts: 0, archivedPracticeRuns: 0 };
}

export const restoreFromGitHub = restoreFullHistoryFromGitHub;
export const pullFromGitHub = async (settings: GitHubSettings, token: string, callback?: SyncProgressCallback) => syncWithGitHub(settings, token, callback);
export const initializeGitHubVault = initialize;
export const getGitHubLogin = getGitHubLoginV6;

export async function getLastRemoteCache(settings: GitHubSettings) {
  const value = (await dbV6.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as { cachedAt: string; checkpoint: SyncCheckpointV6 } | undefined;
  return value ? { cachedAt: value.cachedAt, counts: value.checkpoint.counts, formatVersion: 7 as const } : null;
}

export async function restoreLastRemoteCache(settings: GitHubSettings, callback?: SyncProgressCallback) {
  report(callback, "prepare", "正在检查本地 v7 恢复记录", 8);
  const value = (await dbV6.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as { cachedAt: string; checkpoint: SyncCheckpointV6; head: SyncV7HeadCache } | undefined;
  if (!value) throw new Error("本机还没有可恢复的 v7 记录。");
  report(callback, "merge", `正在恢复 ${value.checkpoint.counts.questions.toLocaleString("zh-CN")} 道题`, 45);
  await restoreV6CheckpointAndEvents(value.checkpoint.state, [], { preservePending: false });
  await dbV6.changeSets.clear();
  await saveQueueBase(await projectionFromCheckpoint(value.checkpoint));
  await saveHeadCache(settings, value.head);
  report(callback, "complete", "本地数据恢复完成", 100);
  return { cachedAt: value.cachedAt, counts: value.checkpoint.counts, formatVersion: 7 as const, pulled: 0, deferred: 0 };
}

export async function verifyGitHubVault(settings: GitHubSettings, token: string) { return (await remote(settings, token).readHead()).initialized ? 7 as const : 0 as const; }
export async function getSyncStats() { const checkpoint = await createSyncCheckpointV6(); return { ...checkpoint.counts, pendingEvents: (await listChangeSetsV7(["pending", "blocked"])).length }; }
export async function loadAttemptHistory(settings: GitHubSettings, token: string, options: { month?: string; questionId?: string } = {}) { await syncWithGitHub(settings, token); const rows = (await dbV6.attempts.toArray()).filter((attempt) => (!options.questionId || attempt.questionId === options.questionId) && (!options.month || attempt.createdAt.startsWith(options.month))); return { loaded: rows.length, segments: 0 }; }

export type { ChangeSetQueueRecordV7 };
