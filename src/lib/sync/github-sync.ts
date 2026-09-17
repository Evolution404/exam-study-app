/** Stable public synchronization facade. */
export {
  getGitHubLogin,
  getLastRemoteCache,
  getSyncHotWindowState,
  pullFromGitHub,
  restoreFromGitHub,
  restoreFullHistoryFromGitHub,
  restoreLastRemoteCache,
  syncWithGitHub,
} from "./github-sync-engine";
export type { SyncHotWindowState, SyncProgress, SyncProgressCallback } from "./github-sync-engine";

// Image blobs are transport-independent local cache helpers. Keep only the
// facade names consumed outside the synchronization implementation.
export {
  clearImageCache,
  downloadAllImageAssets,
  downloadImageAsset,
  downloadImageAssets,
  getImageCacheStats,
} from "./image-asset-cache";
