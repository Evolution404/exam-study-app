/**
 * v7 image asset cache: descriptor/blob persistence with digest validation.
 */
import { sha256Blob } from "../io/image-assets";
import { dbV7, nowIso } from "./db-v7-core";
import type { ImageAsset, ImageAssetDescriptorV7 } from "./v7-types";

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

function imageAssetDescriptor(asset: ImageAsset): ImageAssetDescriptorV7 {
  const { blob: _blob, ...descriptor } = asset;
  void _blob;
  return descriptor;
}

/** Store a descriptor and, when supplied, verify and cache its blob. */
export async function putImageAssetV7(asset: ImageAsset): Promise<ImageAsset> {
  assertImageAssetShape(asset);
  if (asset.blob) {
    const digest = await sha256Blob(asset.blob);
    if (digest !== asset.id) throw new TypeError("图片 blob 内容与 id 不一致");
  }
  const descriptor = imageAssetDescriptor(asset);
  if (!asset.blob) {
    await dbV7.transaction("rw", dbV7.imageAssets, async () => {
      await dbV7.imageAssets.put(descriptor);
    });
    const cached = await dbV7.imageBlobs.get(asset.id);
    return cached?.blob ? { ...descriptor, blob: cached.blob } : descriptor;
  }
  return dbV7.transaction("rw", [dbV7.imageAssets, dbV7.imageBlobs], async () => {
    await dbV7.imageAssets.put(descriptor);
    const previous = await dbV7.imageBlobs.get(asset.id);
    await dbV7.imageBlobs.put({
      assetId: asset.id,
      blob: asset.blob!,
      cachedAt: nowIso(),
      ...(previous?.lastUsedAt ? { lastUsedAt: previous.lastUsedAt } : {}),
    });
    return { ...descriptor, blob: asset.blob };
  });
}

export async function putImageAssetDescriptorV7(asset: ImageAssetDescriptorV7): Promise<ImageAsset> {
  return putImageAssetV7(asset);
}

export async function putImageAssetBlobV7(id: string, blob: Blob): Promise<ImageAsset> {
  if (await sha256Blob(blob) !== id) throw new TypeError("图片 blob 内容与 descriptor 不一致");
  return dbV7.transaction("rw", [dbV7.imageAssets, dbV7.imageBlobs], async () => {
    const descriptor = await dbV7.imageAssets.get(id);
    if (!descriptor) throw new Error("图片 descriptor 不存在。");
    if (blob.size !== descriptor.size) throw new TypeError("图片 blob 内容与 descriptor 不一致");
    const previous = await dbV7.imageBlobs.get(id);
    await dbV7.imageBlobs.put({
      assetId: id,
      blob,
      cachedAt: nowIso(),
      ...(previous?.lastUsedAt ? { lastUsedAt: previous.lastUsedAt } : {}),
    });
    return { ...descriptor, blob };
  });
}

export async function getImageAssetV7(id: string): Promise<ImageAsset | undefined> {
  const [descriptor, cached] = await Promise.all([dbV7.imageAssets.get(id), dbV7.imageBlobs.get(id)]);
  if (!descriptor) return undefined;
  return cached?.blob ? { ...descriptor, blob: cached.blob } : descriptor;
}

export async function getImageAssetDescriptorV7(id: string): Promise<ImageAssetDescriptorV7 | undefined> {
  return dbV7.imageAssets.get(id);
}

export async function getImageAssetBlobV7(id: string): Promise<Blob | undefined> {
  return (await dbV7.imageBlobs.get(id))?.blob;
}

export async function getImageCacheSizeV7(): Promise<number> {
  const cached = await dbV7.imageBlobs.toArray();
  return cached.reduce((total, asset) => total + asset.blob.size, 0);
}

export async function clearImageCacheV7(): Promise<number> {
  return dbV7.transaction("rw", dbV7.imageBlobs, async () => {
    const cached = await dbV7.imageBlobs.toArray();
    await dbV7.imageBlobs.clear();
    return cached.length;
  });
}

export const putImageAssetDescriptor = putImageAssetDescriptorV7;
export const putImageAssetBlob = putImageAssetBlobV7;
export const getImageAssetDescriptor = getImageAssetDescriptorV7;
export const getImageAssetBlob = getImageAssetBlobV7;
export const getImageCacheSize = getImageCacheSizeV7;
export const clearImageCache = clearImageCacheV7;
