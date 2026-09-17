import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256DigestHex } from "../../src/lib/crypto/sha256";
import { buildImageAssetPack, imageAssetIndexShardKey } from "../../src/lib/sync/image-asset-pack";
import type { ImageAsset, ImageAssetDescriptor } from "../../src/lib/db/types";
import type { SyncDescriptor } from "../../src/lib/sync/sync-head-types";
import {
  buildLegacyAssetShadowPlan,
  stageAssetShadow,
  TARGET_ASSET_INDEX_PATH,
  type AssetShadowTarget,
  type LegacyAssetSource,
} from "../tools/sync-asset-shadow";

const encoder = new TextEncoder();
const legacyPrefix = "sync/v9/assets/";
const now = "2026-09-17T00:00:00.000Z";

function descriptor(path: string, bytes: Uint8Array): Promise<SyncDescriptor> {
  return sha256DigestHex(bytes).then((sha256) => ({
    path,
    blobSha: createHash("sha1").update(bytes).digest("hex"),
    sha256,
    size: bytes.byteLength,
    storedSize: bytes.byteLength,
  }));
}

async function asset(seed: number[]): Promise<ImageAsset> {
  const bytes = new Uint8Array(seed);
  const id = await sha256DigestHex(bytes);
  return {
    id,
    mimeType: "image/png",
    size: bytes.byteLength,
    width: 10,
    height: 10,
    blob: new Blob([bytes], { type: "image/png" }),
  };
}

const assets = await Promise.all([
  asset([1, 2, 3, 4, 5]),
  asset([6, 7, 8, 9]),
  asset([10, 11, 12]),
]);
const pack = await buildImageAssetPack(assets);
const packPath = `${legacyPrefix}${pack.sha256}.bin`;
const packDescriptor = await descriptor(packPath, pack.bytes);

const shardRows = new Map<string, { entries: Record<string, unknown>; packs: Record<string, SyncDescriptor> }>();
for (const entry of pack.entries) {
  const key = imageAssetIndexShardKey(entry.id);
  const row = shardRows.get(key) ?? { entries: {}, packs: {} };
  row.packs[pack.sha256] = packDescriptor;
  row.entries[entry.id] = {
    packSha256: pack.sha256,
    offset: entry.offset,
    length: entry.length,
    mimeType: entry.mimeType,
    size: entry.size,
    width: entry.width,
    height: entry.height,
  };
  shardRows.set(key, row);
}

const files = new Map<string, Uint8Array>([[packPath, pack.bytes]]);
const rootShards: Record<string, SyncDescriptor> = {};
for (const [key, row] of [...shardRows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const bytes = encoder.encode(JSON.stringify({ formatVersion: 1, shard: key, packs: row.packs, entries: row.entries }));
  const sha256 = await sha256DigestHex(bytes);
  const path = `${legacyPrefix}${sha256}.bin`;
  const desc = await descriptor(path, bytes);
  rootShards[key] = desc;
  files.set(path, bytes);
}
const rootBytes = encoder.encode(JSON.stringify({ formatVersion: 1, generatedAt: now, shards: rootShards }));

class MemorySource implements LegacyAssetSource {
  constructor(readonly content = files, readonly root = rootBytes) {}
  async readAssetIndex() { return this.root.slice(); }
  async readAssetBlob(desc: { path: string }) {
    const value = this.content.get(desc.path);
    if (!value) throw new Error(`missing legacy asset ${desc.path}`);
    return value.slice();
  }
}

class MemoryTarget implements AssetShadowTarget {
  readonly files = new Map<string, Uint8Array>();
  index: Uint8Array | null = null;
  writes = 0;

  async putImmutable(input: { path: string; bytes: Uint8Array; kind: "asset" }): Promise<SyncDescriptor> {
    const existing = this.files.get(input.path);
    if (existing) {
      assert.deepEqual(existing, input.bytes, "content-addressed target path must be idempotent");
    } else {
      this.files.set(input.path, input.bytes.slice());
      this.writes += 1;
    }
    return descriptor(input.path, input.bytes);
  }

  async readBlob(desc: SyncDescriptor) {
    const value = this.files.get(desc.path);
    if (!value) throw new Error(`missing target asset ${desc.path}`);
    return value.slice();
  }

  async publishAssetIndex(bytes: Uint8Array) { this.index = bytes.slice(); }
  async readAssetIndex() { return this.index?.slice() ?? null; }
}

const expected = assets.map(({ blob: _blob, ...row }) => row as ImageAssetDescriptor);
const source = new MemorySource();
const plan = await buildLegacyAssetShadowPlan(source, expected);
assert.equal(plan.packs.size, 1);
assert.equal(plan.indexedAssetCount, assets.length);

const target = new MemoryTarget();
const staged = await stageAssetShadow(plan, target, true);
assert.equal(staged.packCount, 1);
assert.equal(staged.indexedAssetCount, assets.length);
assert.ok(target.index, "asset index must be published after immutable packs/shards");
assert.ok([...target.files.keys()].every((path) => path.startsWith("sync/v10/assets/")));
assert.ok([...target.files.keys()].every((path) => !path.startsWith(legacyPrefix)));
assert.equal(TARGET_ASSET_INDEX_PATH, "sync/v10/assets/index.json");

const firstWrites = target.writes;
const repeated = await stageAssetShadow(plan, target, true);
assert.equal(target.writes, firstWrites, "rerun must reuse all content-addressed asset objects");
assert.deepEqual(repeated.rootBytes, staged.rootBytes);

const missing = [...expected, { ...expected[0], id: "f".repeat(64) }];
await assert.rejects(() => buildLegacyAssetShadowPlan(source, missing), /missing canonical image/);

const corruptedFiles = new Map(files);
corruptedFiles.set(packPath, encoder.encode("tampered"));
await assert.rejects(() => buildLegacyAssetShadowPlan(new MemorySource(corruptedFiles), expected), /size mismatch|sha256 mismatch/);

console.log("asset shadow conversion passed: pack integrity, v10 path rewrite, canonical coverage and idempotence");
