/**
 * v7 sync barrel.
 *
 * This file only re-exports the public v7 sync surface from the split
 * implementation modules.  The implementation lives in:
 *   sync-v7-context.ts           progress + client context helpers
 *   sync-v7-cache.ts             local IndexedDB cache reads/writes
 *   sync-v7-watermark.ts         device watermark + tombstone GC + install decision
 *   sync-v7-upload.ts            image-asset upload + descriptor upload helper
 *   sync-v7-coalesce.ts          hot-window coalescing
 *   sync-v7-checkpoint-bridge.ts checkpoint <-> projection conversion
 *   sync-v7-download.ts          remote hot-window download
 *   sync-v7-orchestrator.ts      main sync flow
 *   sync-v7-tools.ts             diagnostics / migration tools
 */

export type { SyncProgress, SyncProgressCallback, SyncWithGitHubOptions } from "./sync-v7-context";
export { SYNC_V7_DOWNLOAD_CONCURRENCY } from "./sync-v7-context";

export type { RemoteCacheV7 } from "./sync-v7-cache";

export {
  SYNC_V7_DEVICE_RETIRE_DAYS,
  reclaimableTombstonesV7,
  installFingerprint,
  projectionNeedsInstall,
} from "./sync-v7-watermark";

export { replayRemoteResilient } from "./sync-v7-checkpoint-bridge";

export { downloadRemoteV7 } from "./sync-v7-download";

export {
  syncWithGitHub,
  restoreFullHistoryFromGitHub,
  restoreFromGitHub,
  pullFromGitHub,
  initializeGitHubVault,
  loadAttemptHistory,
} from "./sync-v7-orchestrator";

export {
  getGitHubLogin,
  getLastRemoteCache,
  getSyncHotWindowState,
  restoreLastRemoteCache,
  verifyGitHubVault,
  getSyncStats,
  migrateVaultToCompressed,
  backfillVaultStoredSizes,
} from "./sync-v7-tools";
export type {
  SyncHotWindowState,
  MigrateVaultResult,
  BackfillStoredSizeResult,
} from "./sync-v7-tools";

export type { ChangeSetQueueRecordV7 } from "../db/db-v7";
