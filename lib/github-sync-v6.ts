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
  isRunDefinitionV6,
  putImageAssetBlobV6,
  runDefinitionRefsFromEvents,
  serializeRunDefinition,
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
  SYNC_V6_EVENT_PAGE_CONSOLIDATE_COUNT,
  SYNC_V6_MAX_EVENT_PAGES,
  SYNC_V6_MAX_HOT_EVENT_BYTES,
  encodeSyncV6Event,
  mergeSyncV6EventPages,
  planSyncV6HotTail,
  validateSyncHeadV6,
  type SyncHeadV6,
  type SyncV6Descriptor,
  type SyncV6EventPageDescriptor,
  type SyncV6HotTailPlan,
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
import type { RunDefinitionV6 } from "./db-v6";
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

/**
 * Maximum concurrent immutable blob downloads during a sync.  Event pages,
 * archive segments and run definitions are independent content-addressed reads,
 * so they parallelise safely; the bound keeps the request rate predictable for
 * GitHub's API and for flaky proxies (a single oversized blob is still one
 * request — this only affects the many small page/segment reads).
 */
const SYNC_V6_DOWNLOAD_CONCURRENCY = 6;

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order in the
 * result.  `onProgress` fires once per completion (not per start) so callers can
 * report "n/total" regardless of which request finished first.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const total = items.length;
  const results = new Array<R>(total);
  if (!total) return results;
  let cursor = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      results[index] = await fn(items[index], index);
      completed += 1;
      onProgress?.(completed, total);
    }
  }
  const workers = Array.from({ length: Math.min(SYNC_V6_DOWNLOAD_CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);
  return results;
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
  const pages = await mapWithConcurrency(
    head.eventPages,
    (descriptor) => client.readBlob(descriptor).then((bytes) => parseEventPage(bytes, descriptor)),
    (completed, total) => report(onProgress, "download", `正在下载近期更改 ${completed}/${total}`, 12 + completed / Math.max(1, total) * 60),
  );
  const events: V6Event[] = pages.flat();
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
  const payloads = await mapWithConcurrency(
    all,
    async ({ kind, segment }) => {
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
      return { kind, rows };
    },
    (completed, total) => report(onProgress, "history", `正在下载完整历史 ${completed}/${total}`, 40 + completed / Math.max(1, total) * 36),
  );
  for (const { kind, rows } of payloads) {
    if (kind === "attempts") attempts.push(...rows as AttemptV6[]);
    else practiceRuns.push(...rows as PracticeRunV6[]);
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
  const nextState = { ...state, attempts, practiceRuns };
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
    // Content addressing makes an existing remote descriptor authoritative:
    // the same id/size can only describe the same bytes, so an already
    // published asset needs no second upload (or 422 reconcile) on this sync.
    const alreadyPublished = Boolean(
      asset.remote && asset.remote.path === expectedPath && asset.remote.sha256 === asset.id && asset.remote.size === asset.size,
    );
    if (!alreadyPublished && asset.blob) {
      const blobSha256 = await sha256Blob(asset.blob);
      if (blobSha256 !== asset.id) throw new Error(`图片 ${asset.id} 本地 Blob 摘要校验失败。`);
      const uploaded = await client.putImmutable({ path: expectedPath, bytes: new Uint8Array(await asset.blob.arrayBuffer()), kind: "asset", sha256: asset.id, size: asset.size });
      const remoteDescriptor = { path: expectedPath, blobSha: uploaded.blobSha, sha256: asset.id, size: asset.size };
      // Metadata is part of the v6 checkpoint.  Do not emit a second domain
      // event here: the immutable checkpoint itself captures this update.
      await dbV6.imageAssets.put({ ...asset, remote: remoteDescriptor });
    } else if (!alreadyPublished) {
      throw new Error(`图片 ${asset.id} 缺少本地 Blob，无法首次上传远端资产。`);
    }
    if (asset.blob) files.push({ path: expectedPath, bytes: new Uint8Array(await asset.blob.arrayBuffer()), kind: "asset" });
    report(onProgress, "upload", `正在准备图片资产 ${index}/${assets.length}`, 4 + index / Math.max(1, assets.length) * 16);
  }
  return files;
}

/**
 * Publish the immutable run definitions referenced by pending run events.
 * Each object is deterministic (content addressed), so the local
 * `definitionSynced` marker skips every later sync.  A run deleted before its
 * events publish needs no object: its tombstone is published in the same
 * head, and replay applies the tombstone before materializing the run.
 */
async function ensureRunDefinitions(client: GitHubV6Remote, pending: readonly V6Event[]): Promise<SyncV6PublicationFile[]> {
  const wanted = runDefinitionRefsFromEvents(pending);
  const files: SyncV6PublicationFile[] = [];
  for (const [path, ref] of wanted) {
    const run = await dbV6.practiceRuns.get(ref.runId);
    if (!run || run.definitionSynced) continue;
    const { bytes, sha256 } = await serializeRunDefinition(run);
    if (sha256 !== ref.sha256 || digestPath(SYNC_V6_IMMUTABLE_PREFIX, sha256) !== path) {
      throw new Error(`练习 ${ref.runId} 的定义与事件引用不一致`);
    }
    await client.putImmutable({ path, bytes, kind: "immutable" });
    files.push({ path, bytes, kind: "immutable" });
    await dbV6.practiceRuns.put({ ...run, definitionSynced: true });
  }
  return files;
}

/**
 * Resolve every run definition referenced by new-format run events before
 * atomic restore.  Definitions derivable from the checkpoint's own run
 * projections need no fetch (the restore derives them locally); the rest are
 * pulled from the vault and integrity checked against the event's ref.
 */
async function collectRunDefinitions(client: GitHubV6Remote, checkpoint: SyncCheckpointV6, events: readonly V6Event[], onProgress?: (completed: number, total: number) => void): Promise<Record<string, RunDefinitionV6>> {
  // Runs that are already tombstoned in the checkpoint or removed by a
  // run.deleted event in this batch end deleted: their definition is never
  // needed (materialization is skipped during apply), so do not fetch it.
  const doomed = new Set(checkpoint.state.tombstones.filter((tombstone) => tombstone.entityType === "practiceRun").map((tombstone) => tombstone.entityId));
  for (const event of events) {
    if (event.type === "practice.run.deleted") {
      const payload = event.payload as { id?: unknown; runId?: unknown } | undefined;
      const id = typeof payload?.runId === "string" ? payload.runId : (typeof payload?.id === "string" ? payload.id : undefined);
      if (id) doomed.add(id);
    }
  }
  const wanted = [...runDefinitionRefsFromEvents(events)].filter(([, ref]) => !doomed.has(ref.runId));
  const entries = await mapWithConcurrency(wanted, async ([path, ref]) => {
    const run = checkpoint.state.practiceRuns.find((item) => item.id === ref.runId);
    if (run) {
      const derived = await serializeRunDefinition(run);
      if (derived.sha256 === ref.sha256) return [path, derived.value] as const;
      throw new Error(`练习 ${ref.runId} 的定义与检查点投影不一致`);
    }
    const bytes = await client.readImmutableContents(path, { sha256: ref.sha256, size: ref.size });
    const definition = parseJson<RunDefinitionV6>(bytes, `练习定义 ${path}`);
    if (!isRunDefinitionV6(definition) || definition.runId !== ref.runId) throw new Error(`练习定义对象 ${path} 内容无效`);
    return [path, definition] as const;
  }, onProgress);
  return Object.fromEntries(entries);
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

/** A placeholder descriptor marks an uninitialised (migration/initial) head. */
function isPlaceholderDescriptor(descriptor: SyncV6Descriptor): boolean {
  return /\/0{64}\.json$/.test(descriptor.path);
}

/**
 * Decide whether the merged event tail (existing hot pages plus the new batch)
 * stays inside the bounded hot window.  When it does not, publication must
 * write a fresh checkpoint so the head can trim back to the new batch only.
 */
function mergedEventPagesFit(existing: readonly SyncV6EventPageDescriptor[], additions: readonly SyncV6PublicationFile[]): boolean {
  const paths = new Set<string>(existing.map((page) => page.path));
  let bytes = existing.reduce((sum, page) => sum + page.size, 0);
  for (const file of additions) {
    paths.add(file.path);
    bytes += file.bytes instanceof Uint8Array ? file.bytes.byteLength : file.bytes instanceof ArrayBuffer ? file.bytes.byteLength : new TextEncoder().encode(String(file.bytes)).byteLength;
  }
  return paths.size <= SYNC_V6_MAX_EVENT_PAGES && bytes <= SYNC_V6_MAX_HOT_EVENT_BYTES;
}

/** Encode hot-tail pages into content-addressed event page files (paths filled). */
async function encodePageFiles(hot: SyncV6HotTailPlan<V6Event>): Promise<SyncV6PublicationFile[]> {
  const pageFiles: SyncV6PublicationFile[] = hot.pages.map((page) => ({ path: digestPath(SYNC_V6_EVENT_PREFIX, ""), bytes: page.bytes, kind: "eventPage" }));
  for (let index = 0; index < pageFiles.length; index += 1) {
    const page = pageFiles[index];
    const bytes = page.bytes instanceof Uint8Array ? page.bytes : new TextEncoder().encode(String(page.bytes));
    pageFiles[index] = { ...page, path: digestPath(SYNC_V6_EVENT_PREFIX, await digest(bytes)) };
  }
  return pageFiles;
}

/**
 * Re-pack the checkpoint tail once sparse incremental pages make a full
 * download (new device / restore) fetch too many small files.  Downloads every
 * existing hot page, appends the new batch, and returns a fresh few-page tail
 * that replaces the sparse pages in the head.  Returns null when the head is
 * already compact, or when the merged tail cannot stay inside the bounded hot
 * window (the caller then falls back to a fresh checkpoint instead).
 */
async function tryConsolidateEventPages(
  client: GitHubV6Remote,
  head: SyncHeadV6,
  newEvents: readonly V6Event[],
  onProgress?: SyncV6ProgressCallback,
): Promise<{ hot: SyncV6HotTailPlan<V6Event>; pageFiles: SyncV6PublicationFile[] } | null> {
  if (head.eventPages.length < SYNC_V6_EVENT_PAGE_CONSOLIDATE_COUNT) return null;
  report(onProgress, "upload", `正在合并 ${head.eventPages.length} 个近期更改分页`, 58);
  const pages = await mapWithConcurrency(
    head.eventPages,
    (descriptor) => client.readBlob(descriptor).then((bytes) => parseEventPage(bytes, descriptor)),
    (completed, total) => report(onProgress, "upload", `正在合并近期更改 ${completed}/${total}`, 58 + completed / Math.max(1, total) * 8),
  );
  // Existing pages are ordered as the head lists them; the new local batch is
  // appended in its own sequence, preserving the same replay order a full
  // download would use.  applyV6Event dedupes by event id, so an overlapping
  // page is idempotent for devices that already hold part of the tail.
  const hot = planSyncV6HotTail([...pages.flat(), ...newEvents]);
  if (hot.requiresCheckpoint) return null;
  return { hot, pageFiles: await encodePageFiles(hot) };
}

/**
 * Decide the archive catalog for the next head.  The catalog is content
 * addressed and immutable, so an existing real catalog is preserved simply by
 * reusing its descriptor; only the empty placeholder needs a fresh publish.
 */
async function catalogForPublication(expectedHead: SyncHeadV6, checkpoint: SyncCheckpointV6): Promise<{ reuse: SyncV6Descriptor } | { fresh: SyncV6PublicationFile }> {
  if (isPlaceholderDescriptor(expectedHead.archiveCatalog)) {
    const catalog = createSyncV6ArchiveCatalog(checkpoint);
    const catalogBytes = new TextEncoder().encode(JSON.stringify(catalog));
    return { fresh: { path: digestPath(SYNC_V6_ARCHIVE_CATALOG_PREFIX, await digest(catalogBytes)), bytes: catalogBytes, kind: "archiveCatalog" } };
  }
  return { reuse: expectedHead.archiveCatalog };
}

async function publicationFor(
  client: GitHubV6Remote,
  checkpoint: SyncCheckpointV6,
  pending: readonly V6Event[],
  expectedHead: SyncHeadV6,
  assetFiles: SyncV6PublicationFile[] | undefined,
  onProgress?: SyncV6ProgressCallback,
): Promise<{ files: SyncV6PublicationFile[]; head: SyncHeadV6; pendingIds: string[]; compacted: boolean }> {
  const assets = assetFiles ?? await ensureAssetFiles(client, range(onProgress, 0, 24));
  const events = pendingEventsForUpload(pending);
  // Run definitions are immutable objects referenced by run events; they are
  // published alongside the pages, always before the head CAS.
  const definitionFiles = await ensureRunDefinitions(client, pending);
  // Once incremental pages accumulate past the threshold, re-pack the whole
  // checkpoint tail into full pages so a new device or restore downloads one
  // or two objects instead of many sparse ones.  A merged tail that would
  // overflow the hot window falls back to a fresh checkpoint below.
  const consolidated = await tryConsolidateEventPages(client, expectedHead, events, onProgress);
  const hot = consolidated ? consolidated.hot : planSyncV6HotTail(events);
  const pageFiles = consolidated ? consolidated.pageFiles : await encodePageFiles(hot);
  // A fresh checkpoint is required when the remote head is still a placeholder,
  // when the merged tail would overflow the hot window, or when any pending
  // event cannot fit an event page and must be covered by the checkpoint
  // projection instead.  A consolidated tail replaces the pages wholesale, so
  // the append-fit check only applies to the plain incremental path.
  const compacted = isPlaceholderDescriptor(expectedHead.checkpoint)
    || hot.requiresCheckpoint
    || events.length < pending.length
    || (!consolidated && !mergedEventPagesFit(expectedHead.eventPages, pageFiles));
  const catalog = await catalogForPublication(expectedHead, checkpoint);

  if (compacted) {
    const checkpointBytes = encodeSyncCheckpointV6(checkpoint);
    const checkpointSha = await digest(checkpointBytes);
    const immutable: SyncV6PublicationFile[] = [
      { path: digestPath(SYNC_V6_CHECKPOINT_PREFIX, checkpointSha), bytes: checkpointBytes, kind: "checkpoint" },
    ];
    const catalogFile = "fresh" in catalog ? catalog.fresh : undefined;
    if (catalogFile) immutable.push(catalogFile);
    immutable.push(...pageFiles);
    const uploadedDescriptors = new Map<string, SyncV6Descriptor>();
    for (const file of immutable) {
      const uploaded = await client.putImmutable(file);
      uploadedDescriptors.set(file.path, { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size });
    }
    const checkpointDescriptor = uploadedDescriptors.get(immutable[0].path)!;
    const catalogDescriptor = catalogFile ? uploadedDescriptors.get(catalogFile.path)! : expectedHead.archiveCatalog;
    const pageDescriptors: SyncV6EventPageDescriptor[] = pageFiles.map((file, index) => {
      const descriptor = uploadedDescriptors.get(file.path)!;
      const pageEvents = hot.pages[index].events as V6Event[];
      return { ...descriptor, count: pageEvents.length, deviceCursors: eventCursors(pageEvents) };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const nextHead: SyncHeadV6 = {
      formatVersion: 6,
      generatedAt: checkpoint.generatedAt,
      checkpoint: checkpointDescriptor,
      archiveCatalog: catalogDescriptor,
      eventPages: pageDescriptors,
    };
    validateSyncHeadV6(nextHead);
    // Events omitted from the hot tail are still covered by this complete
    // checkpoint.  They are acknowledged only after the head CAS succeeds.
    return { files: [...assets, ...immutable, ...definitionFiles], head: nextHead, pendingIds: pending.map((event) => event.id), compacted: true };
  }

  // Incremental publication: the remote checkpoint already covers everything
  // before the hot window, so append only the new event pages and reuse the
  // existing checkpoint and archive catalog descriptors without re-uploading.
  const uploadedDescriptors = new Map<string, SyncV6Descriptor>();
  for (const file of pageFiles) {
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
    checkpoint: expectedHead.checkpoint,
    archiveCatalog: expectedHead.archiveCatalog,
    eventPages: consolidated ? pageDescriptors : mergeSyncV6EventPages(expectedHead.eventPages, pageDescriptors),
  };
  validateSyncHeadV6(nextHead);
  return { files: [...assets, ...pageFiles, ...definitionFiles], head: nextHead, pendingIds: pending.map((event) => event.id), compacted: false };
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

async function applyDownloadedState(client: GitHubV6Remote, state: DownloadedV6State, preservePending: boolean, onProgress?: SyncV6ProgressCallback): Promise<number> {
  report(onProgress, "merge", "正在准备练习定义", 78);
  const definitions = await collectRunDefinitions(client, state.checkpoint, state.events, (completed, total) => {
    report(onProgress, "merge", `正在读取练习定义 ${completed}/${total}`, 78 + completed / Math.max(1, total) * 10);
  });
  report(onProgress, "merge", "正在原子应用 v6 检查点和事件", 88);
  const result = await applySyncCheckpointV6(state.checkpoint, state.events, { preservePending }, definitions);
  await dbV6.syncFiles.bulkPut(state.markers);
  report(onProgress, "merge", `已应用 ${result.applied} 条远程事件`, 90);
  return result.applied;
}

async function applyMissingPages(client: GitHubV6Remote, descriptors: readonly SyncV6EventPageDescriptor[]): Promise<number> {
  if (!descriptors.length) return 0;
  const pages = await mapWithConcurrency(descriptors, (descriptor) => client.readBlob(descriptor).then((bytes) => parseEventPage(bytes, descriptor)));
  const events: V6Event[] = pages.flat();
  // Rebuilding the local checkpoint here gives event application the same
  // atomic rollback semantics as a full restore without reading any legacy DB.
  const checkpoint = await createSyncCheckpointV6();
  const definitions = await collectRunDefinitions(client, checkpoint, events);
  const result = await applySyncCheckpointV6(checkpoint, events, { preservePending: true }, definitions);
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
      pulled += await applyDownloadedState(client, downloaded, true, onProgress);
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
      return { pulled, pushed: publication.pendingIds.length, remaining, deferred: 0, formatVersion: 6 as const, compacted: publication.compacted, migrated: false };
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
  if (!current.checkpoint) pulled = await applyDownloadedState(client, await downloadState(client, read, range(onProgress, 12, 86)), true, onProgress);
  else if (current.pages.length) pulled = await applyMissingPages(client, current.pages);
  await saveHeadCache(settings, read.cache);
  report(onProgress, "complete", pulled ? `已合并 ${pulled} 条远程更改` : "云端没有新数据", 100);
  return { pulled, formatVersion: 6 as const };
}

async function restoreRemote(settings: GitHubSettings, token: string, onProgress: SyncV6ProgressCallback | undefined, preservePending: boolean) {
  const client = remote(settings, token);
  const read = await readHeadOrThrow(client, settings);
  const downloaded = await downloadState(client, read, range(onProgress, 8, 76));
  const pulled = await applyDownloadedState(client, downloaded, preservePending, onProgress);
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
  report(onProgress, "merge", "正在读取练习定义", 80);
  const definitions = await collectRunDefinitions(client, merged, downloaded.events, (completed, total) => {
    report(onProgress, "merge", `正在读取练习定义 ${completed}/${total}`, 80 + completed / Math.max(1, total) * 8);
  });
  report(onProgress, "merge", "正在原子提交 v6 完整历史", 88);
  const applied = await applySyncCheckpointV6(merged, downloaded.events, { preservePending: false }, definitions);
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
