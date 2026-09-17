/**
 * Domain synchronization engine for the current remote wire protocol.
 *
 * Keep this boundary intentionally narrow. Lower-level sync modules and tests
 * should import implementation helpers directly instead of expanding this
 * facade with convenience exports.
 */

export type { SyncProgress, SyncProgressCallback } from "./sync-context";
export { SYNC_DOWNLOAD_CONCURRENCY } from "./sync-context";

export {
  SYNC_DEVICE_RETIRE_DAYS,
  reclaimableTombstones,
  installFingerprint,
  projectionNeedsInstall,
} from "./sync-watermark";

export { replayRemoteResilient } from "./sync-checkpoint-bridge";
export { downloadRemote } from "./sync-download";

export {
  syncWithGitHub,
  restoreFullHistoryFromGitHub,
  restoreFromGitHub,
  pullFromGitHub,
} from "./sync-orchestrator";

export {
  getGitHubLogin,
  getLastRemoteCache,
  getSyncHotWindowState,
  restoreLastRemoteCache,
} from "./sync-tools";
export type { SyncHotWindowState } from "./sync-tools";
