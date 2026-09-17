import type { GitHubRemote, SyncHeadCache } from "./github-remote";
import { SYNC_CHECKPOINT_PREFIX, SYNC_SEGMENT_PREFIX, type SyncHead } from "./sync-head-types";

export interface SyncGcResult {
  checkpointsDeleted: number;
  segmentsDeleted: number;
  skipped: number;
}

function addHeadPaths(head: SyncHead | null | undefined, checkpoints: Set<string>, segments: Set<string>): void {
  if (!head) return;
  if (head.checkpoint) checkpoints.add(head.checkpoint.path);
  for (const segment of head.segments) segments.add(segment.path);
}

async function deleteUnreachable(
  client: GitHubRemote,
  prefix: typeof SYNC_CHECKPOINT_PREFIX | typeof SYNC_SEGMENT_PREFIX,
  keep: ReadonlySet<string>,
): Promise<{ deleted: number; skipped: number }> {
  const entries = await client.listImmutableDirectory(prefix);
  let deleted = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (keep.has(entry.path)) continue;
    try {
      if (await client.deleteImmutablePath(entry.path, entry.blobSha)) deleted += 1;
      else skipped += 1;
    } catch {
      // Maintenance must never turn a durable sync into a reported failure.
      // A later successful head advance will retry the same unreachable path.
      skipped += 1;
    }
  }
  return { deleted, skipped };
}

/**
 * Best-effort post-CAS cleanup for immutable checkpoint/segment namespaces.
 *
 * Safety contract:
 * - `committed` is the head this caller successfully published.
 * - `previous` is the head it replaced.
 * - the remote head is re-read before deletion; if another device already
 *   advanced it, that newest head is added to the keep-set as well.
 * - checkpoint files are swept only when the caller actually changed the
 *   checkpoint, preserving exactly current + previous checkpoints in the
 *   uncontended case. Ordinary appends therefore cannot accidentally discard
 *   the previous recovery snapshot.
 * - segments keep the newest, committed and previous head references, giving a
 *   stale reader at least one head-generation grace window.
 */
export async function gcSyncRemote(
  client: GitHubRemote,
  previous: SyncHead,
  committed: SyncHeadCache,
  options: { checkpointChanged: boolean },
): Promise<SyncGcResult> {
  let latest: SyncHead | undefined;
  try {
    const read = await client.readHead();
    if (!read.initialized) return { checkpointsDeleted: 0, segmentsDeleted: 0, skipped: 0 };
    latest = read.head;
  } catch {
    return { checkpointsDeleted: 0, segmentsDeleted: 0, skipped: 1 };
  }

  // A vault mismatch should already be rejected by GitHubRemote.readHead;
  // keep this defensive check for injected/mocked transports.
  if (latest.vaultId !== committed.head.vaultId || previous.vaultId !== committed.head.vaultId) {
    return { checkpointsDeleted: 0, segmentsDeleted: 0, skipped: 1 };
  }

  const keepCheckpoints = new Set<string>();
  const keepSegments = new Set<string>();
  addHeadPaths(latest, keepCheckpoints, keepSegments);
  addHeadPaths(committed.head, keepCheckpoints, keepSegments);
  addHeadPaths(previous, keepCheckpoints, keepSegments);

  let checkpointsDeleted = 0;
  let segmentsDeleted = 0;
  let skipped = 0;

  if (options.checkpointChanged) {
    try {
      const result = await deleteUnreachable(client, SYNC_CHECKPOINT_PREFIX, keepCheckpoints);
      checkpointsDeleted += result.deleted;
      skipped += result.skipped;
    } catch {
      skipped += 1;
    }
  }

  try {
    const result = await deleteUnreachable(client, SYNC_SEGMENT_PREFIX, keepSegments);
    segmentsDeleted += result.deleted;
    skipped += result.skipped;
  } catch {
    skipped += 1;
  }

  return { checkpointsDeleted, segmentsDeleted, skipped };
}
