import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { GitHubV5Remote, type SyncV5HeadReadResult } from "../lib/github-v5-remote";
import { GitHubV6Remote } from "../lib/github-v6-remote";
import {
  SYNC_V5_EVENT_PAYLOAD_PREFIX,
  SYNC_V5_PRACTICE_DEFINITION_PREFIX,
  validateSyncV5Descriptor,
} from "../lib/sync-v5-head";
import { validateSyncArchiveCatalogV5 } from "../lib/sync-v5-catalog";
import type {
  Attempt,
  PracticeRun,
  SyncArchiveCatalogV5,
  SyncArchiveSegmentV5,
  SyncCheckpointV5,
  SyncEvent,
  SyncHeadDescriptorV5,
} from "../lib/types";
import {
  convertV5ToV6,
  collectFinalV5ImageUrls,
  type HydratedV5Event,
  type PreparedMigrationImage,
  type V5ToV6Conversion,
} from "../lib/v5-to-v6-converter";
import type { ImageMimeType } from "../lib/image-assets";

const MAX_SOURCE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;
const IMAGE_TIMEOUT_MS = 12_000;
const DEFAULT_BRANCH = "main";

export interface LegacyImageProcessorInput {
  url: string;
  bytes: Uint8Array;
  mimeType: string;
}

export type LegacyImageProcessorResult = Omit<PreparedMigrationImage, "id" | "sourceUrl"> & { id?: string; sourceUrl?: string };
export type LegacyImageProcessor = (input: LegacyImageProcessorInput) => LegacyImageProcessorResult | Promise<LegacyImageProcessorResult>;

export interface V5ToV6MigrationOptions {
  owner: string;
  repo: string;
  branch?: string;
  token: string;
  apply?: boolean;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  imageProcessor?: LegacyImageProcessor;
  now?: () => string;
}

export interface V5RemotePackage {
  head: SyncV5HeadReadResult & { initialized: true; head: NonNullable<SyncV5HeadReadResult["head"]> };
  checkpoint: SyncCheckpointV5;
  catalog: SyncArchiveCatalogV5;
  archiveAttempts: Attempt[];
  archivePracticeRuns: PracticeRun[];
  hotEvents: HydratedV5Event[];
}

export interface V5ToV6MigrationResult {
  dryRun: boolean;
  applied: boolean;
  conversion: V5ToV6Conversion;
  sourceHeadBlobSha: string;
  failures: string[];
  writes: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function assertCheckpoint(value: unknown): asserts value is SyncCheckpointV5 {
  const checkpoint = asRecord(value);
  const state = asRecord(checkpoint?.state);
  if (checkpoint?.formatVersion !== 5 || !state
    || !Array.isArray(state.banks) || !Array.isArray(state.bankFolders) || !Array.isArray(state.questions)
    || !Array.isArray(state.attemptStats) || !Array.isArray(state.recentAttemptDailyStats)
    || !Array.isArray(state.recentAttempts) || !Array.isArray(state.notes)
    || !Array.isArray(state.recentPracticeRuns) || !Array.isArray(state.practiceRunStats)
    || !Array.isArray(state.questionGroups) || !Array.isArray(state.tombstones)) {
    throw new Error("远程 v5 检查点缺少必要的数据集合。");
  }
}

function assertEventPage(value: unknown, path: string): SyncEvent[] {
  const record = asRecord(value);
  if (!record || record.formatVersion !== 5 || !Array.isArray(record.events)) throw new Error(`远程事件分页格式无效：${path}`);
  return record.events as SyncEvent[];
}

function assertArchiveRows<T extends { id: string }>(value: unknown, descriptor: SyncArchiveSegmentV5, kind: "attempts" | "practice-runs"): T[] {
  const record = asRecord(value);
  if (record?.formatVersion !== 5 || record.kind !== kind || !Array.isArray(record.rows) || record.rows.length !== descriptor.count) {
    throw new Error(`远程${kind}历史分段格式无效：${descriptor.path}`);
  }
  return record.rows as T[];
}

function assertSha1(value: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("远程 v5 head 没有有效的 Git blob SHA。");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceDescriptor(value: unknown, kind: "practiceDefinition" | "eventPayload"): SyncHeadDescriptorV5 {
  validateSyncV5Descriptor(value, kind);
  return value;
}

function practiceRunFromDefinition(value: unknown): PracticeRun {
  const definition = asRecord(value);
  if (!definition || typeof definition.id !== "string" || typeof definition.bankId !== "string"
    || !Array.isArray(definition.bankIds) || typeof definition.bankName !== "string"
    || typeof definition.mode !== "string" || typeof definition.modeLabel !== "string"
    || !Array.isArray(definition.questionIds) || !asRecord(definition.questionTypes)
    || typeof definition.shuffleOptions !== "boolean" || !asRecord(definition.optionOrders)
    || typeof definition.startedAt !== "string") throw new Error("远程练习定义格式无效。");
  return {
    ...(definition as unknown as PracticeRun),
    answers: {},
    updatedAt: definition.startedAt,
    status: "in_progress",
    revision: 1,
    definitionSynced: true,
  };
}

async function readJson(client: GitHubV5Remote, descriptor: SyncHeadDescriptorV5, label: string): Promise<unknown> {
  return parseJson(await client.readBlob(descriptor), label);
}

async function hydrateEvents(client: GitHubV5Remote, events: readonly SyncEvent[]): Promise<HydratedV5Event[]> {
  const payloads = new Map<string, unknown>();
  const definitions = new Map<string, PracticeRun>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const payloadReference = asRecord(payload?.eventPayload)?.path ? payload?.eventPayload : undefined;
    if (payloadReference) {
      const descriptor = sourceDescriptor(payloadReference, "eventPayload");
      if (!descriptor.path.startsWith(SYNC_V5_EVENT_PAYLOAD_PREFIX)) throw new Error(`事件载荷路径不在 v5 命名空间：${descriptor.path}`);
      if (!payloads.has(descriptor.path)) {
        const attachment = asRecord(await readJson(client, descriptor, "远程事件载荷"));
        if (attachment?.formatVersion !== 5 || attachment.kind !== "event-payload") throw new Error(`远程事件载荷格式无效：${descriptor.path}`);
        payloads.set(descriptor.path, attachment.payload);
      }
    }
    const sourcePayload = payloadReference ? payloads.get((payloadReference as SyncHeadDescriptorV5).path) : event.payload;
    const source = asRecord(sourcePayload);
    const definitionRef = event.type === "practice.run.created"
      ? asRecord(source?.definition)?.path ? source?.definition : undefined
      : event.type === "practice.answer.submitted"
        ? asRecord(source?.run)?.definition && asRecord(source?.run)?.definition && asRecord((source?.run as Record<string, unknown>).definition)?.path
          ? (source?.run as Record<string, unknown>).definition
          : undefined
        : undefined;
    if (definitionRef) {
      const descriptor = sourceDescriptor(definitionRef, "practiceDefinition");
      if (!descriptor.path.startsWith(SYNC_V5_PRACTICE_DEFINITION_PREFIX)) throw new Error(`练习定义路径不在 v5 命名空间：${descriptor.path}`);
      if (!definitions.has(descriptor.path)) {
        const definitionPayload = asRecord(await readJson(client, descriptor, "远程练习定义"));
        if (definitionPayload?.formatVersion !== 5 || definitionPayload.kind !== "practice-run-definition") throw new Error(`远程练习定义格式无效：${descriptor.path}`);
        definitions.set(descriptor.path, practiceRunFromDefinition(definitionPayload.definition));
      }
    }
  }
  return events.map((event) => {
    const payload = asRecord(event.payload);
    const payloadReference = asRecord(payload?.eventPayload)?.path ? payload?.eventPayload : undefined;
    const hydratedPayload = payloadReference ? payloads.get((payloadReference as SyncHeadDescriptorV5).path) : event.payload;
    const source = asRecord(hydratedPayload);
    const definitionRef = event.type === "practice.run.created"
      ? asRecord(source?.definition)?.path ? source?.definition : undefined
      : event.type === "practice.answer.submitted"
        ? asRecord(source?.run)?.definition && asRecord((source?.run as Record<string, unknown>).definition)?.path
          ? (source?.run as Record<string, unknown>).definition
          : undefined
        : undefined;
    const resolvedPayload = definitionRef ? definitions.get((definitionRef as SyncHeadDescriptorV5).path) : undefined;
    return { ...event, payload: hydratedPayload, ...(resolvedPayload ? { resolvedPayload } : {}) };
  });
}

/** Read every v5 object named by the head/catalog.  This function only issues GET requests. */
export async function readV5RemotePackage(options: Pick<V5ToV6MigrationOptions, "owner" | "repo" | "branch" | "token" | "fetch" | "apiBaseUrl">): Promise<V5RemotePackage> {
  const settings = { owner: options.owner, repo: options.repo, branch: options.branch ?? DEFAULT_BRANCH, token: options.token, fetch: options.fetch, apiBaseUrl: options.apiBaseUrl };
  const client = new GitHubV5Remote(settings);
  const read = await client.readHead();
  if (!read.initialized || !read.head || !read.blobSha) throw new Error("远程没有可迁移的 v5 head，或 head 缺少 blob SHA。");
  assertSha1(read.blobSha);
  const checkpointValue = await readJson(client, read.head.checkpoint, "远程 v5 检查点");
  assertCheckpoint(checkpointValue);
  const catalogValue = await readJson(client, read.head.archiveCatalog, "远程 v5 历史目录");
  validateSyncArchiveCatalogV5(catalogValue);
  const catalog = catalogValue;
  const archiveAttempts: Attempt[] = [];
  const archivePracticeRuns: PracticeRun[] = [];
  for (const segment of catalog.attemptSegments) archiveAttempts.push(...await readArchiveSegment(client, segment, "attempts"));
  for (const segment of catalog.practiceRunSegments) archivePracticeRuns.push(...await readArchiveSegment(client, segment, "practice-runs"));
  const hotEvents: SyncEvent[] = [];
  for (const page of read.head.eventPages) {
    const events = assertEventPage(await readJson(client, page, "远程 v5 事件分页"), page.path);
    if (events.length !== page.count) throw new Error(`远程事件分页数量与 head 不一致：${page.path}`);
    const cursors: Record<string, number> = {};
    for (const event of events) cursors[event.deviceId] = Math.max(cursors[event.deviceId] ?? 0, event.sequence);
    for (const [deviceId, sequence] of Object.entries(page.deviceCursors)) {
      if (cursors[deviceId] !== sequence) throw new Error(`远程事件分页游标校验失败：${page.path}`);
    }
    hotEvents.push(...events);
  }
  return {
    head: read as V5RemotePackage["head"],
    checkpoint: checkpointValue,
    catalog,
    archiveAttempts,
    archivePracticeRuns,
    hotEvents: await hydrateEvents(client, hotEvents),
  };
}

async function readArchiveSegment<T extends { id: string }>(client: GitHubV5Remote, descriptor: SyncArchiveSegmentV5, kind: "attempts" | "practice-runs"): Promise<T[]> {
  return assertArchiveRows<T>(await readJson(client, descriptor, `远程${kind}历史分段`), descriptor, kind);
}

function normalizedMime(value: string | null | undefined): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function ipv4Private(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0) || (a === 198 && b === 51) || (a === 203 && b === 0) || a >= 224;
}

function ipv6Private(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8")
    || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("::ffff:");
}

export function validateLegacyImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("图片地址不是有效 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("图片地址只允许 http(s)");
  if (url.username || url.password) throw new Error("图片地址不得包含凭据");
  const defaultPort = url.protocol === "http:" ? "80" : "443";
  if (url.port && url.port !== defaultPort) throw new Error("图片地址不得使用非默认端口");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || ipv4Private(hostname) || ipv6Private(hostname)) {
    throw new Error("图片地址指向环回或私网主机");
  }
  return url;
}

function magicMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.subarray(0, 6)))) return "image/gif";
  return undefined;
}

function dimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  if (mimeType === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (mimeType === "image/webp" && bytes.length >= 30) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunk = new TextDecoder().decode(bytes.subarray(12, 16));
    if (chunk === "VP8X" && bytes.length >= 30) {
      const width = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
      const height = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (chunk === "VP8L" && bytes.length >= 26 && view.getUint8(20) === 0x2f) {
      const width = 1 + ((view.getUint8(21) | (view.getUint8(22) << 8) | ((view.getUint8(23) & 0x3f) << 16)) & 0x3fff);
      const height = 1 + (((view.getUint8(23) >> 6) | (view.getUint8(24) << 2) | ((view.getUint8(25) & 0x3f) << 10)) & 0x3fff);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
  }
  if (mimeType === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker === 0xda) break;
      if (offset + 1 >= bytes.length) break;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSof && length >= 7) {
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      offset += length;
    }
  }
  return undefined;
}

async function fetchImage(url: URL, fetchImpl: typeof fetch): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let current = url;
  for (let redirect = 0; redirect <= MAX_IMAGE_REDIRECTS; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), { method: "GET", redirect: "manual", signal: controller.signal, headers: { Accept: "image/*" } });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirect >= MAX_IMAGE_REDIRECTS) throw new Error("图片重定向次数超过上限");
      const location = response.headers.get("location");
      if (!location) throw new Error("图片重定向缺少 Location");
      current = validateLegacyImageUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`图片下载失败（${response.status}）`);
    const length = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > MAX_SOURCE_IMAGE_BYTES) throw new Error("图片 Content-Length 超过原图上限");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) throw new Error("图片实际字节超过原图上限");
    const declared = normalizedMime(response.headers.get("content-type"));
    const actual = magicMime(bytes);
    if (!actual || (declared && declared !== actual)) throw new Error("图片 MIME 与文件魔数不匹配");
    return { bytes, mimeType: actual };
  }
  throw new Error("图片重定向失败");
}

function outputMime(value: unknown): value is ImageMimeType {
  return value === "image/webp" || value === "image/jpeg" || value === "image/png";
}

async function preflightImages(
  urls: readonly string[],
  options: Pick<V5ToV6MigrationOptions, "fetch" | "imageProcessor">,
): Promise<{ assets: Map<string, PreparedMigrationImage>; failures: string[] }> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const assets = new Map<string, PreparedMigrationImage>();
  const failures: string[] = [];
  for (const value of [...new Set(urls.filter(Boolean))]) {
    try {
      const url = validateLegacyImageUrl(value);
      const source = await fetchImage(url, fetchImpl);
      let prepared: PreparedMigrationImage;
      if (options.imageProcessor) {
        const processed = await options.imageProcessor({ url: value, bytes: source.bytes, mimeType: source.mimeType });
        prepared = {
          ...processed,
          sourceUrl: processed.sourceUrl ?? value,
          id: processed.id ?? sha256(processed.bytes),
        };
      }
      else if (outputMime(source.mimeType) && source.bytes.byteLength <= 2 * 1024 * 1024) {
        const sourceDimensions = dimensions(source.bytes, source.mimeType);
        if (!sourceDimensions) throw new Error("无法解析原图尺寸，不能安全生成 v6 图片描述符");
        prepared = { sourceUrl: value, id: sha256(source.bytes), mimeType: source.mimeType, bytes: source.bytes, ...sourceDimensions };
      } else throw new Error("当前 Node 没有可用编码器，原图不能直接作为 v6 资产");
      if (!prepared.sourceUrl) prepared.sourceUrl = value;
      if (!outputMime(prepared.mimeType) || prepared.bytes.byteLength <= 0 || prepared.bytes.byteLength > 2 * 1024 * 1024) throw new Error("图片处理输出必须是 webp/jpeg/png 且不超过 2MiB");
      const actualId = sha256(prepared.bytes);
      if (prepared.id !== actualId) throw new Error("图片处理输出摘要与内容不一致");
      const outputMagic = magicMime(prepared.bytes);
      if (outputMagic !== prepared.mimeType) throw new Error("图片处理输出 MIME 与文件魔数不匹配");
      const outputDimensions = dimensions(prepared.bytes, prepared.mimeType);
      if (!outputDimensions) throw new Error("无法解析图片处理输出尺寸，不能安全生成 v6 图片描述符");
      prepared.width = outputDimensions.width;
      prepared.height = outputDimensions.height;
      assets.set(value, prepared);
    } catch (error) {
      failures.push(`${value}：${error instanceof Error ? error.message : "图片预检失败"}`);
    }
  }
  return { assets, failures };
}

function mergeFailures(conversion: V5ToV6Conversion, failures: readonly string[]): V5ToV6Conversion {
  if (!failures.length) return conversion;
  return { ...conversion, report: { ...conversion.report, failures: [...new Set([...conversion.report.failures, ...failures])] } };
}

/** Execute a dry-run or apply migration.  The default is dry-run. */
export async function runV5ToV6Migration(options: V5ToV6MigrationOptions): Promise<V5ToV6MigrationResult> {
  if (!options.owner || !options.repo || !options.token) throw new Error("owner、repo、token 均不能为空");
  const branch = options.branch ?? DEFAULT_BRANCH;
  const remoteOptions = { owner: options.owner, repo: options.repo, branch, token: options.token, fetch: options.fetch, apiBaseUrl: options.apiBaseUrl };
  const source = await readV5RemotePackage(remoteOptions);
  const v6 = new GitHubV6Remote(remoteOptions);
  const existing = await v6.readHead();
  if (existing.initialized) throw new Error("远程 v6 head 已存在，迁移拒绝覆盖。");
  const conversionInput = {
    checkpoint: source.checkpoint,
    archiveAttempts: source.archiveAttempts,
    archivePracticeRuns: source.archivePracticeRuns,
    hotEvents: source.hotEvents,
    sourceHeadBlobSha: source.head.blobSha,
    generatedAt: options.now?.() ?? new Date().toISOString(),
  } satisfies Parameters<typeof convertV5ToV6>[0];
  // Reduce hot entity events first, then preflight only images that survive
  // the final question set (a deleted legacy image must not block migration).
  const preflight = await preflightImages(collectFinalV5ImageUrls(conversionInput), options);
  let conversion = convertV5ToV6({
    ...conversionInput,
    imageAssets: preflight.assets,
  });
  conversion = mergeFailures(conversion, preflight.failures);
  const failures = conversion.report.failures;
  const writes: string[] = [];
  if (!options.apply) {
    return { dryRun: true, applied: false, conversion, sourceHeadBlobSha: source.head.blobSha, failures, writes };
  }
  if (failures.length) throw new Error(`迁移预检失败，首个 PUT 前已终止：${failures.join("；")}`);
  for (const asset of conversion.assets) {
    await v6.putImmutable({ path: asset.path, bytes: asset.bytes, kind: "asset" });
    writes.push(asset.path);
  }
  for (const file of conversion.immutable) {
    await v6.putImmutable({ path: file.path, bytes: file.bytes, kind: file.kind ?? "immutable" });
    writes.push(file.path);
  }
  const latestSource = await readV5RemotePackage(remoteOptions);
  if (latestSource.head.blobSha !== source.head.blobSha) throw new Error("v5 head 在迁移期间发生变化，已中止创建 v6 head；已有写入均为不可变孤儿。");
  const latestV6 = await v6.readHead();
  if (latestV6.initialized) throw new Error("v6 head 在迁移期间已存在，拒绝覆盖。");
  const committed = await v6.putHead(conversion.head);
  if (!committed.ok) throw new Error(`创建 v6 head 被拒绝（HTTP ${committed.status}，${committed.classification}）。`);
  writes.push("sync/v6/head.json");
  return { dryRun: false, applied: true, conversion, sourceHeadBlobSha: source.head.blobSha, failures: [], writes };
}

function resolveToken(): string {
  const fromEnvironment = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnvironment?.trim()) return fromEnvironment.trim();
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!token) throw new Error("未找到 GitHub token，请先 gh auth login 或设置 GITHUB_TOKEN。");
  return token;
}

function cliArgs(argv: readonly string[]): { owner: string; repo: string; branch: string; apply: boolean } {
  const apply = argv.includes("--apply");
  const positional = argv.filter((value) => !value.startsWith("--"));
  const [owner, repo, branch = DEFAULT_BRANCH] = positional;
  if (!owner || !repo) throw new Error("用法：npx tsx scripts/migrate-cloud-v5-to-v6.ts <owner> <repo> [branch] [--apply]");
  return { owner, repo, branch, apply };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = cliArgs(argv);
  const result = await runV5ToV6Migration({ ...args, token: resolveToken() });
  const mode = result.dryRun ? "dry-run（只读）" : "apply";
  console.log(`v5 → v6 迁移${mode}完成`);
  console.log(JSON.stringify({
    模式: mode,
    题目: result.conversion.report.uniqueQuestions,
    题库归属: result.conversion.report.memberships,
    统计: result.conversion.report.stats,
    图片: result.conversion.report.images,
    失败项: result.failures,
    估算字节: result.conversion.report.estimatedBytes,
    六千题检查点估算字节: result.conversion.report.estimated6000QuestionBytes,
    热窗口字节上限内: result.conversion.report.sixThousandQuestionHeadWithinHotWindow,
    写入: result.writes,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "迁移失败");
    process.exitCode = 1;
  });
}
