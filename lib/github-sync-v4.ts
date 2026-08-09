import {
  applyPreparedSyncCheckpoint,
  applyRemoteEvents,
  clearSyncRestoreStage,
  commitStagedSyncRestore,
  createSyncCheckpoint,
  db,
  filterUnarchivedSyncIds,
  markSyncArchiveEntries,
  prepareSyncCheckpoint,
  saveSyncCheckpointCache,
  stageSyncRestoreAttempts,
  stageSyncRestorePracticeRuns,
  withSyncRestoreTransaction,
} from "./db";
import { GitHubV4Remote, type SyncV4HeadCache } from "./github-v4-remote";
import {
  appendSyncArchiveSegmentsV4,
  createSyncArchiveCatalogV4,
  createSyncArchiveSegmentV4,
  validateSyncArchiveCatalogV4,
} from "./sync-v4-catalog";
import {
  SYNC_V4_ARCHIVE_CATALOG_PREFIX,
  SYNC_V4_CHECKPOINT_PREFIX,
  SYNC_V4_EVENT_PREFIX,
  SYNC_V4_MAX_EVENT_PAGE_BYTES,
  SYNC_V4_MAX_EVENT_PAGE_COUNT,
  SYNC_V4_MAX_EVENT_BYTES,
  appendSyncV4EventPagesAfterCas,
  tryCompactSyncV4HeadAfterCas,
} from "./sync-v4-head";
import type {
  Attempt,
  GitHubSettings,
  PracticeRun,
  SyncArchiveCatalogV4,
  SyncArchiveSegmentV4,
  SyncCheckpointV3,
  SyncEvent,
  SyncEventPageDescriptorV4,
  SyncHeadDescriptorV4,
  SyncHeadV4,
} from "./types";
import { calendarDate } from "./practice-metrics";

const uploadByteLimit = 2 * 1024 * 1024;
const downloadConcurrency = 4;
const compactionFileThreshold = 10;
const archiveSegmentSize = 500;
const archiveAttemptBudget = 2_000;
const archivePracticeRunBudget = 500;
const remoteCachePrefix = "__local_remote_cache__/";

export interface SyncV4Progress {
  phase: "prepare" | "download" | "merge" | "upload" | "compact" | "cache" | "history" | "complete";
  label: string;
  percent: number;
}

export type SyncV4ProgressCallback = (progress: SyncV4Progress) => void;

export class SyncV4NotInitializedError extends Error {
  constructor() {
    super("远程资料库还没有 v4 同步索引。");
    this.name = "SyncV4NotInitializedError";
  }
}

interface EventPagePayload {
  formatVersion: 4;
  events: SyncEvent[];
}

interface ArchivePayload<T> {
  formatVersion: 3 | 4;
  kind: "attempts" | "practice-runs";
  rows: T[];
}

interface HotPackage {
  checkpoint: SyncCheckpointV3;
  checkpointPlan: ReturnType<typeof prepareSyncCheckpoint>;
  events: SyncEvent[];
  markers: Array<{ path: string; sha: string; appliedAt: string }>;
  head: SyncHeadV4;
}

function report(onProgress: SyncV4ProgressCallback | undefined, phase: SyncV4Progress["phase"], label: string, percent: number) {
  onProgress?.({ phase, label, percent: Math.max(0, Math.min(100, Math.round(percent))) });
}

function range(onProgress: SyncV4ProgressCallback | undefined, start: number, end: number): SyncV4ProgressCallback | undefined {
  if (!onProgress) return undefined;
  return (progress) => report(onProgress, progress.phase, progress.label, start + (end - start) * progress.percent / 100);
}

function remote(settings: GitHubSettings, token: string) {
  return new GitHubV4Remote({ ...settings, token });
}

function repoKey(settings: GitHubSettings, suffix: string) {
  return `v4:${suffix}:${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/${encodeURIComponent(settings.branch || "main")}`;
}

function remoteCachePath(settings: GitHubSettings) {
  return `${remoteCachePrefix}${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/${encodeURIComponent(settings.branch || "main")}`;
}

async function loadHeadCache(settings: GitHubSettings): Promise<SyncV4HeadCache | undefined> {
  const value = (await db.syncMeta.get(repoKey(settings, "head")))?.value as SyncV4HeadCache | undefined;
  return value?.head?.formatVersion === 4 ? value : undefined;
}

async function saveHeadCache(settings: GitHubSettings, cache: SyncV4HeadCache) {
  await db.syncMeta.put({ key: repoKey(settings, "head"), value: cache, updatedAt: new Date().toISOString() });
}

async function loadCatalogCache(settings: GitHubSettings, descriptor: SyncHeadDescriptorV4): Promise<SyncArchiveCatalogV4 | undefined> {
  const value = (await db.syncMeta.get(repoKey(settings, "catalog")))?.value as { descriptor?: SyncHeadDescriptorV4; catalog?: SyncArchiveCatalogV4 } | undefined;
  if (value?.descriptor?.path !== descriptor.path || value.descriptor.blobSha !== descriptor.blobSha || !value.catalog) return undefined;
  validateSyncArchiveCatalogV4(value.catalog);
  return value.catalog;
}

async function saveCatalogCache(settings: GitHubSettings, descriptor: SyncHeadDescriptorV4, catalog: SyncArchiveCatalogV4) {
  await db.syncMeta.put({ key: repoKey(settings, "catalog"), value: { descriptor, catalog }, updatedAt: new Date().toISOString() });
}

async function hasArchiveBacklog(settings: GitHubSettings) {
  return (await db.syncMeta.get(repoKey(settings, "archive-backlog")))?.value === true;
}

async function saveArchiveBacklog(settings: GitHubSettings, value: boolean) {
  await db.syncMeta.put({ key: repoKey(settings, "archive-backlog"), value, updatedAt: new Date().toISOString() });
}

function asText(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes);
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try {
    return JSON.parse(asText(bytes)) as T;
  } catch {
    throw new Error(`${label}不是有效的 JSON。`);
  }
}

async function sha256(bytes: Uint8Array | string) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function mapConcurrent<T, R>(values: readonly T[], limit: number, work: (value: T, index: number) => Promise<R>) {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await work(values[index], index);
    }
  });
  // Do not let a rejected worker return while its siblings still write into a
  // restore staging table.  Waiting for all workers makes the subsequent
  // cleanup a real barrier instead of a race.
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (rejected) throw rejected.reason;
  return result;
}

function eventCursors(events: readonly SyncEvent[]) {
  const cursors: Record<string, number> = {};
  for (const event of events) cursors[event.deviceId] = Math.max(cursors[event.deviceId] ?? 0, event.sequence);
  return cursors;
}

function validateEventPage(payload: unknown, descriptor: SyncEventPageDescriptorV4): SyncEvent[] {
  const page = payload as Partial<EventPagePayload>;
  if (page?.formatVersion !== 4 || !Array.isArray(page.events) || page.events.length !== descriptor.count) {
    throw new Error(`远程事件分页格式无效：${descriptor.path}`);
  }
  const cursors = eventCursors(page.events);
  if (Object.entries(descriptor.deviceCursors).some(([deviceId, sequence]) => cursors[deviceId] !== sequence)) {
    throw new Error(`远程事件分页游标校验失败：${descriptor.path}`);
  }
  return page.events;
}

async function readCatalog(client: GitHubV4Remote, settings: GitHubSettings, head: SyncHeadV4) {
  const cached = await loadCatalogCache(settings, head.archiveCatalog);
  if (cached) return cached;
  const catalog = parseJson<SyncArchiveCatalogV4>(await client.readBlob(head.archiveCatalog), "远程历史目录");
  validateSyncArchiveCatalogV4(catalog);
  await saveCatalogCache(settings, head.archiveCatalog, catalog);
  return catalog;
}

async function downloadHotPackage(
  client: GitHubV4Remote,
  head: SyncHeadV4,
  onProgress?: SyncV4ProgressCallback,
): Promise<HotPackage> {
  report(onProgress, "download", "正在下载远程检查点", 5);
  const checkpoint = parseJson<SyncCheckpointV3>(await client.readBlob(head.checkpoint), "远程检查点");
  const checkpointPlan = prepareSyncCheckpoint(checkpoint);
  let completed = 0;
  const pages = await mapConcurrent(head.eventPages, downloadConcurrency, async (descriptor) => {
    const events = validateEventPage(parseJson<unknown>(await client.readBlob(descriptor), "远程事件分页"), descriptor);
    completed += 1;
    report(onProgress, "download", `正在下载近期更改 ${completed}/${head.eventPages.length}`, 15 + completed / Math.max(1, head.eventPages.length) * 85);
    return events;
  });
  const appliedAt = new Date().toISOString();
  return {
    checkpoint,
    checkpointPlan,
    events: pages.flat(),
    markers: [head.checkpoint, head.archiveCatalog, ...head.eventPages].map((item) => ({ path: item.path, sha: item.blobSha, appliedAt })),
    head,
  };
}

async function applyHotPackage(settings: GitHubSettings, pkg: HotPackage, preserveLocalChanges: boolean) {
  const localEvents = preserveLocalChanges ? await db.events.toArray() : [];
  const beyondCheckpoint = localEvents.filter((event) => event.sequence > (pkg.checkpoint.cursors[event.deviceId] ?? 0));
  await withSyncRestoreTransaction(async () => {
    await applyPreparedSyncCheckpoint(pkg.checkpointPlan, { preserveSyncFiles: true, preserveSessions: true });
    await applyRemoteEvents([...beyondCheckpoint, ...pkg.events]);
    if (beyondCheckpoint.length) await db.events.bulkPut(beyondCheckpoint.map((event) => ({ ...event, synced: 0 as const })));
    await db.syncFiles.bulkPut(pkg.markers);
  });
  return { localEvents: beyondCheckpoint, pulled: pkg.events.length };
}

async function cacheCheckpoint(settings: GitHubSettings, plan: ReturnType<typeof prepareSyncCheckpoint>, markers: HotPackage["markers"]) {
  return saveSyncCheckpointCache({
    path: remoteCachePath(settings),
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch || "main",
    checkpoint: plan,
    markers,
  });
}

async function cacheCurrentState(settings: GitHubSettings, markers: HotPackage["markers"]) {
  return cacheCheckpoint(settings, prepareSyncCheckpoint(await createSyncCheckpoint()), markers);
}

async function downloadEventPages(
  client: GitHubV4Remote,
  descriptors: readonly SyncEventPageDescriptorV4[],
  onProgress?: SyncV4ProgressCallback,
) {
  let completed = 0;
  const pages = await mapConcurrent(descriptors, downloadConcurrency, async (descriptor) => {
    const events = validateEventPage(parseJson<unknown>(await client.readBlob(descriptor), "远程事件分页"), descriptor);
    completed += 1;
    report(onProgress, "download", `正在下载近期更改 ${completed}/${descriptors.length}`, completed / Math.max(1, descriptors.length) * 100);
    return events;
  });
  return pages.flat();
}

async function putCheckpoint(client: GitHubV4Remote, checkpoint: SyncCheckpointV3) {
  const text = JSON.stringify(checkpoint);
  const digest = await sha256(text);
  const uploaded = await client.putImmutable({
    path: `${SYNC_V4_CHECKPOINT_PREFIX}${digest}.json`,
    bytes: text,
    kind: "checkpoint",
    sha256: digest,
  });
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size } satisfies SyncHeadDescriptorV4;
}

async function putCatalog(client: GitHubV4Remote, catalog: SyncArchiveCatalogV4) {
  validateSyncArchiveCatalogV4(catalog);
  const text = JSON.stringify(catalog);
  const digest = await sha256(text);
  const uploaded = await client.putImmutable({
    path: `${SYNC_V4_ARCHIVE_CATALOG_PREFIX}${digest}.json`,
    bytes: text,
    kind: "archiveCatalog",
    sha256: digest,
  });
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size } satisfies SyncHeadDescriptorV4;
}

interface BuiltArchiveSegment {
  segment: SyncArchiveSegmentV4;
  ids: string[];
}

async function uploadArchiveRows<T extends { id: string }>(
  client: GitHubV4Remote,
  kind: "attempts" | "practice-runs",
  rows: T[],
  timestamp: (row: T) => string,
): Promise<BuiltArchiveSegment[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const month = timestamp(row).slice(0, 7);
    grouped.set(month, [...(grouped.get(month) ?? []), row]);
  }
  const result: BuiltArchiveSegment[] = [];
  for (const [month, monthRows] of grouped) {
    for (let offset = 0; offset < monthRows.length; offset += archiveSegmentSize) {
      const chunk = monthRows.slice(offset, offset + archiveSegmentSize);
      const text = JSON.stringify({ formatVersion: 4, kind, rows: chunk });
      const digest = await sha256(text);
      const uploaded = await client.putImmutable({
        path: `sync/v4/archive/${kind}/${month}/${digest}.json`,
        bytes: text,
        kind: "archiveSegment",
        sha256: digest,
      });
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      result.push({
        segment: createSyncArchiveSegmentV4(kind, {
          blobSha: uploaded.blobSha,
          sha256: uploaded.sha256,
          size: uploaded.size,
          month,
          count: chunk.length,
          firstId: first.id,
          lastId: last.id,
          firstCreatedAt: timestamp(first),
          lastCreatedAt: timestamp(last),
        }),
        ids: chunk.map((row) => row.id),
      });
    }
  }
  return result;
}

async function collectUnarchivedRows<T extends { id: string }>(
  kind: "attempts" | "practice-runs",
  readChunk: (offset: number) => Promise<T[]>,
  include: (row: T) => boolean = () => true,
  limit = Number.POSITIVE_INFINITY,
) {
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const chunk = await readChunk(offset);
    if (!chunk.length) break;
    offset += chunk.length;
    const candidates = chunk.filter(include);
    const missing = new Set(await filterUnarchivedSyncIds(kind, candidates.map((row) => row.id)));
    const available = candidates.filter((row) => missing.has(row.id));
    rows.push(...available.slice(0, Math.max(0, limit - rows.length)));
    if (rows.length >= limit) break;
    if (chunk.length < archiveSegmentSize) break;
  }
  return { rows, budgetReached: rows.length >= limit };
}

async function buildArchiveDelta(client: GitHubV4Remote, checkpoint: SyncCheckpointV3) {
  const attemptCutoff = checkpoint.retention.oldestRecentAttemptAt;
  const recentRunIds = new Set(checkpoint.state.recentPracticeRuns.map((run) => run.id));
  const attemptResult = attemptCutoff
    ? await collectUnarchivedRows<Attempt>("attempts", (offset) => db.attempts.where("createdAt").below(attemptCutoff).offset(offset).limit(archiveSegmentSize).toArray(), undefined, archiveAttemptBudget)
    : { rows: [] as Attempt[], budgetReached: false };
  const runResult = await collectUnarchivedRows<PracticeRun>("practice-runs", async (offset) => {
    return db.practiceRuns.orderBy("updatedAt").offset(offset).limit(archiveSegmentSize).toArray();
  }, (run) => !recentRunIds.has(run.id), archivePracticeRunBudget);
  const attempts = attemptResult.rows;
  const runs = runResult.rows;
  const [attemptSegments, runSegments] = await Promise.all([
    uploadArchiveRows(client, "attempts", attempts, (row) => row.createdAt),
    uploadArchiveRows(client, "practice-runs", runs, (row) => row.updatedAt),
  ]);
  return {
    attempts,
    runs,
    attemptSegments,
    runSegments,
    backlog: attemptResult.budgetReached || runResult.budgetReached,
  };
}

async function compact(
  client: GitHubV4Remote,
  settings: GitHubSettings,
  expectedHead: SyncHeadV4,
  expectedCache: SyncV4HeadCache,
  onProgress?: SyncV4ProgressCallback,
) {
  report(onProgress, "compact", "正在生成有上限的检查点", 8);
  const [checkpoint, baseCatalog] = await Promise.all([
    createSyncCheckpoint(),
    readCatalog(client, settings, expectedHead),
  ]);
  const delta = await buildArchiveDelta(client, checkpoint);
  const generatedAt = checkpoint.generatedAt;
  const catalog = appendSyncArchiveSegmentsV4(
    { ...baseCatalog, generatedAt },
    {
      attemptSegments: delta.attemptSegments.map((item) => item.segment),
      practiceRunSegments: delta.runSegments.map((item) => item.segment),
    },
  );
  report(onProgress, "compact", "正在上传检查点和历史目录", 52);
  const [checkpointDescriptor, catalogDescriptor] = await Promise.all([
    putCheckpoint(client, checkpoint),
    putCatalog(client, catalog),
  ]);
  const latest = await client.readHead();
  if (!latest.initialized) throw new SyncV4NotInitializedError();
  const merged = tryCompactSyncV4HeadAfterCas({
    expectedHead,
    latestHead: latest.head,
    checkpoint: checkpointDescriptor,
    archiveCatalog: catalogDescriptor,
    includedPaths: expectedHead.eventPages.map((page) => page.path),
    generatedAt,
  });
  if (!merged.ok) return { compacted: false as const, head: latest.head, cache: latest.cache };
  const committed = await client.putHead(merged.head, latest.cache);
  if (!committed.ok) return { compacted: false as const, head: latest.head, cache: latest.cache };
  const attemptIds = delta.attemptSegments.flatMap((item) => item.ids);
  const runIds = delta.runSegments.flatMap((item) => item.ids);
  const retainedMarkers = merged.head.eventPages
    .filter((page) => expectedHead.eventPages.some((expected) => expected.path === page.path))
    .map((page) => ({ path: page.path, sha: page.blobSha, appliedAt: generatedAt }));
  await Promise.all([
    markSyncArchiveEntries("attempts", attemptIds),
    markSyncArchiveEntries("practice-runs", runIds),
    attemptIds.length ? db.attempts.bulkDelete(attemptIds) : Promise.resolve(),
    runIds.length ? db.practiceRuns.bulkDelete(runIds) : Promise.resolve(),
  ]);
  const covered = (await db.events.toArray()).filter((event) => event.synced === 1 && event.sequence <= (checkpoint.cursors[event.deviceId] ?? 0));
  if (covered.length) await db.events.bulkDelete(covered.map((event) => event.id));
  const dailyCutoff = new Date();
  dailyCutoff.setDate(dailyCutoff.getDate() - 34);
  await db.attemptDailyStats.where("date").below(calendarDate(dailyCutoff)).delete();
  await Promise.all([
    saveHeadCache(settings, committed.cache),
    saveCatalogCache(settings, catalogDescriptor, catalog),
    saveArchiveBacklog(settings, delta.backlog),
    cacheCheckpoint(settings, prepareSyncCheckpoint(checkpoint), [
      { path: checkpointDescriptor.path, sha: checkpointDescriptor.blobSha, appliedAt: generatedAt },
      { path: catalogDescriptor.path, sha: catalogDescriptor.blobSha, appliedAt: generatedAt },
      ...retainedMarkers,
    ]),
  ]);
  report(onProgress, "compact", "远程检查点整理完成", 100);
  return { compacted: true as const, head: committed.head, cache: committed.cache, checkpoint };
}

function splitEventPages(events: SyncEvent[]) {
  const pages: Array<{ events: SyncEvent[]; text: string; size: number }> = [];
  let current: SyncEvent[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = JSON.stringify({ formatVersion: 4, events: current } satisfies EventPagePayload);
    pages.push({ events: current, text, size: new TextEncoder().encode(text).byteLength });
    current = [];
  };
  for (const event of events) {
    const candidate = [...current, event];
    const bytes = new TextEncoder().encode(JSON.stringify({ formatVersion: 4, events: candidate })).byteLength;
    if (candidate.length > SYNC_V4_MAX_EVENT_PAGE_COUNT || bytes > SYNC_V4_MAX_EVENT_PAGE_BYTES) {
      flush();
      const singleBytes = new TextEncoder().encode(JSON.stringify({ formatVersion: 4, events: [event] })).byteLength;
      if (singleBytes > SYNC_V4_MAX_EVENT_PAGE_BYTES) throw new Error("单条同步事件超过 256 KiB，已保留在本机，请缩小该次更改后重试。");
    }
    current.push(event);
  }
  flush();
  return pages;
}

async function uploadPending(
  client: GitHubV4Remote,
  settings: GitHubSettings,
  startHead: SyncHeadV4,
  startCache: SyncV4HeadCache,
  onProgress?: SyncV4ProgressCallback,
) {
  const pending = await db.events.where("synced").equals(0).sortBy("createdAt");
  const selected: SyncEvent[] = [];
  let bytes = 0;
  for (const event of pending) {
    const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (selected.length && bytes + eventBytes > uploadByteLimit) break;
    selected.push(event);
    bytes += eventBytes;
  }
  const pages = splitEventPages(selected);
  const descriptors: SyncEventPageDescriptorV4[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const digest = await sha256(page.text);
    const uploaded = await client.putImmutable({
      path: `${SYNC_V4_EVENT_PREFIX}${digest}.json`,
      bytes: page.text,
      kind: "eventPage",
      sha256: digest,
    });
    descriptors.push({
      path: uploaded.path,
      blobSha: uploaded.blobSha,
      sha256: uploaded.sha256,
      size: uploaded.size,
      count: page.events.length,
      deviceCursors: eventCursors(page.events),
    });
    report(onProgress, "upload", `正在上传本地更改 ${index + 1}/${pages.length}`, (index + 1) / Math.max(1, pages.length) * 75);
  }
  if (!descriptors.length) return { pushed: 0, remaining: pending.length, head: startHead, cache: startCache };
  const expectedHead = startHead;
  let latestHead = startHead;
  let latestCache = startCache;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = appendSyncV4EventPagesAfterCas({ expectedHead, latestHead, newPages: descriptors });
    const result = await client.putHead(next, latestCache);
    if (result.ok) {
      await db.events.bulkPut(selected.map((event) => ({ ...event, synced: 1 as const })));
      await db.syncFiles.bulkPut(descriptors.map((descriptor) => ({ path: descriptor.path, sha: descriptor.blobSha, appliedAt: next.generatedAt })));
      await saveHeadCache(settings, result.cache);
      const remaining = await db.events.where("synced").equals(0).count();
      report(onProgress, "upload", remaining ? `本轮上传完成，还有 ${remaining} 条待同步` : "本地更改上传完成", 100);
      return { pushed: selected.length, remaining, head: result.head, cache: result.cache };
    }
    const refreshed = await client.readHead();
    if (!refreshed.initialized) throw new SyncV4NotInitializedError();
    latestHead = refreshed.head;
    latestCache = refreshed.cache;
  }
  throw new Error("远程资料库正在被其他设备持续更新，本地更改仍安全保留，请稍后重试。");
}

export async function initializeGitHubVaultV4(
  settings: GitHubSettings,
  token: string,
  options: { catalog?: SyncArchiveCatalogV4 } = {},
  onProgress?: SyncV4ProgressCallback,
) {
  const client = remote(settings, token);
  report(onProgress, "prepare", "正在创建 v4 固定同步索引", 8);
  const existing = await client.readHead();
  if (existing.initialized) {
    await saveHeadCache(settings, existing.cache);
    return { initialized: false, head: existing.head, cache: existing.cache };
  }
  const checkpoint = await createSyncCheckpoint();
  const baseCatalog = options.catalog ?? createSyncArchiveCatalogV4(checkpoint.generatedAt);
  const delta = await buildArchiveDelta(client, checkpoint);
  const catalog = appendSyncArchiveSegmentsV4(
    { ...baseCatalog, generatedAt: checkpoint.generatedAt },
    {
      attemptSegments: delta.attemptSegments.map((item) => item.segment),
      practiceRunSegments: delta.runSegments.map((item) => item.segment),
    },
  );
  const [checkpointDescriptor, catalogDescriptor] = await Promise.all([
    putCheckpoint(client, checkpoint),
    putCatalog(client, catalog),
  ]);
  const head: SyncHeadV4 = {
    formatVersion: 4,
    generatedAt: checkpoint.generatedAt,
    checkpoint: checkpointDescriptor,
    archiveCatalog: catalogDescriptor,
    eventPages: [],
  };
  const committed = await client.putHead(head);
  if (!committed.ok) {
    const winner = await client.readHead();
    if (!winner.initialized) throw new Error("v4 同步索引初始化发生冲突，请重新同步。");
    await saveHeadCache(settings, winner.cache);
    return { initialized: false, head: winner.head, cache: winner.cache };
  }
  const attemptIds = delta.attemptSegments.flatMap((item) => item.ids);
  const runIds = delta.runSegments.flatMap((item) => item.ids);
  await Promise.all([
    saveHeadCache(settings, committed.cache),
    saveCatalogCache(settings, catalogDescriptor, catalog),
    saveArchiveBacklog(settings, delta.backlog),
    cacheCheckpoint(settings, prepareSyncCheckpoint(checkpoint), [
      { path: checkpointDescriptor.path, sha: checkpointDescriptor.blobSha, appliedAt: checkpoint.generatedAt },
      { path: catalogDescriptor.path, sha: catalogDescriptor.blobSha, appliedAt: checkpoint.generatedAt },
    ]),
    markSyncArchiveEntries("attempts", attemptIds),
    markSyncArchiveEntries("practice-runs", runIds),
    attemptIds.length ? db.attempts.bulkDelete(attemptIds) : Promise.resolve(),
    runIds.length ? db.practiceRuns.bulkDelete(runIds) : Promise.resolve(),
  ]);
  report(onProgress, "complete", "v4 同步索引创建完成", 100);
  return { initialized: true, head: committed.head, cache: committed.cache };
}

export async function syncWithGitHubV4(settings: GitHubSettings, token: string, onProgress?: SyncV4ProgressCallback) {
  const client = remote(settings, token);
  report(onProgress, "prepare", "正在读取固定同步索引", 3);
  const localHeadCache = await loadHeadCache(settings);
  const read = await client.readHead(localHeadCache);
  if (!read.initialized) throw new SyncV4NotInitializedError();
  await saveHeadCache(settings, read.cache);
  const pendingAtStart = await db.events.where("synced").equals(0).count();
  const archiveBacklog = await hasArchiveBacklog(settings);
  const checkpointMarker = await db.syncFiles.get(read.head.checkpoint.path);
  const checkpointCurrent = checkpointMarker?.sha === read.head.checkpoint.blobSha;
  const pageMarkers = await Promise.all(read.head.eventPages.map((page) => db.syncFiles.get(page.path)));
  const missingPages = read.head.eventPages.filter((page, index) => pageMarkers[index]?.sha !== page.blobSha);
  const allMarkersCurrent = checkpointCurrent && missingPages.length === 0;
  if (read.fromCache && !pendingAtStart && !archiveBacklog && read.head.eventPages.length < compactionFileThreshold && allMarkersCurrent) {
    report(onProgress, "complete", "云端和本机已经一致", 100);
    return { pulled: 0, pushed: 0, remaining: 0, deferred: 0, formatVersion: 4 as const, compacted: false, migrated: false };
  }
  let pulled = 0;
  let head = read.head;
  let headCache = read.cache;
  if (!checkpointCurrent) {
    const pkg = await downloadHotPackage(client, head, range(onProgress, 8, 52));
    const applied = await applyHotPackage(settings, pkg, true);
    pulled = applied.pulled;
  } else if (missingPages.length) {
    const events = await downloadEventPages(client, missingPages, range(onProgress, 8, 52));
    const appliedAt = new Date().toISOString();
    await withSyncRestoreTransaction(async () => {
      await applyRemoteEvents(events);
      await db.syncFiles.bulkPut(missingPages.map((page) => ({ path: page.path, sha: page.blobSha, appliedAt })));
    });
    pulled = events.length;
  }
  // Applying a checkpoint replaces syncMeta, including the ETag cache saved
  // before the merge.  Persist the exact head again only after the atomic
  // merge so the next unchanged sync can use a single conditional GET.
  await saveHeadCache(settings, headCache);
  let compacted = false;
  const hotBytes = head.eventPages.reduce((total, page) => total + page.size, 0);
  if (archiveBacklog || head.eventPages.length >= compactionFileThreshold || hotBytes > SYNC_V4_MAX_EVENT_BYTES - uploadByteLimit) {
    const result = await compact(client, settings, head, headCache, range(onProgress, 54, 78));
    compacted = result.compacted;
    head = result.head;
    headCache = result.cache;
  }
  const upload = await uploadPending(client, settings, head, headCache, range(onProgress, 80, 96));
  if (!upload.remaining) {
    const markers = [upload.head.checkpoint, upload.head.archiveCatalog, ...upload.head.eventPages];
    const current = await Promise.all(markers.map((item) => db.syncFiles.get(item.path)));
    if (current.every((marker, index) => marker?.sha === markers[index].blobSha)) {
      await cacheCurrentState(settings, markers.map((item) => ({ path: item.path, sha: item.blobSha, appliedAt: new Date().toISOString() })));
    }
  }
  report(onProgress, "complete", upload.remaining ? `本轮同步完成，还有 ${upload.remaining} 条待上传` : "同步完成", 100);
  return {
    pulled,
    pushed: upload.pushed,
    remaining: upload.remaining,
    deferred: 0,
    formatVersion: 4 as const,
    compacted,
    migrated: false,
  };
}

export async function restoreFromGitHubV4(settings: GitHubSettings, token: string, onProgress?: SyncV4ProgressCallback) {
  const client = remote(settings, token);
  report(onProgress, "prepare", "正在读取远程恢复索引", 3);
  const read = await client.readHead();
  if (!read.initialized) throw new SyncV4NotInitializedError();
  const pkg = await downloadHotPackage(client, read.head, range(onProgress, 8, 72));
  report(onProgress, "merge", "正在原子替换本地近期数据", 78);
  const applied = await applyHotPackage(settings, pkg, false);
  const cache = await cacheCurrentState(settings, pkg.markers);
  await Promise.all([saveHeadCache(settings, read.cache), saveArchiveBacklog(settings, false)]);
  report(onProgress, "complete", "快速恢复完成", 100);
  return { pulled: applied.pulled, formatVersion: 4 as const, counts: pkg.checkpoint.counts, deferred: 0, cachedAt: cache.cachedAt };
}

async function readArchiveSegment<T>(
  client: GitHubV4Remote,
  descriptor: SyncArchiveSegmentV4,
  kind: "attempts" | "practice-runs",
) {
  const payload = parseJson<ArchivePayload<T>>(await client.readBlob(descriptor), `远程${kind}历史分段`);
  const expectedVersion = descriptor.legacy ? 3 : 4;
  if (payload.formatVersion !== expectedVersion || payload.kind !== kind || !Array.isArray(payload.rows) || payload.rows.length !== descriptor.count) {
    throw new Error(`远程历史分段格式无效：${descriptor.path}`);
  }
  return payload.rows;
}

export async function loadAttemptHistoryV4(
  settings: GitHubSettings,
  token: string,
  options: { month?: string; questionId?: string } = {},
) {
  const client = remote(settings, token);
  const read = await client.readHead(await loadHeadCache(settings));
  if (!read.initialized) throw new SyncV4NotInitializedError();
  const catalog = await readCatalog(client, settings, read.head);
  const segments = options.month ? catalog.attemptSegments.filter((segment) => segment.month === options.month) : catalog.attemptSegments;
  let loaded = 0;
  for (const segment of segments) {
    const rows = await readArchiveSegment<Attempt>(client, segment, "attempts");
    const filtered = options.questionId ? rows.filter((row) => row.questionId === options.questionId) : rows;
    if (filtered.length) {
      await db.attempts.bulkPut(filtered);
      await markSyncArchiveEntries("attempts", filtered.map((row) => row.id));
      loaded += filtered.length;
    }
  }
  await saveHeadCache(settings, read.cache);
  return { loaded, segments: segments.length };
}

export async function restoreFullHistoryFromGitHubV4(settings: GitHubSettings, token: string, onProgress?: SyncV4ProgressCallback) {
  const client = remote(settings, token);
  report(onProgress, "prepare", "正在读取完整恢复索引", 2);
  const read = await client.readHead();
  if (!read.initialized) throw new SyncV4NotInitializedError();
  const [pkg, catalog] = await Promise.all([
    downloadHotPackage(client, read.head, range(onProgress, 4, 38)),
    readCatalog(client, settings, read.head),
  ]);
  await clearSyncRestoreStage();
  let archivedAttempts = 0;
  let archivedPracticeRuns = 0;
  try {
    const all = [
      ...catalog.attemptSegments.map((segment) => ({ kind: "attempts" as const, segment })),
      ...catalog.practiceRunSegments.map((segment) => ({ kind: "practice-runs" as const, segment })),
    ];
    let completed = 0;
    await mapConcurrent(all, downloadConcurrency, async ({ kind, segment }) => {
      if (kind === "attempts") {
        const rows = await readArchiveSegment<Attempt>(client, segment, kind);
        await stageSyncRestoreAttempts(rows);
        archivedAttempts += rows.length;
      } else {
        const rows = await readArchiveSegment<PracticeRun>(client, segment, kind);
        await stageSyncRestorePracticeRuns(rows);
        archivedPracticeRuns += rows.length;
      }
      completed += 1;
      report(onProgress, "history", `正在分段下载历史 ${completed}/${all.length}`, 40 + completed / Math.max(1, all.length) * 42);
    });
    report(onProgress, "merge", "正在原子提交全部历史", 88);
    await commitStagedSyncRestore(pkg.checkpointPlan, async () => {
      await applyRemoteEvents(pkg.events);
      await db.syncFiles.bulkPut(pkg.markers);
    });
    const cache = await cacheCurrentState(settings, pkg.markers);
    await Promise.all([saveHeadCache(settings, read.cache), saveArchiveBacklog(settings, false)]);
    report(onProgress, "complete", "完整恢复完成", 100);
    return {
      pulled: pkg.events.length,
      formatVersion: 4 as const,
      counts: pkg.checkpoint.counts,
      deferred: 0,
      cachedAt: cache.cachedAt,
      archivedAttempts,
      archivedPracticeRuns,
    };
  } catch (error) {
    await clearSyncRestoreStage();
    report(onProgress, "merge", "完整恢复失败，本地数据保持不变", 96);
    throw error;
  }
}

export async function verifyGitHubVaultV4(settings: GitHubSettings, token: string) {
  const read = await remote(settings, token).readHead();
  return read.initialized ? 4 as const : 0 as const;
}
