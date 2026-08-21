import { dbV7 } from "../db/db-v7";
import type { GitHubSettings } from "../../types/types";
import type { SyncV7HeadCache } from "./github-v7-remote";
import { cacheKey } from "./sync-v7-context";
import type { SyncCheckpointV7 } from "./sync-v7-checkpoint";
import { historySyncStartFor } from "./history-sync-range";

export type RemoteCacheV7 = { cachedAt: string; checkpoint: SyncCheckpointV7; head: SyncV7HeadCache; historySyncStart?: string };

export async function loadHeadCache(settings: GitHubSettings): Promise<SyncV7HeadCache | undefined> {
  return (await dbV7.syncMeta.get(cacheKey(settings, "head")))?.value as SyncV7HeadCache | undefined;
}

export async function saveHeadCache(settings: GitHubSettings, cache: SyncV7HeadCache): Promise<void> {
  await dbV7.syncMeta.put({ key: cacheKey(settings, "head"), value: cache, updatedAt: new Date().toISOString() });
}

export async function saveRemoteCache(settings: GitHubSettings, checkpoint: SyncCheckpointV7, head: SyncV7HeadCache): Promise<void> {
  const historySyncStart = historySyncStartFor(settings);
  await dbV7.syncMeta.put({ key: cacheKey(settings, "checkpoint"), value: { cachedAt: new Date().toISOString(), checkpoint, head, ...(historySyncStart ? { historySyncStart } : {}) }, updatedAt: new Date().toISOString() });
}

export async function loadRemoteCache(settings: GitHubSettings): Promise<RemoteCacheV7 | undefined> {
  return (await dbV7.syncMeta.get(cacheKey(settings, "checkpoint")))?.value as RemoteCacheV7 | undefined;
}

export async function loadInstalledHead(settings: GitHubSettings): Promise<string | undefined> {
  return (await dbV7.syncMeta.get(cacheKey(settings, "installed-head")))?.value as string | undefined;
}

/** Store the already-computed install fingerprint.  Computing it here would
 *  couple the cache layer to the watermark module; callers pass
 *  `installFingerprint(cache)` so this module stays dependency-free. */
export async function saveInstalledHead(settings: GitHubSettings, fingerprint: string): Promise<void> {
  await dbV7.syncMeta.put({ key: cacheKey(settings, "installed-head"), value: fingerprint, updatedAt: new Date().toISOString() });
}

/**
 * The highest remote `localSequence` per device that this client has already
 * installed into its projection. Used to dedup downloaded changes by cursor
 * instead of by committed-record id, so committed records can be garbage
 * collected without re-pulling/re-counting them.
 */
export async function loadInstalledCursors(settings: GitHubSettings): Promise<Record<string, number>> {
  return ((await dbV7.syncMeta.get(cacheKey(settings, "installed-cursors")))?.value ?? {}) as Record<string, number>;
}

export async function saveInstalledCursors(settings: GitHubSettings, cursors: Record<string, number>): Promise<void> {
  await dbV7.syncMeta.put({ key: cacheKey(settings, "installed-cursors"), value: cursors, updatedAt: new Date().toISOString() });
}
