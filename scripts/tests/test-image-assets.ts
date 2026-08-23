import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildOptimizationAttempts,
  cacheOccupancyStats,
  estimateCacheOccupancy,
  optimizeImageBlob,
  sha256Blob,
  type DecodedImage,
  type EncodeImageOptions,
  type ImageAssetAdapter,
} from "../../src/lib/io/image-assets";
import {
  buildImageAssetPack,
  buildImageAssetPacks,
  extractImageAssetFromPack,
  imageAssetIndexShardKey,
  parseImageAssetPack,
} from "../../src/lib/sync/image-asset-pack";
import { SYNC_V9_ASSET_PREFIX } from "../../src/lib/sync/sync-v7-head";
import { sha256HexBytes } from "../../src/lib/crypto/sha256";
import { mapWithConcurrency } from "../../src/lib/async/bounded-concurrency";
import type { ImageAsset } from "../../src/lib/db/v7-types";

async function expectReject(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, pattern);
}

const source = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });

const imageCacheSettingSource = await readFile(new URL("../../src/app/shell/views/image-cache-setting.tsx", import.meta.url), "utf8");
const syncApplicationSource = await readFile(new URL("../../src/lib/sync/sync-application.ts", import.meta.url), "utf8");
const syncUploadSource = await readFile(new URL("../../src/lib/sync/sync-v7-upload.ts", import.meta.url), "utf8");
const imageCacheSource = await readFile(new URL("../../src/lib/sync/image-asset-cache.ts", import.meta.url), "utf8");
const imagePackSource = await readFile(new URL("../../src/lib/sync/image-asset-pack.ts", import.meta.url), "utf8");
assert.equal(SYNC_V9_ASSET_PREFIX, "sync/v9/assets/", "Asset Pack root must stay inside the public v9 namespace");
assert.match(syncApplicationSource, /downloadAllImageAssets\(onProgress\?: ImageCacheDownloadProgressCallback\)/, "sync facade must expose image cache progress");
assert.match(imageCacheSettingSource, /role="progressbar"[^>]*aria-label="图片缓存进度"/, "image cache progress must be accessible");
assert.match(imageCacheSettingSource, /正在并发下载图片/, "image cache UI must identify concurrent image download progress");
assert.match(syncUploadSource, /publishImageAssetsAsPacks/, "sync upload must publish image packs instead of individual image files");
assert.doesNotMatch(syncUploadSource, /putImmutable\([\s\S]*sha256:\s*asset\.id/, "sync upload must not create one immutable Git file per image");
assert.match(imageCacheSource, /readImageAssetsFromPacks/, "full image cache must batch by pack instead of requesting every image blob");
assert.match(imagePackSource, /for \(const group of groupImageAssetsForPacks\(pendingBase\)\)/, "one-shot migration must hydrate and upload one bounded pack group at a time");
assert.match(imagePackSource, /if \(assets\.every\(\(asset\) => isIndexed\(knownShards, asset\)\)\) return \[\];/, "idempotent pack publication must use the cached index fast path before Git ref reads");
assert.doesNotMatch(imagePackSource, /const pending = await mapWithConcurrency\(pendingBase/, "migration must not hydrate every legacy image into memory at once");

// The shared pool must preserve order, cap active work and stop claiming new
// items after the first worker error. This protects import/export/image-cache
// callers from turning one bad asset into an unbounded queue.
{
  let active = 0;
  let maximum = 0;
  let started = 0;
  await assert.rejects(
    () => mapWithConcurrency([0, 1, 2, 3, 4, 5, 6], 3, async (item) => {
      started += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, item === 1 ? 2 : 5));
      active -= 1;
      if (item === 1) throw new Error("first worker failure");
      return item;
    }),
    /first worker failure/,
  );
  assert.ok(maximum <= 3, "bounded pool must cap active workers");
  assert.ok(started <= 3, "first worker failure must prevent new work from starting");

  const controller = new AbortController();
  let signalSeen = false;
  const abortPromise = mapWithConcurrency([1, 2, 3], 2, async (_item, _index, signal) => {
    signalSeen = signal === controller.signal;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 1;
  }, controller.signal);
  controller.abort();
  await assert.rejects(() => abortPromise, /aborted/i);
  assert.equal(signalSeen, true, "workers receive the shared AbortSignal");
}
assert.equal(sha256HexBytes(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "纯 JS SHA-256 空输入必须匹配标准向量");
assert.equal(sha256HexBytes(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "局域网回退必须匹配标准 SHA-256");

function adapterFor(
  decode: DecodedImage,
  encode: (options: EncodeImageOptions) => Blob | null | Promise<Blob | null>,
  onDispose?: () => void,
): ImageAssetAdapter {
  return {
    async decode() {
      return decode;
    },
    async encode(_decoded, options) {
      return encode(options);
    },
    dispose() {
      onDispose?.();
    },
  };
}

// Pure attempt generation first applies the longest-edge limit and then lowers
// quality before lowering dimensions.
const attempts = buildOptimizationAttempts(4000, 2000, {
  maxDimension: 2048,
  maxAttempts: 20,
});
assert.deepEqual(attempts[0], { mimeType: "image/webp", width: 2048, height: 1024, quality: 0.86 });
assert.equal(attempts[1].width, 2048);
assert.ok((attempts[1].quality ?? 1) < (attempts[0].quality ?? 1));
assert.ok(attempts.some((attempt) => attempt.width < 2048));
const boundedAttempts = buildOptimizationAttempts(4000, 3000, { maxAttempts: 10_000 });
assert.ok(boundedAttempts.length <= 300);
assert.ok(new Set(boundedAttempts.map((attempt) => attempt.mimeType)).size >= 2);

// A small first encode is returned directly and receives the digest of its
// bytes, not of the source Blob.
let disposed = 0;
const direct = await optimizeImageBlob(source, {
  adapter: adapterFor({ width: 1600, height: 900 }, (options) => new Blob([new Uint8Array([9, 8, 7])], { type: options.mimeType }), () => {
    disposed += 1;
  }),
});
assert.equal(direct.size, 3);
assert.equal(direct.width, 1600);
assert.equal(direct.height, 900);
assert.equal(direct.mimeType, "image/webp");
assert.equal(direct.id, await sha256Blob(direct.blob));
assert.equal(disposed, 1);

let closed = 0;
await optimizeImageBlob(source, {
  adapter: {
    async decode() {
      return { width: 32, height: 32, close: () => { closed += 1; } };
    },
    async encode(_decoded, options) {
      return new Blob([new Uint8Array([2])], { type: options.mimeType });
    },
  },
});
assert.equal(closed, 1);

// Oversized output progressively lowers quality and eventually dimensions.
const reductionCalls: EncodeImageOptions[] = [];
const reduced = await optimizeImageBlob(source, {
  maxBytes: 500,
  adapter: adapterFor({ width: 4000, height: 1000 }, (options) => {
    reductionCalls.push(options);
    const quality = options.quality ?? 1;
    const bytes = Math.max(64, Math.ceil((options.width * options.height * quality) / 1000));
    return new Blob([new Uint8Array(bytes)], { type: options.mimeType });
  }),
});
assert.ok(reduced.size <= 500);
assert.ok(reductionCalls.length > 1);
assert.ok(reductionCalls.some((call, index) => index > 0 && (
  (call.quality ?? 1) < (reductionCalls[index - 1].quality ?? 1)
  || call.width < reductionCalls[index - 1].width
)));

// If WebP encoding is unavailable, opaque images use the JPEG fallback.
const fallback = await optimizeImageBlob(source, {
  adapter: adapterFor({ width: 100, height: 100, hasAlpha: false }, (options) => (
    options.mimeType === "image/webp" ? null : new Blob([new Uint8Array([6])], { type: options.mimeType })
  )),
});
assert.equal(fallback.mimeType, "image/jpeg");

// A large source still reaches a fallback when WebP is unavailable. Exercise
// both browser-style null and thrown encoder failures; the first MIME must not
// consume the independent JPEG/PNG budget.
for (const unavailable of ["null", "throw"] as const) {
  const fallbackCalls: EncodeImageOptions[] = [];
  const largeFallback = await optimizeImageBlob(source, {
    maxBytes: 100,
    adapter: adapterFor({ width: 4000, height: 3000, hasAlpha: false }, (options) => {
      fallbackCalls.push(options);
      if (options.mimeType === "image/webp") {
        if (unavailable === "throw") throw new Error("encoder unavailable");
        return null;
      }
      return new Blob([new Uint8Array([4, 2])], { type: options.mimeType });
    }),
  });
  assert.equal(largeFallback.mimeType, "image/jpeg");
  assert.ok(fallbackCalls.some((call) => call.mimeType === "image/jpeg"));
  assert.equal(fallbackCalls.filter((call) => call.mimeType === "image/webp").length, 1);
}

// An alpha image falls back to PNG rather than losing transparency.
const alphaFallback = await optimizeImageBlob(source, {
  adapter: adapterFor({ width: 100, height: 100, hasAlpha: true }, (options) => (
    options.mimeType === "image/webp" ? null : new Blob([new Uint8Array([5])], { type: options.mimeType })
  )),
});
assert.equal(alphaFallback.mimeType, "image/png");

// Even the smallest encode cannot fit: the adapter is still released and the
// user-facing error contains no local file path.
let releasedAfterFailure = 0;
await expectReject(() => optimizeImageBlob(source, {
  maxBytes: 20,
  adapter: adapterFor({ width: 200, height: 100 }, () => new Blob([new Uint8Array(21)], { type: "image/webp" }), () => {
    releasedAfterFailure += 1;
  }),
}), /图片压缩后仍超过/);
assert.equal(releasedAfterFailure, 1);

// Identical optimised bytes are content-addressed to the same id.
const stableAdapter = adapterFor({ width: 80, height: 80 }, () => new Blob([new Uint8Array([3, 1, 4, 1, 5])], { type: "image/webp" }));
const [first, second] = await Promise.all([
  optimizeImageBlob(source, { adapter: stableAdapter }),
  optimizeImageBlob(source, { adapter: stableAdapter }),
]);
assert.equal(first.id, second.id);

// Asset Pack format keeps logical SHA-256 image identity while changing only
// the physical Git storage unit. maxAssets=2 forces deterministic multi-pack
// coverage without allocating multi-megabyte fixtures.
async function packAsset(bytes: number[], mimeType: ImageAsset["mimeType"] = "image/png"): Promise<ImageAsset & { blob: Blob }> {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  return {
    id: await sha256Blob(blob),
    mimeType,
    size: blob.size,
    width: 10,
    height: 10,
    blob,
  };
}
const packFixtures = await Promise.all([
  packAsset([1, 1, 1]),
  packAsset([2, 2, 2, 2]),
  packAsset([3, 3, 3, 3, 3]),
  packAsset([4, 4, 4]),
  packAsset([5, 5, 5, 5]),
]);
const directPack = await buildImageAssetPack(packFixtures.slice(0, 2));
assert.equal(directPack.entries.length, 2, "direct builder must preserve both logical assets");
const builtPacks = await buildImageAssetPacks(packFixtures, { maxAssets: 2 });
assert.equal(builtPacks.length, 3, "five images with maxAssets=2 must become three immutable packs");
assert.ok(builtPacks.every((pack) => pack.entries.length <= 2));
const packedIds = new Set(builtPacks.flatMap((pack) => pack.entries.map((entry) => entry.id)));
assert.deepEqual(packedIds, new Set(packFixtures.map((asset) => asset.id)), "every logical asset must occur in exactly one pack");
for (const pack of builtPacks) {
  const parsed = parseImageAssetPack(pack.bytes);
  assert.equal(parsed.header.entries.length, pack.entries.length);
  for (const entry of pack.entries) {
    const extracted = await extractImageAssetFromPack(pack.bytes, entry.id);
    assert.equal(sha256HexBytes(extracted), entry.id, "pack extraction must preserve the logical image digest");
  }
}
assert.equal(imageAssetIndexShardKey("0".repeat(64)), "0");
assert.equal(imageAssetIndexShardKey("4".repeat(64)), "1");
assert.equal(imageAssetIndexShardKey("8".repeat(64)), "2");
assert.equal(imageAssetIndexShardKey("f".repeat(64)), "3");

assert.deepEqual(cacheOccupancyStats({ usage: 25, quota: 100 }), {
  usageBytes: 25,
  quotaBytes: 100,
  remainingBytes: 75,
  usageRatio: 0.25,
  usagePercent: 25,
});
assert.deepEqual(cacheOccupancyStats(undefined), { usageBytes: 0 });
assert.deepEqual(await estimateCacheOccupancy({ estimate: async () => ({ usage: 4, quota: 8 }) }), {
  usageBytes: 4,
  quotaBytes: 8,
  remainingBytes: 4,
  usageRatio: 0.5,
  usagePercent: 50,
});
assert.deepEqual(await estimateCacheOccupancy({}), { usageBytes: 0 });

await expectReject(() => optimizeImageBlob(new Blob([new Uint8Array([1])], { type: "image/gif" }), {
  adapter: stableAdapter,
}), /不受支持/);

console.log("image asset tests passed");
