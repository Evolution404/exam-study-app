import { mapWithConcurrency } from "../async/bounded-concurrency";
import { sha256DigestHex } from "../crypto/sha256";
import type { ImageAsset } from "../db/v7-types";
import { sha256Blob } from "../io/image-assets";
import type { GitHubV7Remote } from "./github-v7-remote";
import type { SyncV7Descriptor } from "./sync-v7-head";
import { SYNC_V7_ASSET_PREFIX } from "./sync-v7-head";

export const IMAGE_ASSET_PACK_FORMAT = 1 as const;
export const IMAGE_ASSET_INDEX_FORMAT = 1 as const;
export const IMAGE_ASSET_INDEX_PATH = `${SYNC_V7_ASSET_PREFIX}index.json`;
export const IMAGE_ASSET_PACK_TARGET_BYTES = 8 * 1024 * 1024;
export const IMAGE_ASSET_PACK_MAX_ASSETS = 64;
export const IMAGE_ASSET_INDEX_SHARD_COUNT = 4;
export const IMAGE_ASSET_PACK_DOWNLOAD_CONCURRENCY = 4;

const PACK_MAGIC = new TextEncoder().encode("ESAPACK1");
const PACK_HEADER_BYTES = PACK_MAGIC.byteLength + 4;
const PACK_HEADER_RESERVE = 128 * 1024;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_MIME_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

type ImageMimeType = ImageAsset["mimeType"];
type PackableImageAsset = ImageAsset & { blob: Blob };
type AssetShardKey = "0" | "1" | "2" | "3";

export interface ImageAssetPackEntry {
  id: string;
  mimeType: ImageMimeType;
  size: number;
  width: number;
  height: number;
  offset: number;
  length: number;
}

interface ImageAssetPackHeader {
  formatVersion: typeof IMAGE_ASSET_PACK_FORMAT;
  entries: ImageAssetPackEntry[];
}

export interface BuiltImageAssetPack {
  bytes: Uint8Array;
  sha256: string;
  entries: ImageAssetPackEntry[];
}

export interface ImageAssetPackIndexEntry {
  packSha256: string;
  offset: number;
  length: number;
  mimeType: ImageMimeType;
  size: number;
  width: number;
  height: number;
}

export interface ImageAssetPackIndexShard {
  formatVersion: typeof IMAGE_ASSET_INDEX_FORMAT;
  shard: AssetShardKey;
  packs: Record<string, SyncV7Descriptor>;
  entries: Record<string, ImageAssetPackIndexEntry>;
}

export interface ImageAssetPackIndexRoot {
  formatVersion: typeof IMAGE_ASSET_INDEX_FORMAT;
  generatedAt: string;
  assetIds: string[];
  shards: Partial<Record<AssetShardKey, SyncV7Descriptor>>;
}

export interface ImageAssetPackPublishProgress {
  completed: number;
  total: number;
  uploadedBytes: number;
  totalBytes: number;
}

interface GitHubContentsPayload {
  content?: unknown;
  encoding?: unknown;
  sha?: unknown;
}

interface GitHubRefPayload {
  object?: { sha?: unknown };
}

interface GitHubCommitPayload {
  tree?: { sha?: unknown };
}

interface GitHubBlobPayload {
  sha?: unknown;
}

interface GitHubTreePayload {
  sha?: unknown;
}

interface GitHubCreateCommitPayload {
  sha?: unknown;
}

interface ParsedImageAssetPack {
  header: ImageAssetPackHeader;
  payloadOffset: number;
  entryById: Map<string, ImageAssetPackEntry>;
}

interface RuntimeCache {
  root?: ImageAssetPackIndexRoot | null;
  shards: Map<string, ImageAssetPackIndexShard>;
  packs: Map<string, Uint8Array>;
  parsedPacks: Map<string, ParsedImageAssetPack>;
}

const runtimeCaches = new Map<string, RuntimeCache>();

function fail(message: string): never {
  throw new Error(`图片 Pack 格式无效：${message}`);
}

function assertDigest(value: unknown, field: string, pattern = SHA256): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} 摘要无效`);
}

function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${field} 必须是 >= ${minimum} 的整数`);
}

function assertMimeType(value: unknown, field: string): asserts value is ImageMimeType {
  if (typeof value !== "string" || !IMAGE_MIME_TYPES.has(value)) fail(`${field} MIME 类型无效`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function utf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parseJsonBytes(bytes: Uint8Array, field: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    fail(`${field} JSON 无法解析`);
  }
}

function remoteKey(client: GitHubV7Remote): string {
  return `${client.apiBaseUrl}|${client.owner.toLocaleLowerCase("en-US")}/${client.repo.toLocaleLowerCase("en-US")}@${client.branch}`;
}

function cacheFor(client: GitHubV7Remote): RuntimeCache {
  const key = remoteKey(client);
  let cache = runtimeCaches.get(key);
  if (!cache) {
    cache = { shards: new Map(), packs: new Map(), parsedPacks: new Map() };
    runtimeCaches.set(key, cache);
  }
  return cache;
}

export function clearImageAssetPackRuntimeCache(): void {
  runtimeCaches.clear();
}

export function imageAssetIndexShardKey(assetId: string): AssetShardKey {
  assertDigest(assetId, "assetId");
  const bucket = Math.floor(Number.parseInt(assetId[0], 16) / 4);
  return String(bucket) as AssetShardKey;
}

function assetPackPath(sha256: string): string {
  assertDigest(sha256, "pack sha256");
  return `${SYNC_V7_ASSET_PREFIX}${sha256}.bin`;
}

function contentPath(client: GitHubV7Remote, path: string): string {
  return `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/contents/${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function repoGitPath(client: GitHubV7Remote, suffix: string): string {
  return `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/git/${suffix}`;
}

function branchPath(branch: string): string {
  return branch.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function requestFrom(client: GitHubV7Remote): (path: string, init?: RequestInit, accept?: string) => Promise<Response> {
  const candidate = (client as unknown as { request?: (path: string, init?: RequestInit, accept?: string) => Promise<Response> }).request;
  if (typeof candidate !== "function") throw new Error("当前 GitHub transport 不支持 Asset Pack 原子发布。");
  return candidate.bind(client);
}

async function responseJson(response: Response, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${operation} 失败（GitHub ${response.status}）`);
  try {
    return asRecord(JSON.parse(await response.text()) as unknown, operation);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("图片 Pack 格式无效")) throw error;
    throw new Error(`${operation} 返回了无效 JSON。`);
  }
}

function descriptorFromBlob(path: string, blobSha: string, sha256: string, size: number): SyncV7Descriptor {
  assertDigest(blobSha, "Git blobSha", SHA1);
  assertDigest(sha256, "对象 sha256");
  assertSafeInteger(size, "对象 size");
  return { path, blobSha, sha256, size, storedSize: size };
}

function validateDescriptor(value: unknown, field: string): SyncV7Descriptor {
  const record = asRecord(value, field);
  if (typeof record.path !== "string" || !record.path.startsWith(SYNC_V7_ASSET_PREFIX)) fail(`${field}.path 无效`);
  assertDigest(record.blobSha, `${field}.blobSha`, SHA1);
  assertDigest(record.sha256, `${field}.sha256`);
  assertSafeInteger(record.size, `${field}.size`);
  if (record.storedSize !== undefined) assertSafeInteger(record.storedSize, `${field}.storedSize`);
  return {
    path: record.path,
    blobSha: record.blobSha,
    sha256: record.sha256,
    size: record.size,
    ...(record.storedSize !== undefined ? { storedSize: record.storedSize } : {}),
  };
}

function validateRoot(value: unknown): ImageAssetPackIndexRoot {
  const record = asRecord(value, "asset index root");
  if (record.formatVersion !== IMAGE_ASSET_INDEX_FORMAT) fail("asset index root 版本不受支持");
  if (typeof record.generatedAt !== "string" || Number.isNaN(Date.parse(record.generatedAt))) fail("asset index root.generatedAt 无效");
  if (!Array.isArray(record.assetIds)) fail("asset index root.assetIds 必须是数组");
  const assetIds = record.assetIds.map((id, index) => {
    assertDigest(id, `assetIds[${index}]`);
    return id;
  });
  if (new Set(assetIds).size !== assetIds.length) fail("asset index root.assetIds 存在重复值");
  const shardsRecord = asRecord(record.shards, "asset index root.shards");
  const shards: ImageAssetPackIndexRoot["shards"] = {};
  for (const key of Object.keys(shardsRecord)) {
    if (!/^[0-3]$/.test(key)) fail(`asset index shard key ${key} 无效`);
    shards[key as AssetShardKey] = validateDescriptor(shardsRecord[key], `shards.${key}`);
  }
  return { formatVersion: IMAGE_ASSET_INDEX_FORMAT, generatedAt: record.generatedAt, assetIds: [...assetIds].sort(), shards };
}

function validateShard(value: unknown, expectedShard: AssetShardKey): ImageAssetPackIndexShard {
  const record = asRecord(value, `asset index shard ${expectedShard}`);
  if (record.formatVersion !== IMAGE_ASSET_INDEX_FORMAT) fail(`shard ${expectedShard} 版本不受支持`);
  if (record.shard !== expectedShard) fail(`shard ${expectedShard} 标识不匹配`);
  const packsRecord = asRecord(record.packs, `shard ${expectedShard}.packs`);
  const packs: Record<string, SyncV7Descriptor> = {};
  for (const [sha, descriptor] of Object.entries(packsRecord)) {
    assertDigest(sha, `shard ${expectedShard}.packs key`);
    const parsed = validateDescriptor(descriptor, `shard ${expectedShard}.packs.${sha}`);
    if (parsed.sha256 !== sha) fail(`shard ${expectedShard} pack key 与 descriptor.sha256 不一致`);
    packs[sha] = parsed;
  }
  const entriesRecord = asRecord(record.entries, `shard ${expectedShard}.entries`);
  const entries: Record<string, ImageAssetPackIndexEntry> = {};
  for (const [assetId, raw] of Object.entries(entriesRecord)) {
    assertDigest(assetId, `shard ${expectedShard}.entry key`);
    if (imageAssetIndexShardKey(assetId) !== expectedShard) fail(`asset ${assetId} 位于错误分片`);
    const entry = asRecord(raw, `shard ${expectedShard}.entries.${assetId}`);
    assertDigest(entry.packSha256, `entry ${assetId}.packSha256`);
    if (!packs[entry.packSha256]) fail(`entry ${assetId} 引用了不存在的 pack`);
    assertSafeInteger(entry.offset, `entry ${assetId}.offset`);
    assertSafeInteger(entry.length, `entry ${assetId}.length`, 1);
    assertSafeInteger(entry.size, `entry ${assetId}.size`, 1);
    assertSafeInteger(entry.width, `entry ${assetId}.width`, 1);
    assertSafeInteger(entry.height, `entry ${assetId}.height`, 1);
    assertMimeType(entry.mimeType, `entry ${assetId}.mimeType`);
    if (entry.length !== entry.size) fail(`entry ${assetId}.length 必须等于图片 size`);
    entries[assetId] = {
      packSha256: entry.packSha256,
      offset: entry.offset,
      length: entry.length,
      mimeType: entry.mimeType,
      size: entry.size,
      width: entry.width,
      height: entry.height,
    };
  }
  return { formatVersion: IMAGE_ASSET_INDEX_FORMAT, shard: expectedShard, packs, entries };
}

export async function buildImageAssetPack(assets: readonly PackableImageAsset[]): Promise<BuiltImageAssetPack> {
  if (!assets.length) throw new Error("不能创建空图片 Pack。");
  const sorted = [...assets].sort((left, right) => left.id.localeCompare(right.id));
  const chunks: Uint8Array[] = [];
  const entries: ImageAssetPackEntry[] = [];
  let offset = 0;
  for (const asset of sorted) {
    if (await sha256Blob(asset.blob) !== asset.id) throw new Error(`图片 ${asset.id} 本地内容与 assetId 不一致。`);
    const bytes = new Uint8Array(await asset.blob.arrayBuffer());
    entries.push({ id: asset.id, mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height, offset, length: bytes.byteLength });
    chunks.push(bytes);
    offset += bytes.byteLength;
  }
  const headerBytes = utf8({ formatVersion: IMAGE_ASSET_PACK_FORMAT, entries } satisfies ImageAssetPackHeader);
  const bytes = new Uint8Array(PACK_HEADER_BYTES + headerBytes.byteLength + offset);
  bytes.set(PACK_MAGIC, 0);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(PACK_MAGIC.byteLength, headerBytes.byteLength, true);
  bytes.set(headerBytes, PACK_HEADER_BYTES);
  let payloadOffset = PACK_HEADER_BYTES + headerBytes.byteLength;
  for (const chunk of chunks) {
    bytes.set(chunk, payloadOffset);
    payloadOffset += chunk.byteLength;
  }
  return { bytes, sha256: await sha256DigestHex(bytes), entries };
}

export async function buildImageAssetPacks(
  assets: readonly PackableImageAsset[],
  options: { targetBytes?: number; maxAssets?: number } = {},
): Promise<BuiltImageAssetPack[]> {
  const targetBytes = Math.max(256 * 1024, options.targetBytes ?? IMAGE_ASSET_PACK_TARGET_BYTES);
  const maxAssets = Math.max(1, options.maxAssets ?? IMAGE_ASSET_PACK_MAX_ASSETS);
  const payloadBudget = Math.max(1, targetBytes - PACK_HEADER_RESERVE);
  const sorted = [...assets].sort((left, right) => left.id.localeCompare(right.id));
  const groups: PackableImageAsset[][] = [];
  let current: PackableImageAsset[] = [];
  let currentBytes = 0;
  for (const asset of sorted) {
    const wouldOverflow = current.length > 0 && (current.length >= maxAssets || currentBytes + asset.size > payloadBudget);
    if (wouldOverflow) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(asset);
    currentBytes += asset.size;
  }
  if (current.length) groups.push(current);
  return Promise.all(groups.map((group) => buildImageAssetPack(group)));
}

export function parseImageAssetPack(bytes: Uint8Array): ParsedImageAssetPack {
  if (bytes.byteLength < PACK_HEADER_BYTES) fail("Pack 过短");
  for (let index = 0; index < PACK_MAGIC.byteLength; index += 1) if (bytes[index] !== PACK_MAGIC[index]) fail("Magic 不匹配");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(PACK_MAGIC.byteLength, true);
  const payloadOffset = PACK_HEADER_BYTES + headerLength;
  if (headerLength <= 0 || payloadOffset > bytes.byteLength) fail("Header 长度越界");
  const raw = asRecord(parseJsonBytes(bytes.subarray(PACK_HEADER_BYTES, payloadOffset), "Pack header"), "Pack header");
  if (raw.formatVersion !== IMAGE_ASSET_PACK_FORMAT) fail("Pack 版本不受支持");
  if (!Array.isArray(raw.entries) || !raw.entries.length) fail("Pack entries 为空");
  const entries: ImageAssetPackEntry[] = [];
  const entryById = new Map<string, ImageAssetPackEntry>();
  let previousEnd = 0;
  for (let index = 0; index < raw.entries.length; index += 1) {
    const record = asRecord(raw.entries[index], `Pack entries[${index}]`);
    assertDigest(record.id, `Pack entries[${index}].id`);
    assertMimeType(record.mimeType, `Pack entries[${index}].mimeType`);
    assertSafeInteger(record.size, `Pack entries[${index}].size`, 1);
    assertSafeInteger(record.width, `Pack entries[${index}].width`, 1);
    assertSafeInteger(record.height, `Pack entries[${index}].height`, 1);
    assertSafeInteger(record.offset, `Pack entries[${index}].offset`);
    assertSafeInteger(record.length, `Pack entries[${index}].length`, 1);
    if (record.length !== record.size) fail(`Pack entry ${record.id} length 与 size 不一致`);
    if (record.offset < previousEnd) fail(`Pack entry ${record.id} 与前一项重叠`);
    if (payloadOffset + record.offset + record.length > bytes.byteLength) fail(`Pack entry ${record.id} 越界`);
    const entry: ImageAssetPackEntry = {
      id: record.id,
      mimeType: record.mimeType,
      size: record.size,
      width: record.width,
      height: record.height,
      offset: record.offset,
      length: record.length,
    };
    if (entryById.has(entry.id)) fail(`Pack entry ${entry.id} 重复`);
    entries.push(entry);
    entryById.set(entry.id, entry);
    previousEnd = entry.offset + entry.length;
  }
  return { header: { formatVersion: IMAGE_ASSET_PACK_FORMAT, entries }, payloadOffset, entryById };
}

export async function extractImageAssetFromPack(bytes: Uint8Array, assetId: string): Promise<Uint8Array> {
  const parsed = parseImageAssetPack(bytes);
  const entry = parsed.entryById.get(assetId);
  if (!entry) throw new Error(`Pack 中不存在图片 ${assetId}。`);
  const image = bytes.slice(parsed.payloadOffset + entry.offset, parsed.payloadOffset + entry.offset + entry.length);
  const digest = await sha256DigestHex(image);
  if (digest !== assetId) throw new Error(`Pack 中图片 ${assetId} 完整性校验失败。`);
  return image;
}

async function loadIndexRootAtRef(client: GitHubV7Remote, ref: string): Promise<ImageAssetPackIndexRoot | null> {
  const request = requestFrom(client);
  const response = await request(`${contentPath(client, IMAGE_ASSET_INDEX_PATH)}?ref=${encodeURIComponent(ref)}`, { method: "GET" });
  if (response.status === 404) return null;
  const payload = await responseJson(response, "读取图片 Asset Index");
  if (typeof payload.content !== "string") throw new Error("图片 Asset Index 缺少 content。");
  return validateRoot(parseJsonBytes(decodeBase64(payload.content), "Asset Index"));
}

export async function loadImageAssetPackIndex(client: GitHubV7Remote, options: { force?: boolean } = {}): Promise<ImageAssetPackIndexRoot | null> {
  const cache = cacheFor(client);
  if (!options.force && cache.root !== undefined) return cache.root;
  const root = await loadIndexRootAtRef(client, client.branch);
  cache.root = root;
  if (options.force) {
    cache.shards.clear();
    cache.packs.clear();
    cache.parsedPacks.clear();
  }
  return root;
}

async function loadShard(client: GitHubV7Remote, key: AssetShardKey, descriptor: SyncV7Descriptor): Promise<ImageAssetPackIndexShard> {
  const cache = cacheFor(client);
  const cached = cache.shards.get(descriptor.sha256);
  if (cached) return cached;
  const bytes = await client.readBlob(descriptor);
  const shard = validateShard(parseJsonBytes(bytes, `Asset Index shard ${key}`), key);
  cache.shards.set(descriptor.sha256, shard);
  return shard;
}

async function loadPack(client: GitHubV7Remote, descriptor: SyncV7Descriptor): Promise<{ bytes: Uint8Array; parsed: ParsedImageAssetPack }> {
  const cache = cacheFor(client);
  let bytes = cache.packs.get(descriptor.sha256);
  let parsed = cache.parsedPacks.get(descriptor.sha256);
  if (!bytes) {
    bytes = await client.readBlob(descriptor);
    cache.packs.set(descriptor.sha256, bytes);
  }
  if (!parsed) {
    parsed = parseImageAssetPack(bytes);
    cache.parsedPacks.set(descriptor.sha256, parsed);
  }
  return { bytes, parsed };
}

async function ensureRootContains(client: GitHubV7Remote, assetIds: readonly string[]): Promise<ImageAssetPackIndexRoot> {
  let root = await loadImageAssetPackIndex(client);
  if (!root || assetIds.some((id) => !root!.assetIds.includes(id))) root = await loadImageAssetPackIndex(client, { force: true });
  if (!root) throw new Error("远端尚未完成图片 Pack 一次性迁移，请先执行同步。");
  const known = new Set(root.assetIds);
  const missing = assetIds.filter((id) => !known.has(id));
  if (missing.length) throw new Error(`远端 Asset Index 缺少 ${missing.length} 张图片，请先同步。`);
  return root;
}

export async function readImageAssetsFromPacks(client: GitHubV7Remote, assetIds: readonly string[]): Promise<Map<string, Uint8Array>> {
  const ids = [...new Set(assetIds)];
  if (!ids.length) return new Map();
  ids.forEach((id) => assertDigest(id, "assetId"));
  const root = await ensureRootContains(client, ids);
  const keys = [...new Set(ids.map(imageAssetIndexShardKey))];
  const shards = new Map<AssetShardKey, ImageAssetPackIndexShard>();
  await Promise.all(keys.map(async (key) => {
    const descriptor = root.shards[key];
    if (!descriptor) throw new Error(`远端 Asset Index 缺少分片 ${key}。`);
    shards.set(key, await loadShard(client, key, descriptor));
  }));
  const packDescriptors = new Map<string, SyncV7Descriptor>();
  const located = new Map<string, { entry: ImageAssetPackIndexEntry; pack: SyncV7Descriptor }>();
  for (const id of ids) {
    const shard = shards.get(imageAssetIndexShardKey(id));
    const entry = shard?.entries[id];
    if (!shard || !entry) throw new Error(`远端 Asset Index 未定位图片 ${id}。`);
    const pack = shard.packs[entry.packSha256];
    if (!pack) throw new Error(`图片 ${id} 引用的 Pack descriptor 不存在。`);
    packDescriptors.set(pack.sha256, pack);
    located.set(id, { entry, pack });
  }
  const loadedPacks = new Map<string, { bytes: Uint8Array; parsed: ParsedImageAssetPack }>();
  await mapWithConcurrency([...packDescriptors.values()], IMAGE_ASSET_PACK_DOWNLOAD_CONCURRENCY, async (descriptor) => {
    loadedPacks.set(descriptor.sha256, await loadPack(client, descriptor));
    return descriptor.sha256;
  });
  const result = new Map<string, Uint8Array>();
  for (const id of ids) {
    const location = located.get(id)!;
    const loaded = loadedPacks.get(location.pack.sha256)!;
    const headerEntry = loaded.parsed.entryById.get(id);
    if (!headerEntry) throw new Error(`Pack ${location.pack.sha256} 缺少图片 ${id}。`);
    if (
      headerEntry.offset !== location.entry.offset
      || headerEntry.length !== location.entry.length
      || headerEntry.size !== location.entry.size
      || headerEntry.mimeType !== location.entry.mimeType
    ) throw new Error(`图片 ${id} 的 Asset Index 与 Pack header 不一致。`);
    const bytes = loaded.bytes.slice(loaded.parsed.payloadOffset + headerEntry.offset, loaded.parsed.payloadOffset + headerEntry.offset + headerEntry.length);
    if (await sha256DigestHex(bytes) !== id) throw new Error(`远端图片 ${id} 完整性校验失败。`);
    result.set(id, bytes);
  }
  return result;
}

export async function readImageAssetFromPack(client: GitHubV7Remote, assetId: string): Promise<Uint8Array> {
  const assets = await readImageAssetsFromPacks(client, [assetId]);
  return assets.get(assetId)!;
}

async function gitCreateBlob(client: GitHubV7Remote, bytes: Uint8Array): Promise<string> {
  const request = requestFrom(client);
  const response = await request(repoGitPath(client, "blobs"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: encodeBase64(bytes), encoding: "base64" }),
  });
  const payload = await responseJson(response, "创建 Git blob");
  assertDigest(payload.sha, "Git blob sha", SHA1);
  return payload.sha;
}

async function readBranchSnapshot(client: GitHubV7Remote): Promise<{ parentSha: string; treeSha: string; root: ImageAssetPackIndexRoot | null }> {
  const request = requestFrom(client);
  const branch = branchPath(client.branch);
  const refPayload = await responseJson(await request(repoGitPath(client, `ref/heads/${branch}`), { method: "GET" }), "读取 Git branch ref");
  const object = asRecord(refPayload.object, "branch ref.object");
  assertDigest(object.sha, "branch commit sha", SHA1);
  const parentSha = object.sha;
  const root = await loadIndexRootAtRef(client, parentSha);
  const commitPayload = await responseJson(await request(repoGitPath(client, `commits/${parentSha}`), { method: "GET" }), "读取 Git commit");
  const tree = asRecord(commitPayload.tree, "git commit.tree");
  assertDigest(tree.sha, "base tree sha", SHA1);
  return { parentSha, treeSha: tree.sha, root };
}

async function createTreeCommit(
  client: GitHubV7Remote,
  base: { parentSha: string; treeSha: string },
  files: Array<{ path: string; blobSha: string }>,
): Promise<boolean> {
  const request = requestFrom(client);
  const treeResponse = await request(repoGitPath(client, "trees"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: base.treeSha,
      tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", sha: file.blobSha })),
    }),
  });
  const treePayload = await responseJson(treeResponse, "创建 Asset Pack Git tree");
  assertDigest(treePayload.sha, "new tree sha", SHA1);
  const commitResponse = await request(repoGitPath(client, "commits"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "sync(v9): publish image asset packs", tree: treePayload.sha, parents: [base.parentSha] }),
  });
  const commitPayload = await responseJson(commitResponse, "创建 Asset Pack Git commit");
  assertDigest(commitPayload.sha, "new commit sha", SHA1);
  const update = await request(repoGitPath(client, `refs/heads/${branchPath(client.branch)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commitPayload.sha, force: false }),
  });
  if (update.status === 409 || update.status === 422) return false;
  if (!update.ok) throw new Error(`发布 Asset Pack Git ref 失败（GitHub ${update.status}）。`);
  return true;
}

function emptyShard(key: AssetShardKey): ImageAssetPackIndexShard {
  return { formatVersion: IMAGE_ASSET_INDEX_FORMAT, shard: key, packs: {}, entries: {} };
}

async function hydrateLegacyAsset(client: GitHubV7Remote, asset: ImageAsset): Promise<PackableImageAsset> {
  if (asset.blob) {
    if (await sha256Blob(asset.blob) !== asset.id) throw new Error(`图片 ${asset.id} 本地缓存校验失败。`);
    return asset as PackableImageAsset;
  }
  if (!asset.remote) throw new Error(`图片 ${asset.id} 既无本地 Blob，也无旧远端对象，无法执行一次性 Pack 迁移。`);
  const bytes = await client.readBlob(asset.remote.blobSha, { size: asset.remote.size, sha256: asset.remote.sha256, path: asset.remote.path });
  const blob = new Blob([bytes as unknown as BlobPart], { type: asset.mimeType });
  if (blob.size !== asset.size || await sha256Blob(blob) !== asset.id) throw new Error(`旧远端图片 ${asset.id} 完整性校验失败。`);
  return { ...asset, blob };
}

async function publishAttempt(
  client: GitHubV7Remote,
  assets: readonly ImageAsset[],
  onProgress?: (progress: ImageAssetPackPublishProgress) => void,
): Promise<{ published: Array<{ source: PackableImageAsset; descriptor: Omit<ImageAsset, "blob"> }>; root: ImageAssetPackIndexRoot } | null> {
  const snapshot = await readBranchSnapshot(client);
  const known = new Set(snapshot.root?.assetIds ?? []);
  const pendingBase = assets.filter((asset) => !known.has(asset.id));
  if (!pendingBase.length) {
    const root = snapshot.root;
    if (!root) return null;
    cacheFor(client).root = root;
    return { published: [], root };
  }
  const totalBytes = pendingBase.reduce((sum, asset) => sum + asset.size, 0);
  let completed = 0;
  let uploadedBytes = 0;
  onProgress?.({ completed, total: pendingBase.length, uploadedBytes, totalBytes });
  const pending = await mapWithConcurrency(pendingBase, 6, async (asset) => hydrateLegacyAsset(client, asset));
  const packs = await buildImageAssetPacks(pending);
  const packDescriptorBySha = new Map<string, SyncV7Descriptor>();
  const packByAsset = new Map<string, { pack: BuiltImageAssetPack; descriptor: SyncV7Descriptor; entry: ImageAssetPackEntry }>();
  const treeFiles: Array<{ path: string; blobSha: string }> = [];
  for (const pack of packs) {
    const path = assetPackPath(pack.sha256);
    const blobSha = await gitCreateBlob(client, pack.bytes);
    const descriptor = descriptorFromBlob(path, blobSha, pack.sha256, pack.bytes.byteLength);
    packDescriptorBySha.set(pack.sha256, descriptor);
    treeFiles.push({ path, blobSha });
    for (const entry of pack.entries) packByAsset.set(entry.id, { pack, descriptor, entry });
    completed += pack.entries.length;
    uploadedBytes += pack.entries.reduce((sum, entry) => sum + entry.size, 0);
    onProgress?.({ completed: Math.min(completed, pendingBase.length), total: pendingBase.length, uploadedBytes: Math.min(uploadedBytes, totalBytes), totalBytes });
  }

  const affectedKeys = [...new Set(pending.map((asset) => imageAssetIndexShardKey(asset.id)))];
  const nextShards: Partial<Record<AssetShardKey, SyncV7Descriptor>> = { ...(snapshot.root?.shards ?? {}) };
  const shardObjects = new Map<AssetShardKey, ImageAssetPackIndexShard>();
  for (const key of affectedKeys) {
    const previousDescriptor = snapshot.root?.shards[key];
    const previous = previousDescriptor ? await loadShard(client, key, previousDescriptor) : emptyShard(key);
    shardObjects.set(key, {
      formatVersion: IMAGE_ASSET_INDEX_FORMAT,
      shard: key,
      packs: { ...previous.packs },
      entries: { ...previous.entries },
    });
  }
  for (const asset of pending) {
    const location = packByAsset.get(asset.id)!;
    const key = imageAssetIndexShardKey(asset.id);
    const shard = shardObjects.get(key)!;
    shard.packs[location.descriptor.sha256] = location.descriptor;
    shard.entries[asset.id] = {
      packSha256: location.descriptor.sha256,
      offset: location.entry.offset,
      length: location.entry.length,
      mimeType: asset.mimeType,
      size: asset.size,
      width: asset.width,
      height: asset.height,
    };
  }
  for (const key of affectedKeys) {
    const shard = shardObjects.get(key)!;
    const bytes = utf8({
      formatVersion: shard.formatVersion,
      shard: shard.shard,
      packs: Object.fromEntries(Object.entries(shard.packs).sort(([left], [right]) => left.localeCompare(right))),
      entries: Object.fromEntries(Object.entries(shard.entries).sort(([left], [right]) => left.localeCompare(right))),
    });
    const sha256 = await sha256DigestHex(bytes);
    const path = assetPackPath(sha256);
    const blobSha = await gitCreateBlob(client, bytes);
    const descriptor = descriptorFromBlob(path, blobSha, sha256, bytes.byteLength);
    nextShards[key] = descriptor;
    treeFiles.push({ path, blobSha });
  }

  const assetIds = [...new Set([...(snapshot.root?.assetIds ?? []), ...pending.map((asset) => asset.id)])].sort();
  const root: ImageAssetPackIndexRoot = {
    formatVersion: IMAGE_ASSET_INDEX_FORMAT,
    generatedAt: new Date().toISOString(),
    assetIds,
    shards: nextShards,
  };
  const rootBytes = utf8(root);
  const rootBlobSha = await gitCreateBlob(client, rootBytes);
  treeFiles.push({ path: IMAGE_ASSET_INDEX_PATH, blobSha: rootBlobSha });
  if (!await createTreeCommit(client, snapshot, treeFiles)) return null;

  const cache = cacheFor(client);
  cache.root = root;
  for (const [key, shard] of shardObjects) {
    const descriptor = root.shards[key];
    if (descriptor) cache.shards.set(descriptor.sha256, shard);
  }
  for (const pack of packs) {
    cache.packs.set(pack.sha256, pack.bytes);
    cache.parsedPacks.set(pack.sha256, parseImageAssetPack(pack.bytes));
  }
  return {
    root,
    published: pending.map((source) => {
      const { blob: _blob, remote: _legacyRemote, ...descriptor } = source;
      void _blob;
      void _legacyRemote;
      return { source, descriptor };
    }),
  };
}

export async function publishImageAssetsAsPacks(
  client: GitHubV7Remote,
  assets: readonly ImageAsset[],
  onProgress?: (progress: ImageAssetPackPublishProgress) => void,
): Promise<Array<{ source: PackableImageAsset; descriptor: Omit<ImageAsset, "blob"> }>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await publishAttempt(client, assets, onProgress);
    if (result) return result.published;
  }
  throw new Error("图片 Asset Pack 发布期间远端持续发生并发更新，请重新同步。");
}
