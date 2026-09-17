import { sha256DigestHex } from "../../src/lib/crypto/sha256";
import type { ImageAssetDescriptor } from "../../src/lib/db/types";
import { imageAssetIndexShardKey, parseImageAssetPack } from "../../src/lib/sync/image-asset-pack";
import { SYNC_ASSET_PREFIX, type SyncDescriptor } from "../../src/lib/sync/sync-head-types";

const SOURCE_ASSET_PREFIX = "sync/v9/assets/";
const SOURCE_INDEX_PATH = `${SOURCE_ASSET_PREFIX}index.json`;
export const TARGET_ASSET_INDEX_PATH = `${SYNC_ASSET_PREFIX}index.json`;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHARD_KEYS = ["0", "1", "2", "3"] as const;
type ShardKey = typeof SHARD_KEYS[number];

interface LegacyAssetDescriptor {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
  storedSize: number;
}

interface AssetIndexEntry {
  packSha256: string;
  offset: number;
  length: number;
  mimeType: ImageAssetDescriptor["mimeType"];
  size: number;
  width: number;
  height: number;
}

interface AssetShard {
  formatVersion: 1;
  shard: ShardKey;
  packs: Record<string, LegacyAssetDescriptor>;
  entries: Record<string, AssetIndexEntry>;
}

interface AssetRoot {
  formatVersion: 1;
  generatedAt: string;
  shards: Partial<Record<ShardKey, LegacyAssetDescriptor>>;
}

export interface LegacyAssetSource {
  readAssetIndex(): Promise<Uint8Array | null>;
  readAssetBlob(descriptor: LegacyAssetDescriptor): Promise<Uint8Array>;
}

export interface AssetShadowTarget {
  putImmutable(input: { path: string; bytes: Uint8Array; kind: "asset" }): Promise<SyncDescriptor>;
  readBlob(descriptor: SyncDescriptor): Promise<Uint8Array>;
  publishAssetIndex(bytes: Uint8Array): Promise<void>;
  readAssetIndex(): Promise<Uint8Array | null>;
}

export interface LegacyAssetShadowPlan {
  generatedAt: string;
  shards: Map<ShardKey, AssetShard>;
  packs: Map<string, { descriptor: LegacyAssetDescriptor; bytes: Uint8Array }>;
  expectedAssets: ImageAssetDescriptor[];
  indexedAssetCount: number;
}

export interface StagedAssetShadow {
  rootBytes: Uint8Array;
  root: { formatVersion: 1; generatedAt: string; shards: Partial<Record<ShardKey, SyncDescriptor>> };
  packCount: number;
  shardCount: number;
  indexedAssetCount: number;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseJson(bytes: Uint8Array, field: string): unknown {
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Error(`${field} is not valid JSON`); }
}

function assertDescriptor(value: unknown, field: string): LegacyAssetDescriptor {
  const row = asRecord(value, field);
  if (typeof row.path !== "string" || !row.path.startsWith(SOURCE_ASSET_PREFIX)) throw new Error(`${field}.path must be in the legacy asset namespace`);
  if (typeof row.blobSha !== "string" || !SHA1.test(row.blobSha)) throw new Error(`${field}.blobSha is invalid`);
  if (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) throw new Error(`${field}.sha256 is invalid`);
  if (!Number.isSafeInteger(row.size) || (row.size as number) < 0) throw new Error(`${field}.size is invalid`);
  if (!Number.isSafeInteger(row.storedSize) || (row.storedSize as number) < 0) throw new Error(`${field}.storedSize is invalid`);
  const digest = /\/([0-9a-f]{64})\.bin$/.exec(row.path)?.[1];
  if (digest !== row.sha256) throw new Error(`${field}.path digest mismatch`);
  return row as unknown as LegacyAssetDescriptor;
}

async function verifyBytes(bytes: Uint8Array, descriptor: LegacyAssetDescriptor, field: string): Promise<void> {
  if (bytes.byteLength !== descriptor.size) throw new Error(`${field} size mismatch`);
  if (await sha256DigestHex(bytes) !== descriptor.sha256) throw new Error(`${field} sha256 mismatch`);
}

function parseRoot(bytes: Uint8Array): AssetRoot {
  const row = asRecord(parseJson(bytes, "legacy asset index"), "legacy asset index");
  if (row.formatVersion !== 1 || typeof row.generatedAt !== "string" || !Number.isFinite(Date.parse(row.generatedAt))) throw new Error("legacy asset index header is invalid");
  const shards = asRecord(row.shards, "legacy asset index shards");
  const result: AssetRoot = { formatVersion: 1, generatedAt: row.generatedAt, shards: {} };
  for (const key of SHARD_KEYS) if (shards[key] !== undefined) result.shards[key] = assertDescriptor(shards[key], `legacy asset shard ${key}`);
  return result;
}

function parseShard(bytes: Uint8Array, expectedKey: ShardKey): AssetShard {
  const row = asRecord(parseJson(bytes, `legacy asset shard ${expectedKey}`), `legacy asset shard ${expectedKey}`);
  if (row.formatVersion !== 1 || row.shard !== expectedKey) throw new Error(`legacy asset shard ${expectedKey} header mismatch`);
  const packsRaw = asRecord(row.packs, `legacy asset shard ${expectedKey}.packs`);
  const entriesRaw = asRecord(row.entries, `legacy asset shard ${expectedKey}.entries`);
  const packs: Record<string, LegacyAssetDescriptor> = {};
  for (const [sha, value] of Object.entries(packsRaw)) {
    if (!SHA256.test(sha)) throw new Error(`legacy asset shard ${expectedKey} pack key is invalid`);
    const descriptor = assertDescriptor(value, `legacy asset shard ${expectedKey}.packs.${sha}`);
    if (descriptor.sha256 !== sha) throw new Error(`legacy asset shard ${expectedKey} pack key mismatch`);
    packs[sha] = descriptor;
  }
  const entries: Record<string, AssetIndexEntry> = {};
  for (const [id, value] of Object.entries(entriesRaw)) {
    if (!SHA256.test(id) || imageAssetIndexShardKey(id) !== expectedKey) throw new Error(`legacy asset entry ${id} is in the wrong shard`);
    const entry = asRecord(value, `legacy asset entry ${id}`);
    if (typeof entry.packSha256 !== "string" || !packs[entry.packSha256]) throw new Error(`legacy asset entry ${id} references a missing pack`);
    for (const field of ["offset", "length", "size", "width", "height"] as const) {
      if (!Number.isSafeInteger(entry[field]) || (entry[field] as number) < (field === "offset" ? 0 : 1)) throw new Error(`legacy asset entry ${id}.${field} is invalid`);
    }
    if (!["image/webp", "image/jpeg", "image/png"].includes(String(entry.mimeType))) throw new Error(`legacy asset entry ${id}.mimeType is invalid`);
    entries[id] = entry as unknown as AssetIndexEntry;
  }
  return { formatVersion: 1, shard: expectedKey, packs, entries };
}

function stableJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function sameAsset(expected: ImageAssetDescriptor, actual: AssetIndexEntry): boolean {
  return expected.mimeType === actual.mimeType && expected.size === actual.size
    && expected.width === actual.width && expected.height === actual.height && actual.length === expected.size;
}

export async function buildLegacyAssetShadowPlan(source: LegacyAssetSource, expectedAssets: readonly ImageAssetDescriptor[]): Promise<LegacyAssetShadowPlan> {
  const rootBytes = await source.readAssetIndex();
  if (!rootBytes) {
    if (expectedAssets.length) throw new Error("legacy asset index is missing while canonical state references images");
    return { generatedAt: new Date(0).toISOString(), shards: new Map(), packs: new Map(), expectedAssets: [], indexedAssetCount: 0 };
  }
  const root = parseRoot(rootBytes);
  const shards = new Map<ShardKey, AssetShard>();
  const packs = new Map<string, { descriptor: LegacyAssetDescriptor; bytes: Uint8Array }>();
  const entries = new Map<string, AssetIndexEntry>();

  for (const key of SHARD_KEYS) {
    const descriptor = root.shards[key];
    if (!descriptor) continue;
    const bytes = await source.readAssetBlob(descriptor);
    await verifyBytes(bytes, descriptor, `legacy asset shard ${key}`);
    const shard = parseShard(bytes, key);
    shards.set(key, shard);
    for (const [id, entry] of Object.entries(shard.entries)) {
      if (entries.has(id)) throw new Error(`legacy asset index duplicates image ${id}`);
      entries.set(id, entry);
    }
    for (const [sha, packDescriptor] of Object.entries(shard.packs)) {
      const prior = packs.get(sha);
      if (prior) {
        if (JSON.stringify(prior.descriptor) !== JSON.stringify(packDescriptor)) throw new Error(`legacy asset pack ${sha} descriptor differs across shards`);
        continue;
      }
      const packBytes = await source.readAssetBlob(packDescriptor);
      await verifyBytes(packBytes, packDescriptor, `legacy asset pack ${sha}`);
      const parsed = parseImageAssetPack(packBytes);
      const headerIds = new Set(parsed.header.entries.map((entry) => entry.id));
      for (const [id, entry] of Object.entries(shard.entries)) {
        if (entry.packSha256 === sha && !headerIds.has(id)) throw new Error(`legacy asset pack ${sha} does not contain indexed image ${id}`);
      }
      packs.set(sha, { descriptor: packDescriptor, bytes: packBytes });
    }
  }

  for (const asset of expectedAssets) {
    const entry = entries.get(asset.id);
    if (!entry) throw new Error(`legacy asset index is missing canonical image ${asset.id}`);
    if (!sameAsset(asset, entry)) throw new Error(`legacy asset metadata differs for canonical image ${asset.id}`);
  }
  return {
    generatedAt: root.generatedAt,
    shards,
    packs,
    expectedAssets: structuredClone([...expectedAssets]),
    indexedAssetCount: entries.size,
  };
}

async function putAsset(target: AssetShadowTarget, bytes: Uint8Array): Promise<SyncDescriptor> {
  const sha256 = await sha256DigestHex(bytes);
  const descriptor = await target.putImmutable({ path: `${SYNC_ASSET_PREFIX}${sha256}.bin`, bytes, kind: "asset" });
  if (descriptor.sha256 !== sha256 || descriptor.size !== bytes.byteLength) throw new Error(`target asset descriptor mismatch for ${sha256}`);
  const readBack = await target.readBlob(descriptor);
  if (readBack.byteLength !== bytes.byteLength || await sha256DigestHex(readBack) !== sha256) throw new Error(`target asset read-back mismatch for ${sha256}`);
  return descriptor;
}

export async function stageAssetShadow(plan: LegacyAssetShadowPlan, target: AssetShadowTarget, publishIndex = true): Promise<StagedAssetShadow> {
  const targetPacks = new Map<string, SyncDescriptor>();
  for (const [sha, pack] of [...plan.packs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const descriptor = await putAsset(target, pack.bytes);
    if (descriptor.sha256 !== sha) throw new Error(`target pack digest changed for ${sha}`);
    targetPacks.set(sha, descriptor);
  }

  const targetShards: Partial<Record<ShardKey, SyncDescriptor>> = {};
  for (const key of SHARD_KEYS) {
    const sourceShard = plan.shards.get(key);
    if (!sourceShard) continue;
    const packs = Object.fromEntries(Object.keys(sourceShard.packs).sort().map((sha) => [sha, targetPacks.get(sha)!]));
    const entries = Object.fromEntries(Object.entries(sourceShard.entries).sort(([a], [b]) => a.localeCompare(b)));
    targetShards[key] = await putAsset(target, stableJson({ formatVersion: 1, shard: key, packs, entries }));
  }

  const root = { formatVersion: 1 as const, generatedAt: plan.generatedAt, shards: targetShards };
  const rootBytes = stableJson(root);
  if (publishIndex) {
    await target.publishAssetIndex(rootBytes);
    const readBack = await target.readAssetIndex();
    if (!readBack || new TextDecoder().decode(readBack) !== new TextDecoder().decode(rootBytes)) throw new Error("target asset index read-back mismatch");
  }
  await verifyAssetShadow(plan.expectedAssets, rootBytes, target);
  return { rootBytes, root, packCount: targetPacks.size, shardCount: Object.keys(targetShards).length, indexedAssetCount: plan.indexedAssetCount };
}

export async function verifyAssetShadow(expectedAssets: readonly ImageAssetDescriptor[], rootBytes: Uint8Array, target: Pick<AssetShadowTarget, "readBlob">): Promise<void> {
  const root = asRecord(parseJson(rootBytes, "target asset index"), "target asset index");
  const shards = asRecord(root.shards, "target asset index shards");
  const located = new Map<string, { entry: AssetIndexEntry; pack: SyncDescriptor }>();
  const packDescriptors = new Map<string, SyncDescriptor>();
  for (const key of SHARD_KEYS) {
    if (shards[key] === undefined) continue;
    const descriptor = shards[key] as SyncDescriptor;
    const bytes = await target.readBlob(descriptor);
    if (await sha256DigestHex(bytes) !== descriptor.sha256) throw new Error(`target asset shard ${key} integrity mismatch`);
    const shard = asRecord(parseJson(bytes, `target asset shard ${key}`), `target asset shard ${key}`);
    const packs = asRecord(shard.packs, `target asset shard ${key}.packs`) as Record<string, SyncDescriptor>;
    const entries = asRecord(shard.entries, `target asset shard ${key}.entries`) as unknown as Record<string, AssetIndexEntry>;
    for (const [sha, pack] of Object.entries(packs)) {
      if (!pack.path.startsWith(SYNC_ASSET_PREFIX) || pack.sha256 !== sha) throw new Error(`target asset pack ${sha} path mismatch`);
      packDescriptors.set(sha, pack);
    }
    for (const [id, entry] of Object.entries(entries)) {
      const pack = packs[entry.packSha256];
      if (!pack) throw new Error(`target asset entry ${id} references a missing pack`);
      located.set(id, { entry, pack });
    }
  }

  const verifiedPacks = new Set<string>();
  for (const asset of expectedAssets) {
    const location = located.get(asset.id);
    if (!location || !sameAsset(asset, location.entry)) throw new Error(`target asset index does not preserve canonical image ${asset.id}`);
    if (verifiedPacks.has(location.pack.sha256)) continue;
    const bytes = await target.readBlob(location.pack);
    if (bytes.byteLength !== location.pack.size || await sha256DigestHex(bytes) !== location.pack.sha256) throw new Error(`target asset pack ${location.pack.sha256} integrity mismatch`);
    parseImageAssetPack(bytes);
    verifiedPacks.add(location.pack.sha256);
  }
  for (const sha of packDescriptors.keys()) if (!verifiedPacks.has(sha) && expectedAssets.length === 0) {
    const pack = packDescriptors.get(sha)!;
    const bytes = await target.readBlob(pack);
    if (await sha256DigestHex(bytes) !== sha) throw new Error(`target asset pack ${sha} integrity mismatch`);
  }
}
