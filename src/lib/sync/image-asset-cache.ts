// Transport-independent local image-blob cache helpers.
//
// Image assets are content-addressed descriptors stored in dbV7.imageAssets;
// only the lazy download needs a remote, and v7's GitHubV7Remote reads the
// same Git blobs (by blobSha) that the legacy v7 transport did.  These helpers
// live outside the sync modules so the v7 transport can be removed without
// touching the cache surface the app consumes through the sync facade.
import { clearImageCacheV7, dbV7, getImageAssetBlobV7, getImageAssetDescriptorV7, putImageAssetBlobV7 } from "../db/db-v7";
import { sha256Blob } from "../io/image-assets";
import { createGitHubV7Remote } from "./github-v7-remote";
import type { GitHubSettings } from "../../types/types";

export { clearImageCacheV7, getImageAssetBlobV7 };

export async function getImageCacheStatsV7() {
  const assets = await dbV7.imageAssets.toArray();
  return {
    total: assets.length,
    cached: assets.filter((asset) => Boolean(asset.blob)).length,
    bytes: assets.reduce((sum, asset) => sum + (asset.blob?.size ?? 0), 0),
    totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
  };
}

export async function downloadImageAssetV7(settings: GitHubSettings, token: string, assetId: string): Promise<Blob> {
  const descriptor = await getImageAssetDescriptorV7(assetId);
  if (!descriptor?.remote) throw new Error("图片 descriptor 缺少远端资产路径。");
  const bytes = await createGitHubV7Remote({
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch?.trim() || "main",
    token,
    apiBaseUrl: settings.apiBaseUrl,
  }).readBlob(descriptor.remote.blobSha, { size: descriptor.remote.size, sha256: descriptor.remote.sha256 });
  const blob = new Blob([bytes as unknown as BlobPart], { type: descriptor.mimeType });
  if (blob.size !== descriptor.size || await sha256Blob(blob) !== descriptor.id) throw new Error("远端图片完整性校验失败。");
  await putImageAssetBlobV7(assetId, blob);
  return blob;
}

export async function downloadAllImageAssetsV7(settings: GitHubSettings, token: string): Promise<number> {
  const assets = await dbV7.imageAssets.toArray();
  let downloaded = 0;
  for (const asset of assets) if (!asset.blob) { await downloadImageAssetV7(settings, token, asset.id); downloaded += 1; }
  return downloaded;
}

export const downloadImageAsset = downloadImageAssetV7;
export const downloadAllImageAssets = downloadAllImageAssetsV7;
export const getImageCacheStats = getImageCacheStatsV7;
export const clearImageCache = clearImageCacheV7;
