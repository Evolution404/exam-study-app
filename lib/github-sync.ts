import {
  applyPreparedSyncCheckpoint,
  db,
  prepareSyncCheckpoint,
  validateSyncCheckpoint,
  withSyncRestoreTransaction,
} from "./db";
import {
  initializeGitHubVaultV4,
  loadAttemptHistoryV4,
  pullFromGitHubV4,
  restoreFromGitHubV4,
  restoreFullHistoryFromGitHubV4,
  syncWithGitHubV4,
  verifyGitHubVaultV4,
  type SyncV4Progress,
  type SyncV4ProgressCallback,
} from "./github-sync-v4";
import type { GitHubSettings } from "./types";

const githubApi = "https://api.github.com";
const remoteCachePrefix = "__local_remote_cache__/";

export type SyncProgress = SyncV4Progress;
export type SyncProgressCallback = SyncV4ProgressCallback;

function report(onProgress: SyncProgressCallback | undefined, phase: SyncProgress["phase"], label: string, percent: number) {
  onProgress?.({ phase, label, percent: Math.max(0, Math.min(100, Math.round(percent))) });
}

function remoteCachePath(settings: GitHubSettings) {
  return `${remoteCachePrefix}${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/${encodeURIComponent(settings.branch || "main")}`;
}

async function githubRequest<T>(path: string, token: string) {
  const response = await fetch(`${githubApi}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    let message = `GitHub 请求失败（${response.status}）`;
    try {
      const payload = await response.json() as { message?: string };
      if (payload.message) message = payload.message;
    } catch { /* Keep the status-based message. */ }
    throw new Error(message);
  }
  return await response.json() as T;
}

export async function getGitHubLogin(token: string) {
  return (await githubRequest<{ login: string }>("/user", token)).login;
}

export async function getLastRemoteCache(settings: GitHubSettings) {
  const cached = (await db.syncFiles.get(remoteCachePath(settings)))?.remoteCache;
  if (!cached) return null;
  validateSyncCheckpoint(cached.snapshot);
  return { cachedAt: cached.cachedAt, counts: cached.snapshot.counts };
}

export async function restoreLastRemoteCache(settings: GitHubSettings, onProgress?: SyncProgressCallback) {
  report(onProgress, "prepare", "正在检查本地恢复记录", 5);
  const cacheFile = await db.syncFiles.get(remoteCachePath(settings));
  const cached = cacheFile?.remoteCache;
  if (!cacheFile || !cached) throw new Error("本机还没有可恢复的远程缓存，请先成功同步一次。");
  const plan = prepareSyncCheckpoint(cached.snapshot);
  report(onProgress, "merge", "正在原子重建题库和学习记录", 48);
  await withSyncRestoreTransaction(async () => {
    await applyPreparedSyncCheckpoint(plan);
    report(onProgress, "merge", "正在恢复同步标记", 82);
    await db.syncFiles.bulkPut([...cached.markers, cacheFile]);
  });
  report(onProgress, "complete", "本地记录恢复完成", 100);
  return { cachedAt: cached.cachedAt, counts: cached.snapshot.counts, formatVersion: 4 as const };
}

export async function syncWithGitHub(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  return syncWithGitHubV4(settings, token, onProgress);
}

export async function pullFromGitHub(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  return pullFromGitHubV4(settings, token, onProgress);
}

export async function restoreFromGitHub(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  return restoreFromGitHubV4(settings, token, onProgress);
}

export async function restoreFullHistoryFromGitHub(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  return restoreFullHistoryFromGitHubV4(settings, token, onProgress);
}

export async function loadAttemptHistory(settings: GitHubSettings, token: string, options: { month?: string; questionId?: string } = {}) {
  return loadAttemptHistoryV4(settings, token, options);
}

export async function verifyGitHubVault(settings: GitHubSettings, token: string) {
  return verifyGitHubVaultV4(settings, token);
}

export async function initializeGitHubVault(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  return initializeGitHubVaultV4(settings, token, {}, onProgress);
}
