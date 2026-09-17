import { commitChangeSetSnapshot } from "../db/db";
import type { GitHubSettings } from "../../types/types";
import type { SyncHeadCache } from "./github-remote";
import { descriptorPath, remote, report, sha256, vaultId, type SyncProgressCallback, type SyncWithGitHubOptions } from "./sync-context";
import { saveHeadCache, saveInstalledHead, saveRemoteCache } from "./sync-cache";
import { checkpointFromProjection, projectionFromCheckpoint, saveQueueBase } from "./sync-checkpoint-bridge";
import { createSyncCheckpointSnapshot } from "./sync-checkpoint-store";
import { createRemoteHistoryCheckpoint, encodeRemoteHistoryCheckpoint } from "./sync-history";
import { SYNC_CHECKPOINT_PREFIX, SYNC_FORMAT_VERSION, type SyncHead, type SyncDescriptor } from "./sync-head-types";
import { installFingerprint } from "./sync-watermark";
import { SYNC_ASSET_UPLOAD_CONCURRENCY, uploadedDescriptor, uploadPendingImageAssets } from "./sync-upload";
import { filterProjectionHistory, historySyncStartFor } from "./history-sync-range";
import { assetUploadProgressLabel } from "./sync-orchestrator-model";

/**
 * Bootstrap an empty current-protocol remote without changing the normal sync phase order.
 * This phase owns only initial remote publication plus the matching local cache
 * installation; normal download/rebase/publish remains in the orchestrator.
 */
export async function initializeSyncRemote(
  settings: GitHubSettings,
  token: string,
  callback?: SyncProgressCallback,
  options?: SyncWithGitHubOptions,
): Promise<SyncHeadCache> {
  const client = remote(settings, token, options?.fetch, options?.transport);
  const existing = await client.readHead();
  if (existing.initialized) return existing.cache;

  // Publish local blobs before taking the first checkpoint. Otherwise an
  // import made against an empty vault would be checkpointed with local-only
  // descriptors, committed, and then require newly-created asset events.
  await uploadPendingImageAssets(client, ({ completed, total, uploadedBytes, totalBytes }) => {
    const label = assetUploadProgressLabel({ completed, total, uploadedBytes, totalBytes, concurrency: SYNC_ASSET_UPLOAD_CONCURRENCY });
    report(callback, "upload", label, 4 + 2 * (total ? completed / total : 0), 6);
  });
  report(callback, "prepare", "正在初始化同步热窗口", 6, 8);

  const localSnapshot = await createSyncCheckpointSnapshot();
  const historySyncStart = historySyncStartFor(settings);
  const localProjection = filterProjectionHistory(await projectionFromCheckpoint(localSnapshot.checkpoint), historySyncStart);
  const localCheckpoint = await checkpointFromProjection(localProjection, localSnapshot.checkpoint.cursors);
  const checkpoint = await createRemoteHistoryCheckpoint(client, localCheckpoint);
  const bytes = encodeRemoteHistoryCheckpoint(checkpoint);
  const digest = await sha256(bytes);
  const checkpointPath = descriptorPath(SYNC_CHECKPOINT_PREFIX, digest);
  const descriptor: SyncDescriptor = { ...(await uploadedDescriptor(client, checkpointPath, bytes, "checkpoint")), generation: 0 };
  const now = new Date().toISOString();
  const vault = vaultId(settings);
  const head: SyncHead = {
    formatVersion: SYNC_FORMAT_VERSION,
    vaultId: vault,
    generatedAt: now,
    generation: 0,
    metadata: { vaultId: vault, producer: "exam-study-app" },
    checkpoint: descriptor,
    segments: [],
    cursors: {},
  };

  const committed = await client.putHead(head);
  if (!committed.ok) {
    const winner = await client.readHead();
    if (!winner.initialized) throw new Error("同步初始化冲突，请重试。");
    return winner.cache;
  }

  // A GitHub-compatible layer may return ok on an un-CAS'd PUT and silently
  // accept a later writer. Re-read before committing local queue state so the
  // device only adopts a bootstrap head it actually owns.
  const confirmed = await client.readHead();
  if (!confirmed.initialized) throw new Error("同步初始化冲突，请重试。");
  if (confirmed.cache.blobSha !== committed.blobSha) return confirmed.cache;

  await saveHeadCache(settings, committed.cache);
  // Local recovery cache remains a fully hydrated projection; only the
  // remote immutable checkpoint is bounded format 8.
  await saveRemoteCache(settings, localCheckpoint, committed.cache);
  const covered = localSnapshot.changeSets.filter((record) => record.state === "pending" || record.state === "blocked");
  if (covered.length) await commitChangeSetSnapshot(covered, now);
  await saveQueueBase(localProjection);
  // With a history lower bound the local database may still contain older rows.
  // Leave the install marker empty so the normal sync pass atomically replaces
  // it with the filtered projection immediately after initialization.
  if (!historySyncStart) await saveInstalledHead(settings, installFingerprint(committed.cache));
  return committed.cache;
}
