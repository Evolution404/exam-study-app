import { dbV7, listChangeSetsV7 } from "../db/db-v7";
import type { GitHubSettings } from "../../types/types";
import type { TombstoneV7 } from "../db/v7-types";
import type { GitHubV7Remote, SyncV7HeadCache } from "./github-v7-remote";
import { saveHeadCache } from "./sync-v7-cache";
import type { SyncHeadV7, SyncV7DeviceWatermark } from "./sync-v7-head-types";

/** A device that has not reported a watermark for this long stops blocking
 *  tombstone GC (Riak-style reaping): a phone lost for 90+ days must not pin
 *  every tombstone forever. Its un-pulled deletions simply win — the same
 *  resolution rule the compareClock tie-break already applies elsewhere. */
export const SYNC_V7_DEVICE_RETIRE_DAYS = 90;

/** Causally-stable tombstone GC (Yorkie minVersionVector / Riak reaping):
 *  a tombstone is reclaimable once every non-retired known device has reported
 *  a watermark for the deleting device at or beyond the tombstone's deletion
 *  sequence. A pending change-set referencing entity X can only be created
 *  while X exists locally — before that device pulled the deletion — so once
 *  its watermark passes the deletion sequence it can no longer produce a
 *  resurrection. Devices that never reported stay conservative and block
 *  reclamation; the self device just performed the install and counts as
 *  confirmed. */
export function reclaimableTombstonesV7(
  tombstones: readonly TombstoneV7[],
  input: { devices: Record<string, SyncV7DeviceWatermark>; headCursors: Record<string, number>; selfDeviceId: string; now?: string },
): { keep: TombstoneV7[]; dropped: number } {
  const now = input.now ?? new Date().toISOString();
  const retireCutoff = Date.parse(now) - SYNC_V7_DEVICE_RETIRE_DAYS * 86_400_000;
  const decisionSet = [...new Set([...Object.keys(input.devices), ...Object.keys(input.headCursors)])].filter((device) => {
    if (device === input.selfDeviceId) return false;
    const watermark = input.devices[device];
    if (!watermark) return true; // never reported: unconfirmed (blocks reclamation)
    const syncedAt = Date.parse(watermark.syncedAt);
    return Number.isFinite(syncedAt) ? syncedAt >= retireCutoff : true; // invalid dates stay conservative and block reclamation
  });
  const keep: TombstoneV7[] = [];
  let dropped = 0;
  for (const tombstone of tombstones) {
    const confirmed = decisionSet.every((device) => (input.devices[device]?.cursors[tombstone.deviceId] ?? -1) >= tombstone.sequence);
    if (confirmed) dropped += 1;
    else keep.push(tombstone);
  }
  return { keep, dropped };
}

/** Best-effort device watermark publish (H2): report this device's installed
 *  cursors on the head so tombstone GC can prove causal stability. Writes
 *  only when the watermark actually advanced (idle syncs stay zero-write); a
 *  CAS conflict skips silently — the next sync republishes. */
export async function publishDeviceWatermark(client: GitHubV7Remote, settings: GitHubSettings, deviceId: string, cursors: Record<string, number>): Promise<void> {
  const read = await client.readHead();
  if (!read.initialized) return;
  const previous = read.head.devices?.[deviceId];
  const advanced = Object.entries(cursors).some(([device, sequence]) => sequence > (previous?.cursors[device] ?? -1));
  if (!advanced) return;
  const nextHead: SyncHeadV7 = { ...read.head, devices: { ...(read.head.devices ?? {}), [deviceId]: { cursors, syncedAt: new Date().toISOString() } } };
  const result = await client.putHead(nextHead, read.cache); // conflict → throw → caller swallows
  if (result.ok) await saveHeadCache(settings, { head: nextHead, ...(result.etag ? { etag: result.etag } : {}), ...(result.blobSha ? { blobSha: result.blobSha } : {}) }); // 让本地缓存 head 带上水位（面板「上次同步/设备」据此展示）
}

/** Content fingerprint of what the installed projection covers: the checkpoint
 *  identity plus the per-device cursor watermark at install time. Deliberately
 *  excludes head.generatedAt and segment digests — a coalesce re-pack or a peer's
 *  timestamp bump does not change the installed tables, so it must not trigger a
 *  full re-install. */
export function installFingerprint(cache: SyncV7HeadCache): string {
  const head = cache.head;
  const cursors = Object.keys(head.cursors).sort().map((device) => `${device}=${head.cursors[device]}`).join(",");
  return `${head.checkpoint?.sha256 ?? "none"}:${cursors}`;
}

/** Pure install decision (unit-testable): reinstall only when the checkpoint
 *  identity or cursor watermark moved, or when there are unseen remote changes /
 *  blocked rebase outcomes that must be persisted. */
export function projectionNeedsInstall(installedFingerprint: string | undefined, cache: SyncV7HeadCache, unseenCount: number, blockedCount: number): boolean {
  return installedFingerprint !== installFingerprint(cache) || unseenCount > 0 || blockedCount > 0;
}

/** Keep at most this many committed change-sets for the "已同步" history. */
const SYNC_V7_COMMITTED_KEEP_RECENT = 500;

/**
 * Garbage-collect committed change-sets whose `localSequence` has been absorbed
 * by the installed cursor watermark, keeping only the most recent `keepRecent`
 * for the sync-drawer history. Unabsorbed committed records are always kept.
 */
export async function pruneCommittedChangeSets(cursors: Record<string, number>, keepRecent = SYNC_V7_COMMITTED_KEEP_RECENT): Promise<void> {
  const committed = await listChangeSetsV7(["committed"]);
  const absorbed = committed.filter((record) => (cursors[record.deviceId] ?? 0) >= record.localSequence);
  if (absorbed.length <= keepRecent) return;
  const excess = absorbed
    .sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? "") || b.localSequence - a.localSequence || b.id.localeCompare(a.id))
    .slice(keepRecent);
  if (excess.length) await dbV7.changeSets.bulkDelete(excess.map((record) => record.id));
}
