/**
 * v7 domain / v9 wire synchronization barrel.
 *
 * Keep this boundary intentionally narrow. Lower-level sync modules and tests
 * should import implementation helpers directly instead of expanding this
 * facade with compatibility aliases.
 */

export type { SyncProgress, SyncProgressCallback } from "./sync-v7-context";
export { SYNC_V7_DOWNLOAD_CONCURRENCY } from "./sync-v7-context";

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
} from "./sync-v7-orchestrator";

export {
  getGitHubLogin,
  getLastRemoteCache,
  getSyncHotWindowState,
  restoreLastRemoteCache,
} from "./sync-v7-tools";
export type { SyncHotWindowState } from "./sync-v7-tools";
