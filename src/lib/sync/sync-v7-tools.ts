import { listChangeSetsV7, restoreV7Checkpoint } from "../db/db-v7";
import type { GitHubSettings } from "../../types/types";
import { report, type SyncProgressCallback, type SyncWithGitHubOptions } from "./sync-v7-context";
import { loadHeadCache, loadRemoteCache, saveHeadCache, saveInstalledCursors, saveInstalledHead } from "./sync-v7-cache";
import { projectionFromCheckpoint, saveQueueBase } from "./sync-v7-checkpoint-bridge";
import { installFingerprint } from "./sync-v7-watermark";
import { withSyncLock } from "./sync-lock";
import { filterProjectionHistoryV7, historySyncStartFor } from "./history-sync-range";
import { getGitHubTransport, resolveGitHubApiBaseUrl } from "../../platform/github-transport";
import { SYNC_V7_MAX_HOT_BYTES } from "./sync-v7-head-types";

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
    checkpointGeneration: head.checkpoint?.generation ?? (head.segments.length ? head.segments[0].generation - 1 : head.generation),
    hasCheckpoint: Boolean(head.checkpoint),
    segmentSizes: head.segments.map((segment) => segment.size),
    ...(head.checkpoint ? { checkpointSize: head.checkpoint.size, ...(head.checkpoint.storedSize !== undefined ? { checkpointStoredSize: head.checkpoint.storedSize } : {}) } : {}),
    segmentEvents: head.segments.reduce((sum, segment) => sum + segment.count, 0),
  };
}

export async function restoreLastRemoteCache(settings: GitHubSettings, callback?: SyncProgressCallback) {
  return withSyncLock(async () => {
    report(callback, "prepare", "正在检查本地恢复记录", 4, 8);
    const value = await loadRemoteCache(settings);
    if (!value) throw new Error("本机还没有可恢复的同步记录。");
    if (value.historySyncStart !== historySyncStartFor(settings)) throw new Error("同步时间起点已经改变，请先从远端同步以建立新的本地恢复记录。");
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
