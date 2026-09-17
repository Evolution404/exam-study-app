/**
 * Image asset cache: descriptor/blob persistence with digest validation.
 */
import { sha256Blob } from "../io/image-assets";
import { studyDb, nowIso } from "./db-core";
import type { ImageAsset, ImageAssetDescriptor } from "./types";

const imageMimeTypes = new Set(["image/webp", "image/jpeg", "image/png"]);

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field}必须是 64 位小写 SHA-256 摘要`);
}

function assertImageAssetShape(asset: ImageAsset): void {
  assertDigest(asset.id, "图片 id");
  if (!imageMimeTypes.has(asset.mimeType)) throw new TypeError("图片 MIME 类型不受支持");
  if (!Number.isSafeInteger(asset.size) || asset.size < 0) throw new TypeError("图片 size 必须是非负整数");
  if (!Number.isSafeInteger(asset.width) || asset.width <= 0 || !Number.isSafeInteger(asset.height) || asset.height <= 0) throw new TypeError("图片尺寸必须是正整数");
  if (asset.blob !== undefined && asset.blob.size !== asset.size) throw new TypeError("图片 blob size 与 descriptor 不一致");
}

function imageAssetDescriptor(asset: ImageAsset): ImageAssetDescriptor {
  const { blob: _blob, ...descriptor } = asset;
  void _blob;
  return descriptor;
}

/** Store a descriptor and, when supplied, verify and cache its blob. */
export async function putImageAsset(asset: ImageAsset): Promise<ImageAsset> {
  assertImageAssetShape(asset);
  if (asset.blob) {
    const digest = await sha256Blob(asset.blob);
    if (digest !== asset.id) throw new TypeError("图片 blob 内容与 id 不一致");
  }
  const descriptor = imageAssetDescriptor(asset);
  if (!asset.blob) {
    await studyDb.transaction("rw", studyDb.imageAssets, async () => {
      await studyDb.imageAssets.put(descriptor);
    });
    const cached = await studyDb.imageBlobs.get(asset.id);
    return cached?.blob ? { ...descriptor, blob: cached.blob } : descriptor;
  }
  return studyDb.transaction("rw", [studyDb.imageAssets, studyDb.imageBlobs], async () => {
    await studyDb.imageAssets.put(descriptor);
    const previous = await studyDb.imageBlobs.get(asset.id);
    await studyDb.imageBlobs.put({
      assetId: asset.id,
      blob: asset.blob!,
      cachedAt: nowIso(),
      ...(previous?.lastUsedAt ? { lastUsedAt: previous.lastUsedAt } : {}),
    });
    return { ...descriptor, blob: asset.blob };
  });
}

export async function putImageAssetDescriptor(asset: ImageAssetDescriptor): Promise<ImageAsset> {
  return putImageAsset(asset);
}

export async function putImageAssetBlob(id: string, blob: Blob): Promise<ImageAsset> {
  if (await sha256Blob(blob) !== id) throw new TypeError("图片 blob 内容与 descriptor 不一致");
  return studyDb.transaction("rw", [studyDb.imageAssets, studyDb.imageBlobs], async () => {
    const descriptor = await studyDb.imageAssets.get(id);
    if (!descriptor) throw new Error("图片 descriptor 不存在。");
    if (blob.size !== descriptor.size) throw new TypeError("图片 blob 内容与 descriptor 不一致");
    const previous = await studyDb.imageBlobs.get(id);
    await studyDb.imageBlobs.put({
      assetId: id,
      blob,
      cachedAt: nowIso(),
      ...(previous?.lastUsedAt ? { lastUsedAt: previous.lastUsedAt } : {}),
    });
    return { ...descriptor, blob };
  });
}

export async function getImageAsset(id: string): Promise<ImageAsset | undefined> {
  const [descriptor, cached] = await Promise.all([studyDb.imageAssets.get(id), studyDb.imageBlobs.get(id)]);
  if (!descriptor) return undefined;
  return cached?.blob ? { ...descriptor, blob: cached.blob } : descriptor;
}

export async function getImageAssetDescriptor(id: string): Promise<ImageAssetDescriptor | undefined> {
  return studyDb.imageAssets.get(id);
}

export async function getImageAssetBlob(id: string): Promise<Blob | undefined> {
  return (await studyDb.imageBlobs.get(id))?.blob;
}

export async function getImageCacheSize(): Promise<number> {
  const cached = await studyDb.imageBlobs.toArray();
  return cached.reduce((total, asset) => total + asset.blob.size, 0);
}

export async function clearImageCache(): Promise<number> {
  return studyDb.transaction("rw", studyDb.imageBlobs, async () => {
    const cached = await studyDb.imageBlobs.toArray();
    await studyDb.imageBlobs.clear();
    return cached.length;
  });
}
