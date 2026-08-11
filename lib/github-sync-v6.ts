/** Public Sync v6 orchestration.
 *
 * The only mutable remote object is sync/v6/head.json.  Every other write is
 * content addressed and immutable.  This module deliberately imports only
 * v6 DB/protocol modules; the legacy v5 implementation remains available to
 * migration code but is not on the production path.
 */
import {
  clearImageCacheV6,
  dbV6,
  getImageAssetBlobV6,
  getImageAssetDescriptorV6,
  putImageAssetBlobV6,
} from "./db-v6";
import {
  createSyncCheckpointV6,
  createSyncV6ArchiveCatalog,
  encodeSyncCheckpointV6,
  parseSyncCheckpointV6,
  applySyncCheckpointV6,
  validateSyncCheckpointV6,
  validateSyncV6ArchiveCatalog,
  type SyncCheckpointV6,
  type SyncV6ArchiveCatalog,
  type SyncV6ArchiveSegment,
} from "./sync-v6-checkpoint";
import {
  SYNC_V6_ASSET_PREFIX,
  SYNC_V6_ARCHIVE_CATALOG_PREFIX,
  SYNC_V6_CHECKPOINT_PREFIX,
  SYNC_V6_EVENT_PREFIX,
  SYNC_V6_IMMUTABLE_PREFIX,
  encodeSyncV6Event,
  planSyncV6HotTail,
  validateSyncHeadV6,
  type SyncHeadV6,
  type SyncV6Descriptor,
  type SyncV6EventPageDescriptor,
  type SyncV6PublicationFile,
} from "./sync-v6-head";
import {
  GitHubV6Remote,
  type GitHubV6RemoteOptions,
  type SyncV6HeadCache,
  type SyncV6HeadReadResult,
} from "./github-v6-remote";
import { IMAGE_EXTENSION_BY_MIME } from "./image-assets";
import { sha256Blob } from "./image-assets";
import type { GitHubSettings } from "./types";
import type { AttemptV6, PracticeRunV6, V6Event } from "./v6-types";

export interface SyncV6Progress {
  phase: "prepare" | "download" | "merge" | "upload" | "compact" | "cache" | "history" | "complete";
  label: string;
  percent: number;
}

export type SyncV6ProgressCallback = (progress: SyncV6Progress) => void;
export type SyncProgress = SyncV6Progress;
export type SyncProgressCallback = SyncV6ProgressCallback;

export class SyncV6NotInitializedError extends Error {
  constructor() {
    super("远程资料库还没有 v6 同步索引。");
    this.name = "SyncV6NotInitializedError";
  }
}

interface V6RemoteCacheValue {
  owner: string;
  repo: string;
  branch: string;
  cachedAt: string;
  checkpoint: SyncCheckpointV6;
  markers: Array<{ path: string; sha: string; appliedAt: string }>;
  head: SyncV6HeadCache;
}

interface DownloadedV6State {
  checkpoint: SyncCheckpointV6;
  events: V6Event[];
  markers: Array<{ path: string; sha: string; appliedAt: string }>;
  head: SyncHeadV6;
  cache: SyncV6HeadCache;
}

const CACHE_PREFIX = "v6:sync:";

function report(onProgress: SyncV6ProgressCallback | undefined, phase: SyncV6Progress["phase"], label: string, percent: number): void {
  onProgress?.({ phase, label, percent: Math.max(0, Math.min(100, Math.round(percent))) });
}

function range(onProgress: SyncV6ProgressCallback | undefined, start: number, end: number): SyncV6ProgressCallback | undefined {
  if (!onProgress) return undefined;
  return (progress) => report(onProgress, progress.phase, progress.label, start + (end - start) * progress.percent / 100);
}

function cacheKey(settings: GitHubSettings, suffix: string): string {
  return `${CACHE_PREFIX}${suffix}:${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/${encodeURIComponent(settings.branch || "main")}`;
}

function branchFor(settings: GitHubSettings): string {
  return settings.branch?.trim() || "main";
}

function remote(settings: GitHubSettings, token: string, options?: Omit<GitHubV6RemoteOptions, "owner" | "repo" | "token" | "branch">): GitHubV6Remote {
  return new GitHubV6Remote({ ...options, owner: settings.owner, repo: settings.repo, token, branch: branchFor(settings) });
}

function headCacheValue(value: unknown): SyncV6HeadCache | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SyncV6HeadCache>;
  if (!candidate.head || candidate.head.formatVersion !== 6) return undefined;
  try { validateSyncHeadV6(candidate.head); } catch { return undefined; }
  return { head: candidate.head, ...(candidate.etag ? { etag: candidate.etag } : {}), ...(candidate.blobSha ? { blobSha: candidate.blobSha } : {}) };
}

async function loadHeadCache(settings: GitHubSettings): Promise<SyncV6HeadCache | undefined> {
  const value = await dbV6.syncMeta.get(cacheKey(settings, "head"));
  return headCacheValue(value?.value);
}

async function saveHeadCache(settings: GitHubSettings, cache: SyncV6HeadCache): Promise<void> {
  await dbV6.syncMeta.put({ key: cacheKey(settings, "head"), value: cache, updatedAt: new Date().toISOString() });
}

async function saveRemoteCache(settings: GitHubSettings, value: V6RemoteCacheValue): Promise<void> {
  await dbV6.syncMeta.put({ key: cacheKey(settings, "checkpoint"), value, updatedAt: value.cachedAt });
}

async function loadRemoteCache(settings: GitHubSettings): Promise<V6RemoteCacheValue | undefined> {
  const value = (await dbV6.syncMeta.get(cacheKey(settings, "checkpoint")))?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<V6RemoteCacheValue>;
  if (!candidate.checkpoint || candidate.checkpoint.formatVersion !== 6 || !Array.isArray(candidate.markers)) return undefined;
  try { validateSyncCheckpointV6(candidate.checkpoint); } catch { return undefined; }
  return candidate as V6RemoteCacheValue;
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try { return JSON.parse(bytesToText(bytes)) as T; } catch { throw new Error(`${label}不是有效 JSON。`); }
}

function digestPath(prefix: string, digest: string, extension = "json"): string {
  return `${prefix}${digest}.${extension}`;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前运行环境缺少 SHA-256 支持。");
  const result = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function eventCursors(events: readonly V6Event[]): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const event of events) cursors[event.deviceId] = Math.max(cursors[event.deviceId] ?? 0, event.sequence);
  return cursors;
}

function validateEvent(event: unknown, index: number): asserts event is V6Event {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error(`远程 v6 事件 ${index} 格式无效。`);
  const value = event as Record<string, unknown>;
  for (const field of ["id", "type", "deviceId", "createdAt"]) if (typeof value[field] !== "string" || !value[field]) throw new Error(`远程 v6 事件 ${index}.${field} 无效。`);
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) throw new Error(`远程 v6 事件 ${index}.sequence 无效。`);
  encodeSyncV6Event(value);
}

function parseEventPage(bytes: Uint8Array, descriptor: SyncV6EventPageDescriptor): V6Event[] {
  const parsed = parseJson<unknown>(bytes, `远程事件页 ${descriptor.path}`);
  const events = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as { events?: unknown }).events)
      ? (parsed as { events: unknown[] }).events
      : [];
  if (events.length !== descriptor.count) throw new Error(`远程事件页 ${descriptor.path} 条数校验失败。`);
  events.forEach(validateEvent);
  const cursors = eventCursors(events as V6Event[]);
  if (Object.keys(cursors).length !== Object.keys(descriptor.deviceCursors).length) throw new Error(`远程事件页 ${descriptor.path} 游标设备集合校验失败。`);
  for (const [deviceId, sequence] of Object.entries(descriptor.deviceCursors)) if (cursors[deviceId] !== sequence) throw new Error(`远程事件页 ${descriptor.path} 游标校验失败。`);
  return events as V6Event[];
}

async function downloadState(client: GitHubV6Remote, headRead: Exclude<SyncV6HeadReadResult, { status: "missing" }>, onProgress?: SyncV6ProgressCallback): Promise<DownloadedV6State> {
  const head = headRead.head;
  report(onProgress, "download", "正在下载 v6 完整检查点", 8);
  const checkpoint = parseSyncCheckpointV6(await client.readBlob(head.checkpoint));
  const events: V6Event[] = [];
  for (let index = 0; index < head.eventPages.length; index += 1) {
    const descriptor = head.eventPages[index];
    const page = parseEventPage(await client.readBlob(descriptor), descriptor);
    events.push(...page);
    report(onProgress, "download", `正在下载近期更改 ${index + 1}/${head.eventPages.length}`, 12 + (index + 1) / Math.max(1, head.eventPages.length) * 60);
  }
  return {
    checkpoint,
    events,
    head,
    cache: headRead.cache,
    markers: [head.checkpoint, head.archiveCatalog, ...head.eventPages].map((descriptor) => ({ path: descriptor.path, sha: descriptor.blobSha, appliedAt: new Date().toISOString() })),
  };
}

interface ArchivedRowsV6 {
  attempts: AttemptV6[];
  practiceRuns: PracticeRunV6[];
}

async function downloadArchiveRows(client: GitHubV6Remote, head: SyncHeadV6, onProgress?: SyncV6ProgressCallback): Promise<ArchivedRowsV6> {
  const catalog = parseJson<SyncV6ArchiveCatalog>(await client.readBlob(head.archiveCatalog), "远程 v6 历史目录");
  validateSyncV6ArchiveCatalog(catalog);
  const all: Array<{ kind: "attempts" | "practice-runs"; segment: SyncV6ArchiveSegment }> = [
    ...catalog.attemptSegments.map((segment) => ({ kind: "attempts" as const, segment })),
    ...catalog.practiceRunSegments.map((segment) => ({ kind: "practice-runs" as const, segment })),
  ];
  const attempts: AttemptV6[] = [];
  const practiceRuns: PracticeRunV6[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const { kind, segment } = all[index];
    const payload = parseJson<unknown>(await client.readBlob(segment), `远程 v6 ${kind} 历史分段`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`远程 v6 ${kind} 历史分段格式校验失败：${segment.path}`);
    }
    const envelope = payload as { formatVersion?: unknown; kind?: unknown; rows?: unknown };
    if (envelope.formatVersion !== 6 || envelope.kind !== kind || !Array.isArray(envelope.rows)) {
      throw new Error(`远程 v6 ${kind} 历史分段格式校验失败：${segment.path}`);
    }
    const rows = envelope.rows;
    if (rows.length !== segment.count) throw new Error(`远程 v6 历史分段 ${segment.path} 条数校验失败。`);
    if (kind === "attempts") attempts.push(...rows as AttemptV6[]);
    else practiceRuns.push(...rows as PracticeRunV6[]);
    report(onProgress, "history", `正在下载完整历史 ${index + 1}/${all.length}`, 40 + (index + 1) / Math.max(1, all.length) * 36);
  }
  return { attempts, practiceRuns };
}

function mergeArchivedRows(checkpoint: SyncCheckpointV6, archived: ArchivedRowsV6): SyncCheckpointV6 {
  const state = checkpoint.state;
  const attemptsById = new Map(state.attempts.map((attempt) => [attempt.id, attempt]));
  for (const row of archived.attempts) if (row && typeof row.id === "string") attemptsById.set(row.id, row);
  const runsById = new Map(state.practiceRuns.map((run) => [run.id, run]));
  for (const row of archived.practiceRuns) if (row && typeof row.id === "string") runsById.set(row.id, row);
  const attempts = [...attemptsById.values()];
  const practiceRuns = [...runsById.values()];
  const nextState = { ...state, attempts, practiceRuns, recentAttempts: attempts, recentPracticeRuns: practiceRuns };
  const counts = {
    ...checkpoint.counts,
    attempts: attempts.length,
    practiceRuns: practiceRuns.length,
    totalAttempts: Math.max(Number(checkpoint.counts.totalAttempts ?? 0), attempts.length),
    totalPracticeRuns: Math.max(Number(checkpoint.counts.totalPracticeRuns ?? 0), practiceRuns.length),
  };
  const next = { ...checkpoint, state: nextState, counts };
  validateSyncCheckpointV6(next);
  return next;
}

async function ensureAssetFiles(client: GitHubV6Remote, onProgress?: SyncV6ProgressCallback): Promise<SyncV6PublicationFile[]> {
  const assets = await dbV6.imageAssets.toArray();
  const files: SyncV6PublicationFile[] = [];
  let index = 0;
  for (const asset of assets) {
    index += 1;
    const extension = IMAGE_EXTENSION_BY_MIME[asset.mimeType];
    const expectedPath = `${SYNC_V6_ASSET_PREFIX}${asset.id}.${extension}`;
    if (asset.blob) {
      const blobSha256 = await sha256Blob(asset.blob);
      if (blobSha256 !== asset.id) throw new Error(`图片 ${asset.id} 本地 Blob 摘要校验失败。`);
      const uploaded = await client.putImmutable({ path: expectedPath, bytes: new Uint8Array(await asset.blob.arrayBuffer()), kind: "asset", sha256: asset.id, size: asset.size });
      const remoteDescriptor = { path: expectedPath, blobSha: uploaded.blobSha, sha256: asset.id, size: asset.size };
      if (!asset.remote || asset.remote.path !== expectedPath || asset.remote.blobSha !== uploaded.blobSha || asset.remote.size !== asset.size) {
        // Metadata is part of the v6 checkpoint.  Do not emit a second domain
        // event here: the immutable checkpoint itself captures this update.
        await dbV6.imageAssets.put({ ...asset, remote: remoteDescriptor });
      }
      files.push({ path: expectedPath, bytes: new Uint8Array(await asset.blob.arrayBuffer()), kind: "asset" });
    } else if (asset.remote) {
      if (asset.remote.path !== expectedPath || asset.remote.sha256 !== asset.id || asset.remote.size !== asset.size) throw new Error(`图片 ${asset.id} 远端 descriptor 不符合 v6 约束。`);
    } else {
      throw new Error(`图片 ${asset.id} 缺少本地 Blob，无法首次上传远端资产。`);
    }
    report(onProgress, "upload", `正在准备图片资产 ${index}/${assets.length}`, 4 + index / Math.max(1, assets.length) * 16);
  }
  return files;
}

function pendingEventsForUpload(events: readonly V6Event[]): V6Event[] {
  const eventsToUpload: V6Event[] = [];
  for (const event of events) {
    try { encodeSyncV6Event(event); eventsToUpload.push(event); } catch (error) {
      if (error instanceof RangeError && error.message.includes("UTF-8")) continue;
      else throw error;
    }
  }
  return eventsToUpload;
}

async function catalogForPublication(client: GitHubV6Remote, checkpoint: SyncCheckpointV6, expectedHead: SyncHeadV6): Promise<SyncV6ArchiveCatalog> {
  // Preserve migration archives (and any future archive segments) when a
  // device performs an ordinary v6 sync after a quick restore.  Publishing a
  // fresh empty catalog here would silently make full-history restore lose
  // those immutable objects.
  const existingPath = expectedHead.archiveCatalog.path;
  if (!/\/0{64}\.json$/.test(existingPath)) {
    const existing = parseJson<SyncV6ArchiveCatalog>(await client.readBlob(expectedHead.archiveCatalog), "远程 v6 历史目录");
    validateSyncV6ArchiveCatalog(existing);
    return existing;
  }
  return createSyncV6ArchiveCatalog(checkpoint);
}

async function publicationFor(
  client: GitHubV6Remote,
  checkpoint: SyncCheckpointV6,
  pending: readonly V6Event[],
  expectedHead: SyncHeadV6,
  assetFiles: SyncV6PublicationFile[] | undefined,
  onProgress?: SyncV6ProgressCallback,
): Promise<{ files: SyncV6PublicationFile[]; head: SyncHeadV6; pendingIds: string[] }> {
  const assets = assetFiles ?? await ensureAssetFiles(client, range(onProgress, 0, 24));
  const checkpointBytes = encodeSyncCheckpointV6(checkpoint);
  const checkpointSha = await digest(checkpointBytes);
  const catalog = await catalogForPublication(client, checkpoint, expectedHead);
  const catalogBytes = new TextEncoder().encode(JSON.stringify(catalog));
  const catalogSha = await digest(catalogBytes);
  const events = pendingEventsForUpload(pending);
  const hot = planSyncV6HotTail(events);
  const pageFiles: SyncV6PublicationFile[] = hot.pages.map((page) => ({ path: digestPath(SYNC_V6_EVENT_PREFIX, ""), bytes: page.bytes, kind: "eventPage" }));
  // Hash paths are filled after encoding; retaining page order is important
  // for cursor/page validation, while the head is sorted by path below.
  for (let index = 0; index < pageFiles.length; index += 1) {
    const page = pageFiles[index];
    const bytes = page.bytes instanceof Uint8Array ? page.bytes : new TextEncoder().encode(String(page.bytes));
    pageFiles[index] = { ...page, path: digestPath(SYNC_V6_EVENT_PREFIX, await digest(bytes)) };
  }
  const immutable: SyncV6PublicationFile[] = [
    { path: digestPath(SYNC_V6_CHECKPOINT_PREFIX, checkpointSha), bytes: checkpointBytes, kind: "checkpoint" },
    { path: `${SYNC_V6_ARCHIVE_CATALOG_PREFIX}${catalogSha}.json`, bytes: catalogBytes, kind: "archiveCatalog" },
    ...pageFiles,
  ];
  const uploadedDescriptors = new Map<string, SyncV6Descriptor>();
  for (const file of immutable) {
    const uploaded = await client.putImmutable(file);
    uploadedDescriptors.set(file.path, { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size });
  }
  const pageDescriptors: SyncV6EventPageDescriptor[] = pageFiles.map((file, index) => {
    const descriptor = uploadedDescriptors.get(file.path)!;
    const pageEvents = hot.pages[index].events as V6Event[];
    return { ...descriptor, count: pageEvents.length, deviceCursors: eventCursors(pageEvents) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const nextHead: SyncHeadV6 = {
    formatVersion: 6,
    generatedAt: checkpoint.generatedAt,
    checkpoint: uploadedDescriptors.get(immutable[0].path)!,
    archiveCatalog: uploadedDescriptors.get(immutable[1].path)!,
    eventPages: pageDescriptors,
    ...(expectedHead.source ? { source: expectedHead.source } : {}),
  };
  validateSyncHeadV6(nextHead);
  // Events omitted from the hot tail are still covered by this complete
  // checkpoint.  They are acknowledged only after the head CAS succeeds.
  return { files: [...assets, ...immutable], head: nextHead, pendingIds: pending.map((event) => event.id) };
}

async function markUploadedEvents(ids: readonly string[], generatedAt: string): Promise<void> {
  if (!ids.length) return;
  const selected = await dbV6.events.bulkGet([...ids]);
  await dbV6.events.bulkPut(selected.filter((event): event is V6Event => Boolean(event)).map((event) => ({ ...event, synced: 1 as const })));
  await dbV6.syncMeta.put({ key: `${CACHE_PREFIX}last-upload`, value: { ids: [...ids] }, updatedAt: generatedAt });
}

async function markersCurrent(head: SyncHeadV6): Promise<{ checkpoint: boolean; pages: SyncV6EventPageDescriptor[] }> {
  const checkpoint = await dbV6.syncFiles.get(head.checkpoint.path);
  const pages = await Promise.all(head.eventPages.map(async (descriptor) => {
    const marker = await dbV6.syncFiles.get(descriptor.path);
    return marker?.sha === descriptor.blobSha ? undefined : descriptor;
  }));
  return { checkpoint: checkpoint?.sha === head.checkpoint.blobSha, pages: pages.filter((page): page is SyncV6EventPageDescriptor => Boolean(page)) };
}

async function applyDownloadedState(state: DownloadedV6State, preservePending: boolean, onProgress?: SyncV6ProgressCallback): Promise<number> {
  report(onProgress, "merge", "正在原子应用 v6 检查点和事件", 78);
  const result = await applySyncCheckpointV6(state.checkpoint, state.events, { preservePending });
  await dbV6.syncFiles.bulkPut(state.markers);
  report(onProgress, "merge", `已应用 ${result.applied} 条远程事件`, 90);
  return result.applied;
}

async function applyMissingPages(client: GitHubV6Remote, descriptors: readonly SyncV6EventPageDescriptor[]): Promise<number> {
  if (!descriptors.length) return 0;
  const events: V6Event[] = [];
  for (const descriptor of descriptors) events.push(...parseEventPage(await client.readBlob(descriptor), descriptor));
  // Rebuilding the local checkpoint here gives event application the same
  // atomic rollback semantics as a full restore without reading any legacy DB.
  const checkpoint = await createSyncCheckpointV6();
  const result = await applySyncCheckpointV6(checkpoint, events, { preservePending: true });
  await dbV6.syncFiles.bulkPut(descriptors.map((descriptor) => ({ path: descriptor.path, sha: descriptor.blobSha, appliedAt: new Date().toISOString() })));
  return result.applied;
}

async function readHeadOrThrow(client: GitHubV6Remote, settings: GitHubSettings): Promise<Exclude<SyncV6HeadReadResult, { status: "missing" }>> {
  const read = await client.readHead(await loadHeadCache(settings));
  if (!read.initialized) throw new SyncV6NotInitializedError();
  return read;
}

async function initializeV6(settings: GitHubSettings, token: string, onProgress?: SyncV6ProgressCallback) {
  const client = remote(settings, token);
  const existing = await client.readHead();
  if (existing.initialized) return { initialized: false as const, head: existing.head, cache: existing.cache };
  report(onProgress, "prepare", "正在创建 v6 固定同步索引", 8);
  const assetFiles = await ensureAssetFiles(client, range(onProgress, 8, 24));
  const checkpoint = await createSyncCheckpointV6();
  const pending = await dbV6.events.where("synced").equals(0).toArray();
  const publication = await publicationFor(client, checkpoint, pending, {
    formatVersion: 6, generatedAt: checkpoint.generatedAt, checkpoint: { path: `${SYNC_V6_CHECKPOINT_PREFIX}${"0".repeat(64)}.json`, blobSha: "0".repeat(40), sha256: "0".repeat(64), size: 1 }, archiveCatalog: { path: `${SYNC_V6_IMMUTABLE_PREFIX}${"0".repeat(64)}.json`, blobSha: "0".repeat(40), sha256: "0".repeat(64), size: 1 }, eventPages: [],
  }, assetFiles, onProgress);
  const committed = await client.putHead(publication.head);
  if (!committed.ok) {
    const winner = await client.readHead();
    if (!winner.initialized) throw new Error("v6 同步索引初始化发生冲突，请重试。");
    await saveHeadCache(settings, winner.cache);
    return { initialized: false as const, head: winner.head, cache: winner.cache };
  }
  await markUploadedEvents(pending.map((event) => event.id), checkpoint.generatedAt);
  const markers = [publication.head.checkpoint, publication.head.archiveCatalog, ...publication.head.eventPages].map((item) => ({ path: item.path, sha: item.blobSha, appliedAt: checkpoint.generatedAt }));
  await dbV6.syncFiles.bulkPut(markers);
  await saveHeadCache(settings, committed.cache);
  await saveRemoteCache(settings, { owner: settings.owner, repo: settings.repo, branch: branchFor(settings), cachedAt: checkpoint.generatedAt, checkpoint, markers, head: committed.cache });
  report(onProgress, "complete", "v6 同步索引创建完成", 100);
  return { initialized: true as const, head: committed.head, cache: committed.cache };
}

export async function initializeGitHubVaultV6(settings: GitHubSettings, token: string, onProgress?: SyncV6ProgressCallback) {
  return initializeV6(settings, token, onProgress);
}

export async function syncWithGitHubV6(settings: GitHubSettings, token: string, onProgress?: SyncV6ProgressCallback) {
  const client = remote(settings, token);
  report(onProgress, "prepare", "正在读取 v6 固定同步索引", 3);
  let read = await client.readHead(await loadHeadCache(settings));
  if (!read.initialized) {
    await initializeV6(settings, token, onProgress);
    read = await client.readHead(await loadHeadCache(settings));
    if (!read.initialized) throw new SyncV6NotInitializedError();
  }
  let pulled = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await markersCurrent(read.head);
    if (!current.checkpoint) {
      const downloaded = await downloadState(client, read, range(onProgress, 8, 52));
      pulled += await applyDownloadedState(downloaded, true, onProgress);
    } else if (current.pages.length) {
      pulled += await applyMissingPages(client, current.pages);
    }
    await saveHeadCache(settings, read.cache);
    const pending = await dbV6.events.where("synced").equals(0).toArray();
    if (!pending.length) {
      const checkpoint = await createSyncCheckpointV6();
      await saveRemoteCache(settings, { owner: settings.owner, repo: settings.repo, branch: branchFor(settings), cachedAt: new Date().toISOString(), checkpoint, markers: [read.head.checkpoint, read.head.archiveCatalog, ...read.head.eventPages].map((item) => ({ path: item.path, sha: item.blobSha, appliedAt: new Date().toISOString() })), head: read.cache });
      report(onProgress, "complete", pulled ? `已合并 ${pulled} 条远程更改` : "云端和本机已经一致", 100);
      return { pulled, pushed: 0, remaining: 0, deferred: 0, formatVersion: 6 as const, compacted: false, migrated: false };
    }
    const assetFiles = await ensureAssetFiles(client, range(onProgress, 54, 62));
    const checkpoint = await createSyncCheckpointV6();
    const publication = await publicationFor(client, checkpoint, pending, read.head, assetFiles, range(onProgress, 54, 94));
    const committed = await client.putHead(publication.head, read.cache);
    if (committed.ok) {
      await markUploadedEvents(publication.pendingIds, checkpoint.generatedAt);
      const markers = [publication.head.checkpoint, publication.head.archiveCatalog, ...publication.head.eventPages].map((item) => ({ path: item.path, sha: item.blobSha, appliedAt: checkpoint.generatedAt }));
      await dbV6.syncFiles.bulkPut(markers);
      await saveHeadCache(settings, committed.cache);
      await saveRemoteCache(settings, { owner: settings.owner, repo: settings.repo, branch: branchFor(settings), cachedAt: checkpoint.generatedAt, checkpoint, markers, head: committed.cache });
      const remaining = await dbV6.events.where("synced").equals(0).count();
      report(onProgress, "complete", remaining ? `本轮同步完成，还有 ${remaining} 条待同步` : "同步完成", 100);
      return { pulled, pushed: publication.pendingIds.length, remaining, deferred: 0, formatVersion: 6 as const, compacted: true, migrated: false };
    }
    // CAS failed: no pending event is marked synced.  Read the winner and
    // replay its checkpoint/pages before rebuilding our immutable snapshot.
    read = await client.readHead();
    if (!read.initialized) throw new SyncV6NotInitializedError();
  }
  throw new Error("远程 v6 资料库正在被其他设备持续更新，本地更改仍安全保留，请稍后重试。");
}

export async function pullFromGitHubV6(settings: GitHubSettings, token: string, onProgress?: SyncV6ProgressCallback) {
  const client = remote(settings, token);
  const read = await readHeadOrThrow(client, settings);
  const current = await markersCurrent(read.head);
  let pulled = 0;
  if (!current.checkpoint) pulled = await applyDownloadedState(await downloadState(client, read, range(onProgress, 12, 86)), true, onProgress);
  else if (current.pages.length) pulled = await applyMissingPages(client, current.pages);
  await saveHeadCache(settings, read.cache);
  report(onProgress, "complete", pulled ? `已合并 ${pulled} 条远程更改` : "云端没有新数据", 100);
  return { pulled, formatVersion: 6 as const };
}

async function restoreRemote(settings: GitHubSettings, token: string, onProgress: SyncV6ProgressCallback | undefined, preservePending: boolean) {
  const client = remote(settings, token);
  const read = await readHeadOrThrow(client, settings);
  const downloaded = await downloadState(client, read, range(onProgress, 8, 76));
  const pulled = await applyDownloadedState(downloaded, preservePending, onProgress);
  await saveHeadCache(settings, read.cache);
  const cache = { owner: settings.owner, repo: settings.repo, branch: branchFor(settings), cachedAt: new Date().toISOString(), checkpoint: downloaded.checkpoint, markers: downloaded.markers, head: read.cache } satisfies V6RemoteCacheValue;
  await saveRemoteCache(settings, cache);
  report(onProgress, "complete", "v6 恢复完成", 100);
  return { pulled, formatVersion: 6 as const, counts: downloaded.checkpoint.counts, deferred: 0, cachedAt: cache.cachedAt, archivedAttempts: 0, archivedPracticeRuns: 0 };
}

export function restoreFromGitHubV6(settings: GitHubSettings, token: string, onProgress?: SyncV6ProgressCallback) {
  return restoreRemote(settings, token, onProgress, false);
}

export async function restoreFullHistoryFromGitHubV6(settings: GitHubSettings, token: string, onProgress?: SyncV6ProgressCallback) {
  const client = remote(settings, token);
  const read = await readHeadOrThrow(client, settings);
  const downloaded = await downloadState(client, read, range(onProgress, 4, 38));
  report(onProgress, "history", "正在下载 v6 历史归档", 40);
  const archived = await downloadArchiveRows(client, read.head, onProgress);
  const merged = mergeArchivedRows(downloaded.checkpoint, archived);
  report(onProgress, "merge", "正在原子提交 v6 完整历史", 88);
  const applied = await applySyncCheckpointV6(merged, downloaded.events, { preservePending: false });
  await dbV6.syncFiles.bulkPut(downloaded.markers);
  await saveHeadCache(settings, read.cache);
  const cachedAt = new Date().toISOString();
  await saveRemoteCache(settings, { owner: settings.owner, repo: settings.repo, branch: branchFor(settings), cachedAt, checkpoint: merged, markers: downloaded.markers, head: read.cache });
  report(onProgress, "complete", "v6 完整恢复完成", 100);
  return { pulled: applied.applied, formatVersion: 6 as const, counts: merged.counts, deferred: 0, cachedAt, archivedAttempts: archived.attempts.length, archivedPracticeRuns: archived.practiceRuns.length };
}

export async function getLastRemoteCache(settings: GitHubSettings) {
  const cached = await loadRemoteCache(settings);
  if (!cached) return null;
  return { cachedAt: cached.cachedAt, counts: cached.checkpoint.counts, formatVersion: 6 as const };
}

export async function restoreLastRemoteCache(settings: GitHubSettings, onProgress?: SyncV6ProgressCallback) {
  const cached = await loadRemoteCache(settings);
  if (!cached) throw new Error("本机还没有可恢复的 v6 远程缓存，请先成功同步一次。");
  report(onProgress, "prepare", "正在检查本地 v6 恢复记录", 5);
  const result = await applySyncCheckpointV6(cached.checkpoint, [], { preservePending: false });
  await dbV6.syncFiles.bulkPut(cached.markers);
  await saveHeadCache(settings, cached.head);
  report(onProgress, "complete", "本地 v6 记录恢复完成", 100);
  return { cachedAt: cached.cachedAt, counts: cached.checkpoint.counts, formatVersion: 6 as const, pulled: result.applied, deferred: 0 };
}

export async function loadAttemptHistoryV6(settings: GitHubSettings, token: string, options: { month?: string; questionId?: string } = {}) {
  await pullFromGitHubV6(settings, token);
  const attempts = await dbV6.attempts.toArray();
  const rows = attempts.filter((attempt) => (!options.questionId || attempt.questionId === options.questionId) && (!options.month || attempt.createdAt.startsWith(options.month)));
  return { loaded: rows.length, segments: 0 };
}

export async function verifyGitHubVaultV6(settings: GitHubSettings, token: string) {
  const read = await remote(settings, token).readHead(await loadHeadCache(settings));
  return read.initialized ? 6 as const : 0 as const;
}

export async function getGitHubLoginV6(token: string) {
  const response = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）`);
  const value = await response.json() as { login?: unknown };
  if (typeof value.login !== "string" || !value.login) throw new Error("GitHub 未返回登录名。");
  return value.login;
}

export async function downloadImageAssetV6(settings: GitHubSettings, token: string, assetId: string): Promise<Blob> {
  const descriptor = await getImageAssetDescriptorV6(assetId);
  if (!descriptor?.remote) throw new Error("图片 descriptor 缺少远端资产路径。");
  const bytes = await remote(settings, token).readAsset(descriptor.remote);
  const blob = new Blob([bytes as unknown as BlobPart], { type: descriptor.mimeType });
  if (blob.size !== descriptor.size || await sha256Blob(blob) !== descriptor.id) throw new Error("远端图片完整性校验失败。");
  await putImageAssetBlobV6(assetId, blob);
  return blob;
}

export async function downloadAllImageAssetsV6(settings: GitHubSettings, token: string): Promise<number> {
  const assets = await dbV6.imageAssets.toArray();
  let downloaded = 0;
  for (const asset of assets) if (!asset.blob) { await downloadImageAssetV6(settings, token, asset.id); downloaded += 1; }
  return downloaded;
}

export async function getImageCacheStatsV6() {
  const assets = await dbV6.imageAssets.toArray();
  const bytes = assets.reduce((sum, asset) => sum + (asset.blob?.size ?? 0), 0);
  return { total: assets.length, cached: assets.filter((asset) => Boolean(asset.blob)).length, bytes, totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0) };
}

export const downloadImageAsset = downloadImageAssetV6;
export const downloadAllImageAssets = downloadAllImageAssetsV6;
export const getImageCacheStats = getImageCacheStatsV6;
export const clearImageCache = clearImageCacheV6;

/** Lightweight local statistics API used by diagnostics and settings UI. */
export async function getSyncStatsV6() {
  const checkpoint = await createSyncCheckpointV6();
  const pending = await dbV6.events.where("synced").equals(0).count();
  const imageCache = await getImageCacheStatsV6();
  return { ...checkpoint.counts, pendingEvents: pending, imageCache };
}

export const getSyncStats = getSyncStatsV6;

export { clearImageCacheV6, getImageAssetBlobV6 };

// Stable aliases used by integrations and the public facade.
export const syncWithGitHub = syncWithGitHubV6;
export const pullFromGitHub = pullFromGitHubV6;
export const restoreFromGitHub = restoreFromGitHubV6;
export const restoreFullHistoryFromGitHub = restoreFullHistoryFromGitHubV6;
export const loadAttemptHistory = loadAttemptHistoryV6;
export const verifyGitHubVault = verifyGitHubVaultV6;
export const initializeGitHubVault = initializeGitHubVaultV6;
