import { studyDb } from "../db/db";
import type { GitHubSettings } from "../../types/types";
import type { SyncHeadCache } from "./github-remote";
import { cacheKey } from "./sync-context";
import type { SyncCheckpoint } from "./sync-checkpoint-types";
import { historySyncStartFor } from "./history-sync-range";

export type RemoteCache = { cachedAt: string; checkpoint: SyncCheckpoint; head: SyncHeadCache; historySyncStart?: string };

export async function loadHeadCache(settings: GitHubSettings): Promise<SyncHeadCache | undefined> {
  return (await studyDb.syncMeta.get(cacheKey(settings, "head")))?.value as SyncHeadCache | undefined;
}

export async function saveHeadCache(settings: GitHubSettings, cache: SyncHeadCache): Promise<void> {
  await studyDb.syncMeta.put({ key: cacheKey(settings, "head"), value: cache, updatedAt: new Date().toISOString() });
}

export async function saveRemoteCache(settings: GitHubSettings, checkpoint: SyncCheckpoint, head: SyncHeadCache): Promise<void> {
  const historySyncStart = historySyncStartFor(settings);
  await studyDb.syncMeta.put({ key: cacheKey(settings, "checkpoint"), value: { cachedAt: new Date().toISOString(), checkpoint, head, ...(historySyncStart ? { historySyncStart } : {}) }, updatedAt: new Date().toISOString() });
}

export async function loadRemoteCache(settings: GitHubSettings): Promise<RemoteCache | undefined> {
  return (await studyDb.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as RemoteCache | undefined;
}

export async function loadInstalledHead(settings: GitHubSettings): Promise<string | undefined> {
  return (await studyDb.syncMeta.get(cacheKey(settings, "installed-head")))?.value as string | undefined;
}

/** Store the already-computed install fingerprint.  Computing it here would
 *  couple the cache layer to the watermark module; callers pass
 *  `installFingerprint(cache)` so this module stays dependency-free. */
export async function saveInstalledHead(settings: GitHubSettings, fingerprint: string): Promise<void> {
  await studyDb.syncMeta.put({ key: cacheKey(settings, "installed-head"), value: fingerprint, updatedAt: new Date().toISOString() });
}

/**
 * The highest remote `localSequence` per device that this client has already
 * installed into its projection. Used to dedup downloaded changes by cursor
 * instead of by committed-record id, so committed records can be garbage
 * collected without re-pulling/re-counting them.
 */
export async function loadInstalledCursors(settings: GitHubSettings): Promise<Record<string, number>> {
  return ((await studyDb.syncMeta.get(cacheKey(settings, "installed-cursors")))?.value ?? {}) as Record<string, number>;
}

export async function saveInstalledCursors(settings: GitHubSettings, cursors: Record<string, number>): Promise<void> {
  await studyDb.syncMeta.put({ key: cacheKey(settings, "installed-cursors"), value: cursors, updatedAt: new Date().toISOString() });
}
