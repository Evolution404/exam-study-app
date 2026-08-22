import { GitHubV7Remote } from "./github-v7-remote";
import type { SyncV7Descriptor } from "./sync-v7-head";
import type { GitHubSettings } from "../../types/types";
import { getGitHubTransport, resolveGitHubApiBaseUrl, type GitHubTransport } from "../../platform/github-transport";
import { sha256DigestHex } from "../crypto/sha256";
export { mapWithConcurrency } from "../async/bounded-concurrency";

export type SyncProgress = { phase: "prepare" | "download" | "merge" | "upload" | "compact" | "cache" | "history" | "complete"; label: string; percent: number; /** Planned end-of-phase percent — the UI creeps toward it while a step runs long. */ to?: number };
export type SyncProgressCallback = (progress: SyncProgress) => void;

/**
 * Phase percent bands for one sync run, laid out over 0–100 so the bar always
 * advances inside the phase that is actually doing the work.  The layout
 * adapts to whether a push is expected: a pull-only run stretches download /
 * merge / install instead of reserving an upload band it will never enter.
 */
export interface SyncBands { download: readonly [number, number]; merge: readonly [number, number]; install: readonly [number, number]; upload?: readonly [number, number]; cache: readonly [number, number]; }

export function syncBands(hasPush: boolean): SyncBands {
  return hasPush
    ? { download: [6, 34], merge: [34, 46], install: [46, 56], upload: [56, 92], cache: [92, 98] }
    : { download: [6, 50], merge: [50, 70], install: [70, 92], cache: [92, 98] };
}

export function bandPercent(band: readonly [number, number], fraction: number): number {
  return band[0] + (band[1] - band[0]) * Math.max(0, Math.min(1, fraction));
}

/**
 * Wrap a callback so a run's reported percent never moves backwards — a CAS
 * retry restarts the download/upload steps, and the bar should hold its
 * position (labels still update) instead of snapping back to the start.
 */
export function monotonicProgress(callback?: SyncProgressCallback): SyncProgressCallback | undefined {
  if (!callback) return undefined;
  let floor = 0;
  return (progress) => {
    const percent = Math.max(progress.percent, floor);
    floor = percent;
    callback({ ...progress, percent });
  };
}

// A protocol namespace change must never reuse a cached v7 head/checkpoint.
const CACHE_PREFIX = "v8:sync:";

export function report(callback: SyncProgressCallback | undefined, phase: SyncProgress["phase"], label: string, percent: number, to?: number): void {
  callback?.({ phase, label, percent: Math.max(0, Math.min(100, Math.round(percent))), ...(to !== undefined ? { to: Math.max(0, Math.min(100, Math.round(to))) } : {}) });
}

export function branch(settings: GitHubSettings): string { return settings.branch?.trim() || "main"; }
export function vaultId(settings: GitHubSettings): string { return `${settings.owner.toLocaleLowerCase("en-US")}/${settings.repo.toLocaleLowerCase("en-US")}@${branch(settings)}`; }
export function cacheKey(settings: GitHubSettings, suffix: string): string { return `${CACHE_PREFIX}${suffix}:${vaultId(settings)}`; }

/**
 * Optional injection seam for tests. `fetch` lets a test substitute a flaky or
 * fault-injecting fetch to exercise network-error / retry paths through the full
 * sync loop without touching the mock server. Production callers omit it.
 */
export type SyncWithGitHubOptions = { fetch?: typeof fetch; transport?: GitHubTransport };

export function remote(settings: GitHubSettings, token: string, fetchImpl?: SyncWithGitHubOptions["fetch"], transport = getGitHubTransport()): GitHubV7Remote {
  return new GitHubV7Remote({
    owner: settings.owner,
    repo: settings.repo,
    branch: branch(settings),
    token,
    apiBaseUrl: resolveGitHubApiBaseUrl(settings.apiBaseUrl, transport),
    vaultId: vaultId(settings),
    fetch: fetchImpl ?? transport.fetch,
  });
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return sha256DigestHex(bytes);
}

export function descriptorPath(prefix: string, digest: string): string { return `${prefix}${digest}.json`; }

export function descriptorEqual(a: SyncV7Descriptor, b: SyncV7Descriptor): boolean {
  return a.path === b.path && a.sha256 === b.sha256 && a.size === b.size;
}

/** Hot-window segments download concurrently (bounded): results are collected
 *  by original index, so the replay order below stays the generation/ordinal
 *  wire order regardless of completion order. */
export const SYNC_V7_DOWNLOAD_CONCURRENCY = 6;

/** Per-device max localSequence over the given events — the true coverage
 *  watermark of a page, as opposed to the full head watermark. */
export function cursorsFor(changes: ReadonlyArray<{ deviceId: string; localSequence: number }>): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const change of changes) cursors[change.deviceId] = Math.max(cursors[change.deviceId] ?? 0, change.localSequence);
  return cursors;
}
