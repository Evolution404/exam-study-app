import assert from "node:assert/strict";
import {
  buildOptimizationAttempts,
  cacheOccupancyStats,
  estimateCacheOccupancy,
  optimizeImageBlob,
  remoteAssetPath,
  sha256Blob,
  type DecodedImage,
  type EncodeImageOptions,
  type ImageAssetAdapter,
} from "../../src/lib/io/image-assets";

function expectThrow(action: () => unknown, pattern: RegExp): void {
  assert.throws(action, pattern);
}

async function expectReject(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, pattern);
}

const source = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });

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

// A large source still reaches a fallback when WebP is unavailable.  Exercise
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

const digest = "a".repeat(64);
assert.equal(remoteAssetPath(digest, "image/webp"), `sync/v8/assets/${digest}.webp`);
assert.equal(remoteAssetPath(digest, "image/jpeg"), `sync/v8/assets/${digest}.jpg`);
assert.equal(remoteAssetPath(digest, "image/png"), `sync/v8/assets/${digest}.png`);
expectThrow(() => remoteAssetPath(digest.toUpperCase(), "image/webp"), /小写/);
expectThrow(() => remoteAssetPath("short", "image/webp"), /64 位/);
expectThrow(() => remoteAssetPath(digest, "image/gif"), /不受支持/);

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
