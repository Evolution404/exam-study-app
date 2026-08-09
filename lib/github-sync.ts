import {
  applyRemoteEvents,
  applySyncCheckpoint,
  applySyncSnapshot,
  createSyncCheckpoint,
  db,
  getDeviceId,
  nextSyncSequence,
  resetLocalDatabase,
  validateSyncCheckpoint,
  validateSyncSnapshot,
} from "./db";
import type {
  Attempt, GitHubSettings, PracticeRun, SyncArchiveCatalogV3, SyncArchiveSegmentV3,
  SyncCheckpointV3, SyncEvent, SyncManifestV2, SyncManifestV3, SyncSnapshotV2,
} from "./types";
import { calendarDate } from "./practice-metrics";

const api = "https://api.github.com";
const manifestPath = "sync/manifest.json";
const v3EventPrefix = "sync/v3/events/";
const v3CatalogPath = "sync/v3/archive/catalog.json";
const uploadBatchSize = 250;
const uploadByteLimit = 2 * 1024 * 1024;
const eventPageByteLimit = 256 * 1024;
const downloadByteLimit = 4 * 1024 * 1024;
const downloadConcurrency = 4;
const compactionFileThreshold = 10;
const archiveSegmentSize = 500;
const remoteCachePrefix = "__local_remote_cache__/";

export interface SyncProgress {
  phase: "prepare" | "download" | "merge" | "upload" | "compact" | "cache" | "history" | "complete";
  label: string;
  percent: number;
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

function reportProgress(onProgress: SyncProgressCallback | undefined, phase: SyncProgress["phase"], label: string, percent: number) {
  onProgress?.({ phase, label, percent: Math.max(0, Math.min(100, Math.round(percent))) });
}

function progressRange(onProgress: SyncProgressCallback | undefined, start: number, end: number): SyncProgressCallback | undefined {
  if (!onProgress) return undefined;
  return (progress) => reportProgress(onProgress, progress.phase, progress.label, start + (end - start) * progress.percent / 100);
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface DownloadedEventFile {
  path: string;
  sha: string;
  events: SyncEvent[];
}

interface RemotePackageV2 {
  formatVersion: 2;
  manifest: SyncManifestV2;
  manifestSha: string;
  snapshot?: SyncSnapshotV2;
  snapshotPath: string;
  snapshotSha: string;
  eventFiles: DownloadedEventFile[];
}

interface RemotePackageV3 {
  formatVersion: 3;
  manifest: SyncManifestV3;
  manifestSha: string;
  checkpoint?: SyncCheckpointV3;
  checkpointPath: string;
  checkpointSha: string;
  eventFiles: DownloadedEventFile[];
  deferredEventFiles: number;
}

function remoteCachePath(settings: GitHubSettings) {
  return `${remoteCachePrefix}${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/${encodeURIComponent(settings.branch || "main")}`;
}

async function cacheCurrentRemoteState(settings: GitHubSettings) {
  const snapshot = await createSyncCheckpoint();
  validateSyncCheckpoint(snapshot);
  const cachedAt = new Date().toISOString();
  const path = remoteCachePath(settings);
  const markers = (await db.syncFiles.toArray())
    .filter((file) => !file.path.startsWith(remoteCachePrefix))
    .map(({ path: markerPath, sha, appliedAt }) => ({ path: markerPath, sha, appliedAt }));
  await db.syncFiles.put({
    path,
    sha: `local-${snapshot.generatedAt}`,
    appliedAt: cachedAt,
    remoteCache: {
      owner: settings.owner,
      repo: settings.repo,
      branch: settings.branch || "main",
      cachedAt,
      snapshot,
      markers,
    },
  });
  return { cachedAt, counts: snapshot.counts };
}

async function createLocalBackup() {
  const [banks, bankFolders, questions, attempts, attemptStats, attemptDailyStats, notes, practiceRuns,
    practiceRunStats, questionGroups, events, syncFiles, tombstones, sessions, syncMeta] = await Promise.all([
    db.banks.toArray(), db.bankFolders.toArray(), db.questions.toArray(), db.attempts.toArray(),
    db.attemptStats.toArray(), db.attemptDailyStats.toArray(), db.notes.toArray(), db.practiceRuns.toArray(),
    db.practiceRunStats.toArray(), db.questionGroups.toArray(), db.events.toArray(), db.syncFiles.toArray(),
    db.tombstones.toArray(), db.sessions.toArray(), db.syncMeta.toArray(),
  ]);
  return {
    banks, bankFolders, questions, attempts, attemptStats, attemptDailyStats, notes, practiceRuns,
    practiceRunStats, questionGroups, events, syncFiles, tombstones, sessions, syncMeta,
  };
}

async function restoreLocalBackup(backup: Awaited<ReturnType<typeof createLocalBackup>>) {
  await resetLocalDatabase();
  await Promise.all([
    db.banks.bulkPut(backup.banks), db.bankFolders.bulkPut(backup.bankFolders), db.questions.bulkPut(backup.questions),
    db.attempts.bulkPut(backup.attempts), db.attemptStats.bulkPut(backup.attemptStats),
    db.attemptDailyStats.bulkPut(backup.attemptDailyStats), db.notes.bulkPut(backup.notes),
    db.practiceRuns.bulkPut(backup.practiceRuns), db.practiceRunStats.bulkPut(backup.practiceRunStats),
    db.questionGroups.bulkPut(backup.questionGroups), db.events.bulkPut(backup.events),
    db.syncFiles.bulkPut(backup.syncFiles), db.tombstones.bulkPut(backup.tombstones),
    db.sessions.bulkPut(backup.sessions), db.syncMeta.bulkPut(backup.syncMeta),
  ]);
}

export async function getLastRemoteCache(settings: GitHubSettings) {
  const cached = (await db.syncFiles.get(remoteCachePath(settings)))?.remoteCache;
  if (!cached) return null;
  validateSyncCheckpoint(cached.snapshot);
  return { cachedAt: cached.cachedAt, counts: cached.snapshot.counts };
}

export async function restoreLastRemoteCache(settings: GitHubSettings, onProgress?: SyncProgressCallback) {
  reportProgress(onProgress, "prepare", "正在检查本地恢复记录", 5);
  const cacheFile = await db.syncFiles.get(remoteCachePath(settings));
  const cached = cacheFile?.remoteCache;
  if (!cacheFile || !cached) throw new Error("本机还没有可恢复的远程缓存，请先成功同步一次。");
  validateSyncCheckpoint(cached.snapshot);
  reportProgress(onProgress, "prepare", "正在保护当前本地数据", 20);
  const backup = await createLocalBackup();
  try {
    reportProgress(onProgress, "merge", "正在重建题库和学习记录", 48);
    await applySyncCheckpoint(cached.snapshot);
    reportProgress(onProgress, "merge", "正在恢复同步标记", 82);
    await db.syncFiles.bulkPut([
      ...cached.markers,
      cacheFile,
    ]);
    reportProgress(onProgress, "complete", "本地记录恢复完成", 100);
    return { cachedAt: cached.cachedAt, counts: cached.snapshot.counts, formatVersion: 3 as const };
  } catch (error) {
    reportProgress(onProgress, "merge", "恢复失败，正在还原原有数据", 90);
    await restoreLocalBackup(backup);
    throw error;
  }
}

function headers(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function encodeBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function request<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...headers(token), ...(init?.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<T>;
}

function contentUrl(settings: GitHubSettings, path: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${api}/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}`;
}

async function readBlob(settings: GitHubSettings, token: string, sha: string) {
  const file = await request<{ content: string }>(`${api}/repos/${settings.owner}/${settings.repo}/git/blobs/${sha}`, token);
  return decodeBase64(file.content);
}

async function getTree(settings: GitHubSettings, token: string) {
  const branch = settings.branch || "main";
  const tree = await request<{ tree: TreeEntry[]; truncated?: boolean }>(
    `${api}/repos/${settings.owner}/${settings.repo}/git/trees/${branch}?recursive=1`,
    token,
  );
  if (tree.truncated) throw new Error("远程仓库文件树过大，GitHub 返回了不完整结果，已停止同步。");
  return tree.tree;
}

async function getHeadTree(settings: GitHubSettings, token: string) {
  const branch = settings.branch || "main";
  const ref = await request<{ object: { sha: string } }>(
    `${api}/repos/${settings.owner}/${settings.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    token,
  );
  const commit = await request<{ tree: { sha: string } }>(
    `${api}/repos/${settings.owner}/${settings.repo}/git/commits/${ref.object.sha}`,
    token,
  );
  const response = await request<{ tree: TreeEntry[]; truncated?: boolean }>(
    `${api}/repos/${settings.owner}/${settings.repo}/git/trees/${commit.tree.sha}?recursive=1`,
    token,
  );
  if (response.truncated) throw new Error("远程仓库文件树过大，GitHub 返回了不完整结果，已停止同步。");
  return { headSha: ref.object.sha, treeSha: commit.tree.sha, tree: response.tree };
}

function validateEvents(value: unknown, path: string): SyncEvent[] {
  if (!Array.isArray(value)) throw new Error(`远程事件文件格式无效：${path}`);
  for (const event of value) {
    if (!event || typeof event !== "object" || typeof event.id !== "string" || typeof event.type !== "string"
      || typeof event.createdAt !== "string" || typeof event.deviceId !== "string") {
      throw new Error(`远程事件文件包含无效记录：${path}`);
    }
  }
  return value as SyncEvent[];
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function validateV3Events(value: unknown, path: string): SyncEvent[] {
  const events = validateEvents(value, path);
  if (events.some((event) => !Number.isSafeInteger(event.sequence) || event.sequence < 1)) {
    throw new Error(`远程 v3 事件文件包含无效设备序号：${path}`);
  }
  return events;
}

async function downloadRemotePackageV3(
  settings: GitHubSettings,
  token: string,
  tree: TreeEntry[],
  manifestEntry: TreeEntry,
  onlyUnseen = false,
  onProgress?: SyncProgressCallback,
): Promise<RemotePackageV3> {
  reportProgress(onProgress, "download", "正在读取远程同步清单", 0);
  const manifestText = await readBlob(settings, token, manifestEntry.sha);
  const manifest = JSON.parse(manifestText) as SyncManifestV3;
  if (manifest.formatVersion !== 3 || !manifest.checkpoint?.path || !manifest.checkpoint.sha256
    || manifest.eventPrefix !== v3EventPrefix || manifest.archiveCatalog?.path !== v3CatalogPath || !manifest.archiveCatalog.sha256) {
    throw new Error("远程 v3 同步清单格式无效。");
  }
  const checkpointEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifest.checkpoint.path);
  if (!checkpointEntry) throw new Error("远程同步清单指向的 v3 检查点不存在。");
  reportProgress(onProgress, "download", "同步清单已验证", 16);
  let checkpoint: SyncCheckpointV3 | undefined;
  const seenCheckpoint = onlyUnseen ? await db.syncFiles.get(checkpointEntry.path) : undefined;
  if (!seenCheckpoint || seenCheckpoint.sha !== checkpointEntry.sha) {
    const checkpointText = await readBlob(settings, token, checkpointEntry.sha);
    if (await sha256(checkpointText) !== manifest.checkpoint.sha256) throw new Error("远程 v3 检查点校验失败，已停止同步。");
    const parsed = JSON.parse(checkpointText) as unknown;
    validateSyncCheckpoint(parsed);
    checkpoint = parsed;
  }
  reportProgress(onProgress, "download", checkpoint ? "远程检查点已下载" : "远程检查点没有变化", 42);
  const allEventEntries = tree
    .filter((entry) => entry.type === "blob" && entry.path.startsWith(manifest.eventPrefix) && entry.path.endsWith(".json"))
    .sort((a, b) => a.path.localeCompare(b.path));
  const unseenEntries: TreeEntry[] = [];
  for (const entry of allEventEntries) {
    const seen = onlyUnseen ? await db.syncFiles.get(entry.path) : undefined;
    if (!seen || seen.sha !== entry.sha) unseenEntries.push(entry);
  }
  const wantedEntries: TreeEntry[] = [];
  let selectedBytes = 0;
  for (const entry of unseenEntries) {
    if ((entry.size ?? 0) > eventPageByteLimit) throw new Error(`远程 v3 事件分页超过 256 KiB 上限：${entry.path}`);
    const size = Math.max(1, entry.size ?? eventPageByteLimit);
    if (wantedEntries.length && selectedBytes + size > downloadByteLimit) break;
    wantedEntries.push(entry);
    selectedBytes += size;
  }
  let downloadedEntries = 0;
  const eventFiles = await mapConcurrent(wantedEntries, downloadConcurrency, async (entry) => {
    const text = await readBlob(settings, token, entry.sha);
    if (new TextEncoder().encode(text).byteLength > eventPageByteLimit) {
      throw new Error(`远程 v3 事件分页超过 256 KiB 上限：${entry.path}`);
    }
    const downloaded = { path: entry.path, sha: entry.sha, events: validateV3Events(JSON.parse(text), entry.path) };
    downloadedEntries += 1;
    reportProgress(onProgress, "download", `正在下载增量记录 ${downloadedEntries}/${wantedEntries.length}`, 42 + 58 * downloadedEntries / Math.max(1, wantedEntries.length));
    return downloaded;
  });
  if (!wantedEntries.length) reportProgress(onProgress, "download", "没有新的远程增量", 100);
  return {
    formatVersion: 3,
    manifest,
    manifestSha: manifestEntry.sha,
    checkpoint,
    checkpointPath: checkpointEntry.path,
    checkpointSha: checkpointEntry.sha,
    eventFiles,
    deferredEventFiles: unseenEntries.length - wantedEntries.length,
  };
}

async function applyPackageV3(remote: RemotePackageV3, preserveLocal = true) {
  let pulled = 0;
  if (remote.checkpoint) {
    const [pending, sessions, previousFiles] = preserveLocal
      ? await Promise.all([db.events.where("synced").equals(0).toArray(), db.sessions.toArray(), db.syncFiles.toArray()])
      : [[], [], []];
    await applySyncCheckpoint(remote.checkpoint);
    const replay = pending.filter((event) => event.sequence > (remote.checkpoint!.cursors[event.deviceId] ?? 0));
    if (replay.length) {
      await applyRemoteEvents(replay);
      await db.events.bulkPut(replay.map((event) => ({ ...event, synced: 0 as const })));
    }
    for (const session of sessions) {
      const exists = await db.questions.bulkGet(session.questionIds);
      if (exists.every(Boolean)) await db.sessions.put(session);
    }
    if (previousFiles.length) await db.syncFiles.bulkPut(previousFiles);
    await db.syncFiles.put({ path: remote.checkpointPath, sha: remote.checkpointSha, appliedAt: new Date().toISOString() });
    pulled += remote.checkpoint.counts.banks + remote.checkpoint.counts.bankFolders + remote.checkpoint.counts.questions
      + remote.checkpoint.counts.recentAttempts + remote.checkpoint.counts.notes + remote.checkpoint.counts.recentPracticeRuns
      + remote.checkpoint.counts.questionGroups + remote.checkpoint.counts.tombstones;
  }
  const checkpointCursors = remote.checkpoint?.cursors ?? {};
  const events = remote.eventFiles.flatMap((file) => file.events)
    .filter((event) => event.sequence > (checkpointCursors[event.deviceId] ?? 0));
  if (events.length) await applyRemoteEvents(events);
  for (const file of remote.eventFiles) {
    await db.syncFiles.put({ path: file.path, sha: file.sha, appliedAt: new Date().toISOString() });
    pulled += file.events.length;
  }
  await db.syncFiles.put({ path: manifestPath, sha: remote.manifestSha, appliedAt: new Date().toISOString() });
  return pulled;
}

async function downloadRemotePackageV2(settings: GitHubSettings, token: string, onlyUnseen = false): Promise<RemotePackageV2 | null> {
  const tree = await getTree(settings, token);
  const manifestEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifestPath);
  if (!manifestEntry) {
    if (tree.some((entry) => entry.type === "blob" && /^events\/.+\.json$/.test(entry.path))) {
      throw new Error("远程仓库仍是旧版同步格式，当前客户端仅支持 v2 资料库。");
    }
    return null;
  }
  {
    const manifestText = await readBlob(settings, token, manifestEntry.sha);
    const manifest = JSON.parse(manifestText) as SyncManifestV2;
    if (manifest.formatVersion !== 2 || !manifest.snapshot?.path || !manifest.snapshot.sha256 || !manifest.eventPrefix) {
      throw new Error("远程同步清单格式无效。");
    }
    const snapshotEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifest.snapshot.path);
    if (!snapshotEntry) throw new Error("远程同步清单指向的快照不存在。");
    let snapshot: SyncSnapshotV2 | undefined;
    const seenSnapshot = onlyUnseen ? await db.syncFiles.get(snapshotEntry.path) : undefined;
    if (!seenSnapshot || seenSnapshot.sha !== snapshotEntry.sha) {
      const snapshotText = await readBlob(settings, token, snapshotEntry.sha);
      if (await sha256(snapshotText) !== manifest.snapshot.sha256) throw new Error("远程快照校验失败，已停止同步。");
      const parsed = JSON.parse(snapshotText) as unknown;
      validateSyncSnapshot(parsed);
      snapshot = parsed;
    }
    const eventEntries = tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(manifest.eventPrefix) && entry.path.endsWith(".json"));
    const wantedEntries: TreeEntry[] = [];
    for (const entry of eventEntries) {
      const seen = onlyUnseen ? await db.syncFiles.get(entry.path) : undefined;
      if (!seen || seen.sha !== entry.sha) wantedEntries.push(entry);
    }
    const eventFiles = await mapConcurrent(wantedEntries, downloadConcurrency, async (entry) => ({
      path: entry.path,
      sha: entry.sha,
      events: validateEvents(JSON.parse(await readBlob(settings, token, entry.sha)), entry.path),
    }));
    return {
      formatVersion: 2, manifest, manifestSha: manifestEntry.sha, snapshot,
      snapshotPath: snapshotEntry.path, snapshotSha: snapshotEntry.sha, eventFiles,
    };
  }

}

async function applyPackageV2(remote: RemotePackageV2, replace = false) {
  let pulled = 0;
  if (remote.snapshot) {
    await applySyncSnapshot(remote.snapshot, replace);
    pulled += Object.values(remote.snapshot.counts).reduce((sum, count) => sum + count, 0);
    if (remote.snapshotPath && remote.snapshotSha) {
      await db.syncFiles.put({ path: remote.snapshotPath, sha: remote.snapshotSha, appliedAt: new Date().toISOString() });
    }
  }
  const events = remote.eventFiles.flatMap((file) => file.events);
  if (events.length) await applyRemoteEvents(events);
  for (const file of remote.eventFiles) {
    await db.syncFiles.put({ path: file.path, sha: file.sha, appliedAt: new Date().toISOString() });
    pulled += file.events.length;
  }
  if (remote.manifestSha) await db.syncFiles.put({ path: manifestPath, sha: remote.manifestSha, appliedAt: new Date().toISOString() });
  return pulled;
}

function takeEventPage(events: SyncEvent[]) {
  const page: SyncEvent[] = [];
  for (const event of events.slice(0, uploadBatchSize)) {
    const candidate = [...page, event];
    const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
    if (candidateBytes > eventPageByteLimit) {
      if (!page.length) throw new Error("单条同步事件超过 256 KiB 上限，请缩小该条题库变更后重试。");
      break;
    }
    page.push(event);
  }
  return page;
}

async function uploadPendingEventsV3(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  const branch = settings.branch || "main";
  let pushed = 0;
  let uploadedBytes = 0;
  let reportedPercent = 0;
  const initialPending = await db.events.where("synced").equals(0).count();
  reportProgress(onProgress, "upload", initialPending ? `准备上传 ${initialPending} 条本地更改` : "没有待上传的本地更改", 0);
  for (;;) {
    let pending = await db.events.where("synced").equals(0).limit(uploadBatchSize).toArray();
    if (!pending.length) break;
    const repaired = pending.map((event) => Number.isSafeInteger(event.sequence) && event.sequence > 0
      ? event
      : { ...event, deviceId: event.deviceId || getDeviceId(), sequence: nextSyncSequence(event.deviceId || getDeviceId()) });
    if (repaired.some((event, index) => event !== pending[index])) {
      await db.events.bulkPut(repaired);
      pending = repaired;
    }
    const page = takeEventPage(pending);
    const content = JSON.stringify(page);
    const bytes = new TextEncoder().encode(content).byteLength;
    if (pushed && uploadedBytes + bytes > uploadByteLimit) break;
    const digest = await sha256(content);
    const month = /^\d{4}-\d{2}/.test(page[0].createdAt) ? page[0].createdAt.slice(0, 7) : new Date().toISOString().slice(0, 7);
    const device = page[0].deviceId.replace(/[^a-zA-Z0-9._-]/g, "_") || "device";
    const path = `${v3EventPrefix}${device}/${month}/${digest}.json`;
    let uploaded: { content: { sha: string } };
    try {
      uploaded = await request<{ content: { sha: string } }>(contentUrl(settings, path), token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `sync: ${page.length} v3 study events`, content: encodeBase64(content), branch }),
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("GitHub 422")) throw error;
      const existing = await request<{ sha: string; content: string }>(
        `${contentUrl(settings, path)}?ref=${encodeURIComponent(branch)}`,
        token,
      );
      const existingText = decodeBase64(existing.content);
      if (await sha256(existingText) !== digest) throw new Error(`远程事件分页路径冲突：${path}`);
      uploaded = { content: { sha: existing.sha } };
    }
    await db.syncFiles.put({ path, sha: uploaded.content.sha, appliedAt: new Date().toISOString() });
    await db.events.bulkPut(page.map((event) => ({ ...event, synced: 1 as const })));
    pushed += page.length;
    uploadedBytes += bytes;
    const remaining = await db.events.where("synced").equals(0).count();
    const total = Math.max(initialPending, pushed + remaining, 1);
    reportedPercent = Math.max(reportedPercent, remaining ? Math.min(95, pushed / total * 100) : 100);
    reportProgress(onProgress, "upload", remaining ? `已上传 ${pushed} 条，还有 ${remaining} 条待处理` : `已上传 ${pushed} 条本地更改`, reportedPercent);
  }
  const remaining = await db.events.where("synced").equals(0).count();
  reportProgress(onProgress, "upload", remaining ? `本轮上传达到上限，剩余 ${remaining} 条` : "本地更改上传完成", remaining ? Math.max(reportedPercent, 95) : 100);
  return { pushed, uploadedBytes, remaining };
}

async function createGitBlob(settings: GitHubSettings, token: string, content: string) {
  const blob = await request<{ sha: string }>(`${api}/repos/${settings.owner}/${settings.repo}/git/blobs`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, encoding: "utf-8" }),
  });
  return blob.sha;
}

interface PendingArchiveSegment {
  meta: SyncArchiveSegmentV3;
  content: string;
}

async function buildArchiveSegments<T extends { id: string }>(
  kind: "attempts" | "practice-runs",
  rows: T[],
  getTimestamp: (row: T) => string,
) {
  const grouped = new Map<string, T[]>();
  for (const row of [...rows].sort((a, b) => getTimestamp(a).localeCompare(getTimestamp(b)) || a.id.localeCompare(b.id))) {
    const month = getTimestamp(row).slice(0, 7);
    grouped.set(month, [...(grouped.get(month) ?? []), row]);
  }
  const segments: PendingArchiveSegment[] = [];
  for (const [month, monthRows] of grouped) {
    for (let offset = 0; offset < monthRows.length; offset += archiveSegmentSize) {
      const chunk = monthRows.slice(offset, offset + archiveSegmentSize);
      const content = JSON.stringify({ formatVersion: 3, kind, rows: chunk });
      const digest = await sha256(content);
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      segments.push({
        content,
        meta: {
          path: `sync/v3/archive/${kind}/${month}/${digest.slice(0, 24)}.json`,
          sha256: digest,
          month,
          count: chunk.length,
          firstId: first.id,
          lastId: last.id,
          firstCreatedAt: getTimestamp(first),
          lastCreatedAt: getTimestamp(last),
        },
      });
    }
  }
  return segments;
}

async function readV3Catalog(settings: GitHubSettings, token: string, tree: TreeEntry[], manifest?: SyncManifestV3) {
  if (!manifest) {
    return {
      formatVersion: 3,
      generatedAt: new Date().toISOString(),
      attemptSegments: [],
      practiceRunSegments: [],
      counts: { attempts: 0, practiceRuns: 0 },
    } satisfies SyncArchiveCatalogV3;
  }
  const entry = tree.find((item) => item.type === "blob" && item.path === manifest.archiveCatalog.path);
  if (!entry) throw new Error("远程 v3 历史目录不存在。");
  const text = await readBlob(settings, token, entry.sha);
  if (await sha256(text) !== manifest.archiveCatalog.sha256) throw new Error("远程 v3 历史目录校验失败。");
  const catalog = JSON.parse(text) as SyncArchiveCatalogV3;
  if (catalog.formatVersion !== 3 || !Array.isArray(catalog.attemptSegments) || !Array.isArray(catalog.practiceRunSegments)) {
    throw new Error("远程 v3 历史目录格式无效。");
  }
  const validateSegments = (segments: SyncArchiveSegmentV3[], kind: "attempts" | "practice-runs") => segments.every((segment) =>
    segment.path.startsWith(`sync/v3/archive/${kind}/`) && segment.path.endsWith(".json")
    && /^[a-f0-9]{64}$/.test(segment.sha256) && /^\d{4}-\d{2}$/.test(segment.month)
    && Number.isSafeInteger(segment.count) && segment.count > 0 && segment.count <= archiveSegmentSize
    && typeof segment.firstId === "string" && typeof segment.lastId === "string"
    && typeof segment.firstCreatedAt === "string" && typeof segment.lastCreatedAt === "string");
  const paths = [...catalog.attemptSegments, ...catalog.practiceRunSegments].map((segment) => segment.path);
  if (!catalog.counts || catalog.counts.attempts !== catalog.attemptSegments.reduce((sum, segment) => sum + segment.count, 0)
    || catalog.counts.practiceRuns !== catalog.practiceRunSegments.reduce((sum, segment) => sum + segment.count, 0)
    || !validateSegments(catalog.attemptSegments, "attempts") || !validateSegments(catalog.practiceRunSegments, "practice-runs")
    || new Set(paths).size !== paths.length) {
    throw new Error("远程 v3 历史目录统计或分段元数据无效。");
  }
  return catalog;
}

async function compactGitHubVaultV3(
  settings: GitHubSettings,
  token: string,
  options: { force?: boolean; removeLegacy?: boolean } = {},
) {
  const head = await getHeadTree(settings, token);
  const tree = head.tree;
  const eventEntries = tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(v3EventPrefix) && entry.path.endsWith(".json"));
  if (!options.force && eventEntries.length < compactionFileThreshold) return { compacted: false };
  for (const entry of eventEntries) {
    if ((await db.syncFiles.get(entry.path))?.sha !== entry.sha) return { compacted: false };
  }
  const manifestEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifestPath);
  let previousManifest: SyncManifestV3 | undefined;
  if (manifestEntry) {
    const parsed = JSON.parse(await readBlob(settings, token, manifestEntry.sha)) as SyncManifestV3 | SyncManifestV2;
    if (parsed.formatVersion === 3) previousManifest = parsed;
  }
  const catalog = await readV3Catalog(settings, token, tree, previousManifest);
  const checkpoint = await createSyncCheckpoint();
  const recentAttemptIds = new Set(checkpoint.state.recentAttempts.map((attempt) => attempt.id));
  const recentRunIds = new Set(checkpoint.state.recentPracticeRuns.map((run) => run.id));
  const priorAttemptIds = new Set((await db.syncMeta.get("archive-index:attempts"))?.value as string[] ?? []);
  const priorRunIds = new Set((await db.syncMeta.get("archive-index:practice-runs"))?.value as string[] ?? []);
  if (options.force && !catalog.attemptSegments.length) priorAttemptIds.clear();
  if (options.force && !catalog.practiceRunSegments.length) priorRunIds.clear();
  const attemptsToArchive = (await db.attempts.toArray())
    .filter((attempt) => !recentAttemptIds.has(attempt.id) && !priorAttemptIds.has(attempt.id));
  const runsToArchive = (await db.practiceRuns.toArray())
    .filter((run) => !recentRunIds.has(run.id) && !priorRunIds.has(run.id));
  const [attemptSegments, runSegments] = await Promise.all([
    buildArchiveSegments("attempts", attemptsToArchive, (attempt) => attempt.createdAt),
    buildArchiveSegments("practice-runs", runsToArchive, (run) => run.updatedAt),
  ]);
  const generatedAt = checkpoint.generatedAt;
  const nextCatalog: SyncArchiveCatalogV3 = {
    formatVersion: 3,
    generatedAt,
    attemptSegments: [...catalog.attemptSegments, ...attemptSegments.map((segment) => segment.meta)],
    practiceRunSegments: [...catalog.practiceRunSegments, ...runSegments.map((segment) => segment.meta)],
    counts: {
      attempts: catalog.counts.attempts + attemptsToArchive.length,
      practiceRuns: catalog.counts.practiceRuns + runsToArchive.length,
    },
  };
  const checkpointText = JSON.stringify(checkpoint);
  const checkpointPath = `sync/v3/checkpoints/${generatedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`;
  const catalogText = JSON.stringify(nextCatalog);
  const manifest: SyncManifestV3 = {
    formatVersion: 3,
    generatedAt,
    checkpoint: { path: checkpointPath, sha256: await sha256(checkpointText) },
    eventPrefix: v3EventPrefix,
    archiveCatalog: { path: v3CatalogPath, sha256: await sha256(catalogText) },
  };
  const archiveBlobs = await mapConcurrent([...attemptSegments, ...runSegments], downloadConcurrency, async (segment) => ({
    path: segment.meta.path,
    sha: await createGitBlob(settings, token, segment.content),
  }));
  const [checkpointBlob, catalogBlob, manifestBlob] = await Promise.all([
    createGitBlob(settings, token, checkpointText),
    createGitBlob(settings, token, catalogText),
    createGitBlob(settings, token, JSON.stringify(manifest, null, 2)),
  ]);
  const branch = settings.branch || "main";
  const deletePaths = new Set<string>(eventEntries.map((entry) => entry.path));
  if (previousManifest?.checkpoint.path && previousManifest.checkpoint.path !== checkpointPath) deletePaths.add(previousManifest.checkpoint.path);
  if (options.removeLegacy) {
    for (const entry of tree) {
      if (entry.type === "blob" && (entry.path.startsWith("events/v2/") || entry.path.startsWith("snapshots/v2/") || /^events\/(?!v2\/).+\.json$/.test(entry.path))) deletePaths.add(entry.path);
    }
  }
  const newTree = await request<{ sha: string }>(`${api}/repos/${settings.owner}/${settings.repo}/git/trees`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: head.treeSha,
      tree: [
        ...archiveBlobs.map((blob) => ({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha })),
        { path: checkpointPath, mode: "100644", type: "blob", sha: checkpointBlob },
        { path: v3CatalogPath, mode: "100644", type: "blob", sha: catalogBlob },
        { path: manifestPath, mode: "100644", type: "blob", sha: manifestBlob },
        ...[...deletePaths].filter((path) => tree.some((entry) => entry.path === path)).map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
      ],
    }),
  });
  const newCommit = await request<{ sha: string }>(`${api}/repos/${settings.owner}/${settings.repo}/git/commits`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: options.removeLegacy ? "sync: migrate vault to protocol v3" : "sync: compact v3 event pages", tree: newTree.sha, parents: [head.headSha] }),
  });
  try {
    await request(`${api}/repos/${settings.owner}/${settings.repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("GitHub 422")) return { compacted: false };
    throw error;
  }
  await db.syncFiles.bulkDelete([...deletePaths]);
  await db.syncFiles.bulkPut([
    { path: checkpointPath, sha: checkpointBlob, appliedAt: generatedAt },
    { path: v3CatalogPath, sha: catalogBlob, appliedAt: generatedAt },
    { path: manifestPath, sha: manifestBlob, appliedAt: generatedAt },
  ]);
  if (options.force) await db.events.clear();
  else {
    const syncedIds = (await db.events.where("synced").equals(1).primaryKeys()) as string[];
    if (syncedIds.length) await db.events.bulkDelete(syncedIds);
  }
  await db.syncMeta.bulkPut([
    { key: "archive-index:attempts", value: [...priorAttemptIds, ...attemptsToArchive.map((attempt) => attempt.id)], updatedAt: generatedAt },
    { key: "archive-index:practice-runs", value: [...priorRunIds, ...runsToArchive.map((run) => run.id)], updatedAt: generatedAt },
  ]);
  if (attemptsToArchive.length) await db.attempts.bulkDelete(attemptsToArchive.map((attempt) => attempt.id));
  if (runsToArchive.length) await db.practiceRuns.bulkDelete(runsToArchive.map((run) => run.id));
  const dailyCutoff = new Date();
  dailyCutoff.setDate(dailyCutoff.getDate() - 34);
  await db.attemptDailyStats.where("date").below(calendarDate(dailyCutoff)).delete();
  return { compacted: true };
}

export async function getGitHubLogin(token: string) {
  const user = await request<{ login: string }>(`${api}/user`, token);
  return user.login;
}

export async function verifyGitHubVault(settings: GitHubSettings, token: string) {
  const tree = await getTree(settings, token);
  const entry = tree.find((item) => item.type === "blob" && item.path === manifestPath);
  if (!entry) return 0;
  const manifest = JSON.parse(await readBlob(settings, token, entry.sha)) as { formatVersion?: number };
  return manifest.formatVersion === 3 ? 3 : manifest.formatVersion === 2 ? 2 : 0;
}

async function migrateV2Vault(settings: GitHubSettings, token: string) {
  const pendingBefore = await db.events.where("synced").equals(0).count();
  const remote = await downloadRemotePackageV2(settings, token, false);
  if (!remote) throw new Error("没有找到可迁移的 v2 资料库。");
  const pulled = await applyPackageV2(remote);
  const compaction = await compactGitHubVaultV3(settings, token, { force: true, removeLegacy: true });
  if (!compaction.compacted) throw new Error("远程资料库正在被其他设备更新，本次 v3 迁移未提交，请重新同步。");
  return { pulled, pushed: pendingBefore };
}

export async function syncWithGitHub(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  reportProgress(onProgress, "prepare", "正在连接 GitHub", 3);
  const tree = await getTree(settings, token);
  reportProgress(onProgress, "prepare", "远程资料库已连接", 10);
  const manifestEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifestPath);
  if (!manifestEntry) {
    const included = await db.events.where("synced").equals(0).count();
    reportProgress(onProgress, "compact", "正在创建首个远程检查点", 42);
    const initialized = await compactGitHubVaultV3(settings, token, { force: true, removeLegacy: true });
    if (!initialized.compacted) throw new Error("远程资料库初始化发生并发冲突，请重新同步。");
    reportProgress(onProgress, "cache", "正在保存本地恢复点", 92);
    const cache = await cacheCurrentRemoteState(settings);
    reportProgress(onProgress, "complete", "同步完成", 100);
    return { pulled: 0, pushed: included, remaining: 0, deferred: 0, formatVersion: 3 as const, compacted: true, migrated: false, cachedAt: cache.cachedAt };
  }
  const manifestVersion = (JSON.parse(await readBlob(settings, token, manifestEntry.sha)) as { formatVersion?: number }).formatVersion;
  if (manifestVersion === 2) {
    reportProgress(onProgress, "merge", "正在将云端资料库升级到 v3", 28);
    const migrated = await migrateV2Vault(settings, token);
    reportProgress(onProgress, "cache", "正在保存本地恢复点", 92);
    const cache = await cacheCurrentRemoteState(settings);
    reportProgress(onProgress, "complete", "同步和升级完成", 100);
    return { ...migrated, remaining: 0, deferred: 0, formatVersion: 3 as const, compacted: true, migrated: true, cachedAt: cache.cachedAt };
  }
  if (manifestVersion !== 3) throw new Error("远程同步清单版本不受支持。");
  const remote = await downloadRemotePackageV3(settings, token, tree, manifestEntry, true, progressRange(onProgress, 14, 44));
  reportProgress(onProgress, "merge", "正在合并远程更改", 48);
  const pulled = await applyPackageV3(remote);
  reportProgress(onProgress, "merge", "远程更改合并完成", 54);
  const upload = await uploadPendingEventsV3(settings, token, progressRange(onProgress, 56, 78));
  let compacted = false;
  if (!remote.deferredEventFiles && !upload.remaining) {
    reportProgress(onProgress, "compact", "正在整理远程检查点", 82);
    compacted = (await compactGitHubVaultV3(settings, token)).compacted;
  }
  let cache: Awaited<ReturnType<typeof cacheCurrentRemoteState>> | null = null;
  if (!remote.deferredEventFiles && !upload.remaining) {
    reportProgress(onProgress, "cache", "正在保存本地恢复点", 94);
    cache = await cacheCurrentRemoteState(settings);
  }
  reportProgress(onProgress, "complete", upload.remaining ? `本轮同步完成，剩余 ${upload.remaining} 条待上传` : "同步完成", 100);
  return {
    pulled, pushed: upload.pushed, remaining: upload.remaining, deferred: remote.deferredEventFiles,
    formatVersion: 3 as const, compacted, migrated: false, cachedAt: cache?.cachedAt,
  };
}

async function restoreQuickFromGitHub(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  reportProgress(onProgress, "prepare", "正在连接远程资料库", 3);
  let tree = await getTree(settings, token);
  reportProgress(onProgress, "prepare", "远程资料库已连接", 10);
  let manifestEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifestPath);
  if (!manifestEntry) throw new Error("远程仓库中没有可恢复的同步记录，已保留本地数据。");
  const version = (JSON.parse(await readBlob(settings, token, manifestEntry.sha)) as { formatVersion?: number }).formatVersion;
  if (version === 2) {
    await migrateV2Vault(settings, token);
    tree = await getTree(settings, token);
    manifestEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifestPath);
  }
  if (!manifestEntry) throw new Error("v3 迁移后未找到远程同步清单。");
  const remote = await downloadRemotePackageV3(settings, token, tree, manifestEntry, false, progressRange(onProgress, 14, 68));
  if (!remote.checkpoint) throw new Error("远程仓库中没有可恢复的 v3 检查点，已保留本地数据。");
  reportProgress(onProgress, "merge", "正在重建本地题库和近期记录", 72);
  const pulled = await applyPackageV3(remote, false);
  reportProgress(onProgress, "merge", "正在校验恢复后的本地数据", 86);
  const snapshot = await createSyncCheckpoint();
  validateSyncCheckpoint(snapshot);
  reportProgress(onProgress, "cache", "正在保存新的本地恢复点", 94);
  await cacheCurrentRemoteState(settings);
  reportProgress(onProgress, "complete", "快速恢复完成", 100);
  return { pulled, formatVersion: 3 as const, counts: snapshot.counts, deferred: remote.deferredEventFiles };
}

export async function restoreFromGitHub(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  reportProgress(onProgress, "prepare", "正在保护当前本地数据", 1);
  const backup = await createLocalBackup();
  try {
    return await restoreQuickFromGitHub(settings, token, progressRange(onProgress, 4, 100));
  } catch (error) {
    reportProgress(onProgress, "merge", "恢复失败，正在还原原有数据", 96);
    await restoreLocalBackup(backup);
    throw error;
  }
}

async function downloadArchiveRows<T>(
  settings: GitHubSettings,
  token: string,
  kind: "attempts" | "practice-runs",
  options: { month?: string; questionId?: string } = {},
  onProgress?: SyncProgressCallback,
) {
  const kindLabel = kind === "attempts" ? "作答历史" : "练习历史";
  reportProgress(onProgress, "history", `正在读取${kindLabel}目录`, 0);
  const tree = await getTree(settings, token);
  const manifestEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifestPath);
  if (!manifestEntry) throw new Error("远程 v3 同步清单不存在。");
  const manifest = JSON.parse(await readBlob(settings, token, manifestEntry.sha)) as SyncManifestV3;
  if (manifest.formatVersion !== 3) throw new Error("历史记录按需下载只支持 v3 资料库。");
  const catalog = await readV3Catalog(settings, token, tree, manifest);
  const allSegments = kind === "attempts" ? catalog.attemptSegments : catalog.practiceRunSegments;
  const segments = options.month ? allSegments.filter((segment) => segment.month === options.month) : allSegments;
  let downloadedSegments = 0;
  const rows = (await mapConcurrent(segments, downloadConcurrency, async (segment) => {
    const entry = tree.find((item) => item.type === "blob" && item.path === segment.path);
    if (!entry) throw new Error(`远程历史分段不存在：${segment.path}`);
    const text = await readBlob(settings, token, entry.sha);
    if (await sha256(text) !== segment.sha256) throw new Error(`远程历史分段校验失败：${segment.path}`);
    const payload = JSON.parse(text) as { formatVersion?: number; kind?: string; rows?: T[] };
    if (payload.formatVersion !== 3 || payload.kind !== kind || !Array.isArray(payload.rows)) throw new Error(`远程历史分段格式无效：${segment.path}`);
    downloadedSegments += 1;
    reportProgress(onProgress, "history", `正在下载${kindLabel} ${downloadedSegments}/${segments.length}`, downloadedSegments / Math.max(1, segments.length) * 100);
    return payload.rows;
  })).flat();
  if (!segments.length) reportProgress(onProgress, "history", `没有需要下载的${kindLabel}`, 100);
  const filtered = kind === "attempts" && options.questionId
    ? (rows as Attempt[]).filter((attempt) => attempt.questionId === options.questionId) as T[]
    : rows;
  return { rows: filtered, segments: segments.length };
}

export async function loadAttemptHistory(
  settings: GitHubSettings,
  token: string,
  options: { month?: string; questionId?: string } = {},
) {
  const result = await downloadArchiveRows<Attempt>(settings, token, "attempts", options);
  if (result.rows.length) await db.attempts.bulkPut(result.rows);
  const archived = new Set((await db.syncMeta.get("archive-index:attempts"))?.value as string[] ?? []);
  result.rows.forEach((attempt) => archived.add(attempt.id));
  await db.syncMeta.put({ key: "archive-index:attempts", value: [...archived], updatedAt: new Date().toISOString() });
  return { loaded: result.rows.length, segments: result.segments };
}

export async function restoreFullHistoryFromGitHub(settings: GitHubSettings, token: string, onProgress?: SyncProgressCallback) {
  reportProgress(onProgress, "prepare", "正在保护当前本地数据", 1);
  const backup = await createLocalBackup();
  try {
    const quick = await restoreQuickFromGitHub(settings, token, progressRange(onProgress, 3, 62));
    const attemptHistory = await downloadArchiveRows<Attempt>(settings, token, "attempts", {}, progressRange(onProgress, 64, 82));
    const runHistory = await downloadArchiveRows<PracticeRun>(settings, token, "practice-runs", {}, progressRange(onProgress, 82, 94));
    reportProgress(onProgress, "merge", "正在写入全部历史记录", 96);
    await db.transaction("rw", [db.attempts, db.practiceRuns], async () => {
      if (attemptHistory.rows.length) await db.attempts.bulkPut(attemptHistory.rows);
      if (runHistory.rows.length) await db.practiceRuns.bulkPut(runHistory.rows);
    });
    const now = new Date().toISOString();
    await db.syncMeta.bulkPut([
      { key: "archive-index:attempts", value: [...new Set(attemptHistory.rows.map((attempt) => attempt.id))], updatedAt: now },
      { key: "archive-index:practice-runs", value: [...new Set(runHistory.rows.map((run) => run.id))], updatedAt: now },
    ]);
    reportProgress(onProgress, "complete", "完整恢复完成", 100);
    return {
      ...quick,
      archivedAttempts: attemptHistory.rows.length,
      archivedPracticeRuns: runHistory.rows.length,
    };
  } catch (error) {
    reportProgress(onProgress, "merge", "恢复失败，正在还原原有数据", 97);
    await restoreLocalBackup(backup);
    throw error;
  }
}
