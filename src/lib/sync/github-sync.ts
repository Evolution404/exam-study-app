/** Stable public synchronization facade. Production sync is v7-only. */
export {
  getGitHubLogin,
  getLastRemoteCache,
  getSyncHotWindowState,
  getSyncStats,
  initializeGitHubVault,
  loadAttemptHistory,
  pullFromGitHub,
  restoreFromGitHub,
  restoreFullHistoryFromGitHub,
  restoreLastRemoteCache,
  syncWithGitHub,
  verifyGitHubVault,
} from "./github-sync-v7";
export type { SyncHotWindowState, SyncProgress, SyncProgressCallback } from "./github-sync-v7";

// Image blobs are transport-independent local cache helpers. Their existing
// implementation remains valid because v7 keeps the same content-addressed
// image descriptors and never emits an event for a blob-only cache write.
export {
  clearImageCacheV6,
  clearImageCache,
  downloadAllImageAssetsV6,
  downloadAllImageAssets,
  downloadImageAssetV6,
  downloadImageAsset,
  getImageAssetBlobV6,
  getImageCacheStatsV6,
  getImageCacheStats,
} from "./image-asset-cache";
