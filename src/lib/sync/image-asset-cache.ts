// Transport-independent local image-blob cache helpers.
//
// Runtime image reads are pack-index based: one mutable index pointer locates a
// small shard, and the shard locates an immutable multi-image Pack. Neither UI
// nor export code ever performs one GitHub request per image anymore.
import { clearImageCacheV7, dbV7, getImageAssetDescriptorV7, putImageAssetBlobV7 } from "../db/db-v7";
import { sha256Blob } from "../io/image-assets";
import { createGitHubV7Remote } from "./github-v7-remote";
import { readImageAssetFromPack, readImageAssetsFromPacks } from "./image-asset-pack";
import type { GitHubSettings } from "../../types/types";
import { getGitHubTransport, resolveGitHubApiBaseUrl, type GitHubTransport } from "../../platform/github-transport";

export interface ImageCacheDownloadProgress {
  /** Number of missing image assets written to the local cache. */
  completed: number;
  /** Number of missing image assets planned for this run. */
  total: number;
  /** Logical bytes written to the local cache. */
  completedBytes: number;
  /** Logical bytes planned for this run. */
  totalBytes: number;
  /** Monotonic combined progress, in the range 0–100. */
  percent: number;
}

export type ImageCacheDownloadProgressCallback = (progress: ImageCacheDownloadProgress) => void;

async function getImageCacheStatsV7() {
  const assets = await dbV7.imageAssets.toArray();
  return {
    total: assets.length,
    cached: assets.filter((asset) => Boolean(asset.blob)).length,
    bytes: assets.reduce((sum, asset) => sum + (asset.blob?.size ?? 0), 0),
    totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
  };
}

function clientFor(settings: GitHubSettings, token: string, options: { fetch?: typeof fetch; transport?: GitHubTransport }) {
  const transport = options.transport ?? getGitHubTransport();
  return createGitHubV7Remote({
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch?.trim() || "main",
    token,
    apiBaseUrl: resolveGitHubApiBaseUrl(settings.apiBaseUrl, transport),
    fetch: options.fetch ?? transport.fetch,
  });
}

async function verifiedRemoteBlob(asset: { id: string; mimeType: string; size: number }, bytes: Uint8Array): Promise<Blob> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: asset.mimeType });
  if (blob.size !== asset.size || await sha256Blob(blob) !== asset.id) throw new Error(`图片 ${asset.id} 完整性校验失败。`);
  return blob;
}

export async function downloadImageAssetV7(
  settings: GitHubSettings,
  token: string,
  assetId: string,
  options: { fetch?: typeof fetch; transport?: GitHubTransport; signal?: AbortSignal } = {},
): Promise<Blob> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("The operation was aborted");
  const descriptor = await getImageAssetDescriptorV7(assetId);
  if (!descriptor) throw new Error("图片 descriptor 不存在。");
  const bytes = await readImageAssetFromPack(clientFor(settings, token, options), assetId);
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("The operation was aborted");
  const blob = await verifiedRemoteBlob(descriptor, bytes);
  await putImageAssetBlobV7(assetId, blob);
  return blob;
}

/** Resolve only the requested assets. Cached blobs stay local; all cache misses
 * are resolved through one index/shard/Pack batch so callers such as bank export
 * do not accidentally reintroduce one remote request chain per image. */
export async function downloadImageAssetsV7(
  settings: GitHubSettings,
  token: string,
  assetIds: readonly string[],
  options: { fetch?: typeof fetch; transport?: GitHubTransport; signal?: AbortSignal } = {},
): Promise<Map<string, Blob>> {
  const ids = [...new Set(assetIds)];
  const result = new Map<string, Blob>();
  if (!ids.length) return result;
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("The operation was aborted");

  const descriptors = await dbV7.imageAssets.bulkGet(ids);
  const pending = descriptors.filter((asset): asset is NonNullable<typeof asset> => Boolean(asset && !asset.blob));
  for (const asset of descriptors) {
    if (asset?.blob) result.set(asset.id, asset.blob);
  }
  if (!pending.length) return result;

  const bytesById = await readImageAssetsFromPacks(clientFor(settings, token, options), pending.map((asset) => asset.id));
  for (const asset of pending) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("The operation was aborted");
    const bytes = bytesById.get(asset.id);
    if (!bytes) throw new Error(`图片 ${asset.id} 未从 Asset Pack 返回。`);
    const blob = await verifiedRemoteBlob(asset, bytes);
    await putImageAssetBlobV7(asset.id, blob);
    result.set(asset.id, blob);
  }
  return result;
}

async function downloadAllImageAssetsV7(
  settings: GitHubSettings,
  token: string,
  options: { fetch?: typeof fetch; transport?: GitHubTransport; signal?: AbortSignal; onProgress?: ImageCacheDownloadProgressCallback } = {},
): Promise<number> {
  const assets = await dbV7.imageAssets.toArray();
  const pending = assets.filter((asset) => !asset.blob);
  const total = pending.length;
  const totalBytes = pending.reduce((sum, asset) => sum + asset.size, 0);
  let completed = 0;
  let completedBytes = 0;
  const report = () => {
    const countFraction = total ? completed / total : 1;
    const byteFraction = totalBytes ? completedBytes / totalBytes : countFraction;
    options.onProgress?.({
      completed,
      total,
      completedBytes,
      totalBytes,
      percent: Math.round(Math.min(1, byteFraction) * 100),
    });
  };
  report();
  if (!pending.length) return 0;
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("The operation was aborted");

  // Resolve the entire missing set in one batch. The resolver downloads one
  // index pointer, at most four shards, and each unique Pack once; it never
  // loops over remote image objects.
  const bytesById = await readImageAssetsFromPacks(clientFor(settings, token, options), pending.map((asset) => asset.id));
  for (const asset of pending) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("The operation was aborted");
    const bytes = bytesById.get(asset.id);
    if (!bytes) throw new Error(`图片 ${asset.id} 未从 Asset Pack 返回。`);
    const blob = await verifiedRemoteBlob(asset, bytes);
    await putImageAssetBlobV7(asset.id, blob);
    completed += 1;
    completedBytes += blob.size;
    report();
  }
  return completed;
}

export const downloadImageAsset = downloadImageAssetV7;
export const downloadImageAssets = downloadImageAssetsV7;
export const downloadAllImageAssets = downloadAllImageAssetsV7;
export const getImageCacheStats = getImageCacheStatsV7;
export const clearImageCache = clearImageCacheV7;
