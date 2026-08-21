/**
 * v7 image asset cache: descriptor/blob persistence with digest validation.
 */
import { sha256Blob } from "../io/image-assets";
import { dbV7, nowIso } from "./db-v7-core";
import { enqueueChangeSetV7 } from "./db-v7-change-sets";
import type { ImageAsset } from "./v7-types";

const imageMimeTypes = new Set(["image/webp", "image/jpeg", "image/png"]);

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field}必须是 64 位小写 SHA-256 摘要`);
}

function assertImageAssetShape(asset: ImageAsset): void {
  assertDigest(asset.id, "图片 id");
  if (!imageMimeTypes.has(asset.mimeType)) throw new TypeError("图片 MIME 类型不受支持");
  if (!Number.isSafeInteger(asset.size) || asset.size < 0) throw new TypeError("图片 size 必须是非负整数");
  if (!Number.isSafeInteger(asset.width) || asset.width <= 0 || !Number.isSafeInteger(asset.height) || asset.height <= 0) throw new TypeError("图片尺寸必须是正整数");
  if (asset.remote) {
    assertDigest(asset.remote.sha256, "远端图片 sha256");
    if (asset.remote.sha256 !== asset.id) throw new TypeError("远端图片 sha256 必须与 id 一致");
    if (typeof asset.remote.path !== "string" || !asset.remote.path.trim()) throw new TypeError("远端图片路径不能为空");
    if (typeof asset.remote.blobSha !== "string" || !/^[a-f0-9]{40}$/.test(asset.remote.blobSha)) throw new TypeError("远端图片 blobSha 无效");
    if (!Number.isSafeInteger(asset.remote.size) || asset.remote.size !== asset.size) throw new TypeError("远端图片 size 必须与 descriptor 一致");
  }
  if (asset.blob !== undefined && asset.blob.size !== asset.size) throw new TypeError("图片 blob size 与 descriptor 不一致");
}

/** Store a descriptor and, when supplied, verify and cache its blob. */
export async function putImageAssetV7(asset: ImageAsset): Promise<ImageAsset> {
  assertImageAssetShape(asset);
  if (asset.blob) {
    const digest = await sha256Blob(asset.blob);
    if (digest !== asset.id) throw new TypeError("图片 blob 内容与 id 不一致");
  }
  const previous = await dbV7.imageAssets.get(asset.id);
  const descriptorChanged = JSON.stringify({ ...previous, blob: undefined }) !== JSON.stringify({ ...asset, blob: undefined });
  // 保留已缓存的 blob：调用方只写 descriptor 时不应清掉本地图片缓存。
  const stored = asset.blob ?? (previous?.blob?.size === asset.size ? previous.blob : undefined);
  await dbV7.transaction("rw", [dbV7.imageAssets, dbV7.changeSets, dbV7.syncMeta], async () => {
    await dbV7.imageAssets.put(stored ? { ...asset, blob: stored } : asset);
    if (asset.remote && descriptorChanged) {
      const createdAt = nowIso();
      const descriptor = { ...asset, blob: undefined };
      await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
    }
  });
  return stored ? { ...asset, blob: stored } : asset;
}

export async function putImageAssetDescriptorV7(asset: Omit<ImageAsset, "blob">): Promise<ImageAsset> {
  return putImageAssetV7(asset);
}

export async function putImageAssetBlobV7(id: string, blob: Blob): Promise<ImageAsset> {
  const descriptor = await dbV7.imageAssets.get(id);
  if (!descriptor) throw new Error("图片 descriptor 不存在。");
  if (await sha256Blob(blob) !== id || blob.size !== descriptor.size) throw new TypeError("图片 blob 内容与 descriptor 不一致");
  const stored = { ...descriptor, blob };
  await dbV7.imageAssets.put(stored);
  return stored;
}

export async function getImageAssetV7(id: string): Promise<ImageAsset | undefined> {
  return dbV7.imageAssets.get(id);
}

export async function getImageAssetDescriptorV7(id: string): Promise<Omit<ImageAsset, "blob"> | undefined> {
  const asset = await dbV7.imageAssets.get(id);
  if (!asset) return undefined;
  const descriptor = { ...asset };
  delete descriptor.blob;
  return descriptor;
}

export async function getImageAssetBlobV7(id: string): Promise<Blob | undefined> {
  return (await dbV7.imageAssets.get(id))?.blob;
}

export async function getImageCacheSizeV7(): Promise<number> {
  const assets = await dbV7.imageAssets.toArray();
  return assets.reduce((total, asset) => total + (asset.blob?.size ?? 0), 0);
}

export async function clearImageCacheV7(): Promise<number> {
  const assets = await dbV7.imageAssets.toArray();
  let cleared = 0;
  await dbV7.transaction("rw", dbV7.imageAssets, async () => {
    for (const asset of assets) {
      if (!asset.blob) continue;
      await dbV7.imageAssets.put({ ...asset, blob: undefined });
      cleared += 1;
    }
  });
  return cleared;
}

export const putImageAssetDescriptor = putImageAssetDescriptorV7;
export const putImageAssetBlob = putImageAssetBlobV7;
export const getImageAssetDescriptor = getImageAssetDescriptorV7;
export const getImageAssetBlob = getImageAssetBlobV7;
export const getImageCacheSize = getImageCacheSizeV7;
export const clearImageCache = clearImageCacheV7;
