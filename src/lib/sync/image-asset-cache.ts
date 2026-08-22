// Transport-independent local image-blob cache helpers.
//
// Image assets are content-addressed descriptors stored in dbV7.imageAssets;
// only the lazy download needs a remote, and v7's GitHubV7Remote reads the
// same Git blobs (by blobSha) that the legacy v7 transport did.  These helpers
// live outside the sync modules so the v7 transport can be removed without
// touching the cache surface the app consumes through the sync facade.
import { clearImageCacheV7, dbV7, getImageAssetBlobV7, getImageAssetDescriptorV7, putImageAssetBlobV7 } from "../db/db-v7";
import { sha256Blob } from "../io/image-assets";
import { mapWithConcurrency } from "../async/bounded-concurrency";
import { createGitHubV7Remote } from "./github-v7-remote";
import type { GitHubSettings } from "../../types/types";
import { getGitHubTransport, resolveGitHubApiBaseUrl, type GitHubTransport } from "../../platform/github-transport";

export { clearImageCacheV7, getImageAssetBlobV7 };

/** Image cache downloads share the same six-lane budget as sync asset upload. */
export const IMAGE_CACHE_DOWNLOAD_CONCURRENCY = 6;

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

export async function getImageCacheStatsV7() {
  const assets = await dbV7.imageAssets.toArray();
  return {
    total: assets.length,
    cached: assets.filter((asset) => Boolean(asset.blob)).length,
    bytes: assets.reduce((sum, asset) => sum + (asset.blob?.size ?? 0), 0),
    totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
  };
}

export async function downloadImageAssetV7(settings: GitHubSettings, token: string, assetId: string, options: { fetch?: typeof fetch; transport?: GitHubTransport; signal?: AbortSignal } = {}): Promise<Blob> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("The operation was aborted");
  const descriptor = await getImageAssetDescriptorV7(assetId);
  if (!descriptor?.remote) throw new Error("图片 descriptor 缺少远端资产路径。");
  const transport = options.transport ?? getGitHubTransport();
  const bytes = await createGitHubV7Remote({
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch?.trim() || "main",
    token,
    apiBaseUrl: resolveGitHubApiBaseUrl(settings.apiBaseUrl, transport),
    fetch: options.fetch ?? transport.fetch,
  }).readBlob(descriptor.remote.blobSha, { size: descriptor.remote.size, sha256: descriptor.remote.sha256 });
  const blob = new Blob([bytes as unknown as BlobPart], { type: descriptor.mimeType });
  if (blob.size !== descriptor.size || await sha256Blob(blob) !== descriptor.id) throw new Error("远端图片完整性校验失败。");
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("The operation was aborted");
  await putImageAssetBlobV7(assetId, blob);
  return blob;
}

export async function downloadAllImageAssetsV7(settings: GitHubSettings, token: string, options: { fetch?: typeof fetch; transport?: GitHubTransport; signal?: AbortSignal; onProgress?: ImageCacheDownloadProgressCallback } = {}): Promise<number> {
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
      percent: Math.round(Math.min(1, Math.max(countFraction, byteFraction)) * 100),
    });
  };
  report();
  await mapWithConcurrency(pending, IMAGE_CACHE_DOWNLOAD_CONCURRENCY, async (asset, _index, signal) => {
    const blob = await downloadImageAssetV7(settings, token, asset.id, { ...options, signal });
    completed += 1;
    completedBytes += blob.size;
    report();
    return blob;
  }, { signal: options.signal });
  return completed;
}

export const downloadImageAsset = downloadImageAssetV7;
export const downloadAllImageAssets = downloadAllImageAssetsV7;
export const getImageCacheStats = getImageCacheStatsV7;
export const clearImageCache = clearImageCacheV7;
