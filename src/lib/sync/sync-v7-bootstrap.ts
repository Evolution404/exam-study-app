import { commitChangeSetSnapshotV7 } from "../db/db-v7";
import type { GitHubSettings } from "../../types/types";
import type { SyncV7HeadCache } from "./github-v7-remote";
import { descriptorPath, remote, report, sha256, vaultId, type SyncProgressCallback, type SyncWithGitHubOptions } from "./sync-v7-context";
import { saveHeadCache, saveInstalledHead, saveRemoteCache } from "./sync-v7-cache";
import { checkpointFromProjection, projectionFromCheckpoint, saveQueueBase } from "./sync-v7-checkpoint-bridge";
import { createSyncCheckpointV7Snapshot } from "./sync-v7-checkpoint";
import { createRemoteCheckpointV8, encodeSyncCheckpointV8 } from "./sync-v8-history";
import { SYNC_V7_CHECKPOINT_PREFIX, type SyncHeadV7, type SyncV7Descriptor } from "./sync-v7-head";
import { installFingerprint } from "./sync-v7-watermark";
import { SYNC_V7_ASSET_UPLOAD_CONCURRENCY, uploadedDescriptor, uploadPendingImageAssetsV7 } from "./sync-v7-upload";
import { filterProjectionHistoryV7, historySyncStartFor } from "./history-sync-range";
import { assetUploadProgressLabelV7 } from "./sync-v7-orchestrator-model";

/**
 * Bootstrap an empty v9 remote without changing the normal sync phase order.
 * This phase owns only initial remote publication plus the matching local cache
 * installation; normal download/rebase/publish remains in the orchestrator.
 */
export async function initializeSyncV7Remote(
  settings: GitHubSettings,
  token: string,
  callback?: SyncProgressCallback,
  options?: SyncWithGitHubOptions,
): Promise<SyncV7HeadCache> {
  const client = remote(settings, token, options?.fetch, options?.transport);
  const existing = await client.readHead();
  if (existing.initialized) return existing.cache;

  // Publish local blobs before taking the first checkpoint. Otherwise an
  // import made against an empty vault would be checkpointed with local-only
  // descriptors, committed, and then require newly-created asset events.
  await uploadPendingImageAssetsV7(client, ({ completed, total, uploadedBytes, totalBytes }) => {
    const label = assetUploadProgressLabelV7({ completed, total, uploadedBytes, totalBytes, concurrency: SYNC_V7_ASSET_UPLOAD_CONCURRENCY });
    report(callback, "upload", label, 4 + 2 * (total ? completed / total : 0), 6);
  });
  report(callback, "prepare", "正在初始化 v9 热窗口", 6, 8);

  const localSnapshot = await createSyncCheckpointV7Snapshot();
  const historySyncStart = historySyncStartFor(settings);
  const localProjection = filterProjectionHistoryV7(await projectionFromCheckpoint(localSnapshot.checkpoint), historySyncStart);
  const localCheckpoint = await checkpointFromProjection(localProjection, localSnapshot.checkpoint.cursors);
  const checkpoint = await createRemoteCheckpointV8(client, localCheckpoint);
  const bytes = encodeSyncCheckpointV8(checkpoint);
  const digest = await sha256(bytes);
  const checkpointPath = descriptorPath(SYNC_V7_CHECKPOINT_PREFIX, digest);
  const descriptor: SyncV7Descriptor = { ...(await uploadedDescriptor(client, checkpointPath, bytes, "checkpoint")), generation: 0 };
  const now = new Date().toISOString();
  const vault = vaultId(settings);
  const head: SyncHeadV7 = {
    formatVersion: 9,
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
    if (!winner.initialized) throw new Error("v9 初始化冲突，请重试。");
    return winner.cache;
  }

  // A GitHub-compatible layer may return ok on an un-CAS'd PUT and silently
  // accept a later writer. Re-read before committing local queue state so the
  // device only adopts a bootstrap head it actually owns.
  const confirmed = await client.readHead();
  if (!confirmed.initialized) throw new Error("v9 初始化冲突，请重试。");
  if (confirmed.cache.blobSha !== committed.blobSha) return confirmed.cache;

  await saveHeadCache(settings, committed.cache);
  // Local recovery cache remains a fully hydrated v7 projection; only the
  // remote immutable checkpoint is bounded format 8.
  await saveRemoteCache(settings, localCheckpoint, committed.cache);
  const covered = localSnapshot.changeSets.filter((record) => record.state === "pending" || record.state === "blocked");
  if (covered.length) await commitChangeSetSnapshotV7(covered, now);
  await saveQueueBase(localProjection);
  // With a history lower bound the local database may still contain older rows.
  // Leave the install marker empty so the normal sync pass atomically replaces
  // it with the filtered projection immediately after initialization.
  if (!historySyncStart) await saveInstalledHead(settings, installFingerprint(committed.cache));
  return committed.cache;
}
