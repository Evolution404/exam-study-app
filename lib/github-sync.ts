/** Stable public synchronization facade.
 *
 * UI imports stay intentionally unchanged while production synchronization is
 * v6-only.  Legacy v5 code is not imported here; migration-only tooling may
 * continue to import it directly.
 */
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
  getSyncStatsV6,
  getSyncStats,
  getLastRemoteCache,
  getGitHubLoginV6 as getGitHubLogin,
  initializeGitHubVaultV6 as initializeGitHubVault,
  loadAttemptHistoryV6 as loadAttemptHistory,
  pullFromGitHubV6 as pullFromGitHub,
  restoreFromGitHubV6 as restoreFromGitHub,
  restoreFullHistoryFromGitHubV6 as restoreFullHistoryFromGitHub,
  restoreLastRemoteCache,
  syncWithGitHubV6 as syncWithGitHub,
  verifyGitHubVaultV6 as verifyGitHubVault,
} from "./github-sync-v6";
export type {
  SyncProgress,
  SyncProgressCallback,
  SyncV6Progress,
  SyncV6ProgressCallback,
} from "./github-sync-v6";
