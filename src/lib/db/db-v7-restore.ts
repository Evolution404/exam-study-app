/**
 * v7 atomic checkpoint restore.
 */
import { dbV7 } from "./db-v7-core";
import type { V7RestoreState } from "./db-v7-core";

export interface V7ChangeSetQueueGuard {
  id: string;
  digest: string;
  state: string;
  claimId?: string;
  claimedAt?: string;
}

export interface RestoreV7CheckpointOptions {
  /**
   * When present, projection replacement is performed only if the complete
   * queue still has exactly these rows.  The comparison happens in the same
   * read-write transaction as the replacement, so a new local edit either
   * wins before the restore (causing a safe no-op) or commits after it.
   */
  queueGuard?: readonly V7ChangeSetQueueGuard[];
  /** Clear the queue as part of the guarded projection replacement. */
  clearChangeSets?: boolean;
}

function queueRow(record: V7ChangeSetQueueGuard): string {
  return JSON.stringify([record.id, record.digest, record.state, record.claimId ?? null, record.claimedAt ?? null]);
}

function queueMatches(current: readonly V7ChangeSetQueueGuard[], expected: readonly V7ChangeSetQueueGuard[]): boolean {
  if (current.length !== expected.length) return false;
  const left = current.map(queueRow).sort();
  const right = expected.map(queueRow).sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Replace every v7 projection atomically.  The `events` store stays dormant
 * (Phase 3) and pending change-sets are deliberately left in place: callers
 * clear `changeSets` separately when a remote tail is being replayed.
 */
export async function restoreV7Checkpoint(state: V7RestoreState, options: RestoreV7CheckpointOptions = {}): Promise<boolean> {
  const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];
  const tables = [
    dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.imageAssets,
    dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.notes, dbV7.practiceRuns,
    dbV7.practiceRunStats, dbV7.questionGroups, dbV7.reviewRounds, dbV7.reviewRoundProgress,
    dbV7.tombstones,
  ];
  return dbV7.transaction("rw", [...tables, dbV7.changeSets], async () => {
    if (options.queueGuard) {
      const current = await dbV7.changeSets.toArray();
      if (!queueMatches(current, options.queueGuard)) return false;
    }
    // Read cache blobs under the same transaction as the descriptor replace;
    // otherwise a concurrent image write could be read before the transaction
    // and then silently discarded by the restore.
    const cachedAssets = await dbV7.imageAssets.toArray();
    const cachedBlobs = new Map(cachedAssets.filter((asset) => asset.blob).map((asset) => [asset.id, asset]));
    for (const table of tables) await table.clear();
    await dbV7.banks.bulkPut(state.banks);
    await dbV7.bankFolders.bulkPut(state.bankFolders);
    await dbV7.questions.bulkPut(state.questions);
    await dbV7.bankQuestionMemberships.bulkPut(memberships);
    await dbV7.imageAssets.bulkPut(state.imageAssets.map((descriptor) => {
      const cached = cachedBlobs.get(descriptor.id);
      return cached?.blob && cached.size === descriptor.size ? { ...descriptor, blob: cached.blob } : descriptor;
    }));
    await dbV7.attempts.bulkPut(state.attempts);
    await dbV7.attemptStats.bulkPut(state.attemptStats);
    await dbV7.attemptDailyStats.bulkPut(state.attemptDailyStats);
    await dbV7.notes.bulkPut(state.notes);
    await dbV7.practiceRuns.bulkPut(state.practiceRuns);
    await dbV7.practiceRunStats.bulkPut(state.practiceRunStats);
    await dbV7.questionGroups.bulkPut(state.questionGroups);
    await dbV7.reviewRounds.bulkPut(state.reviewRounds);
    await dbV7.reviewRoundProgress.bulkPut(state.reviewRoundProgress);
    await dbV7.tombstones.bulkPut(state.tombstones);
    if (options.clearChangeSets) await dbV7.changeSets.clear();
    return true;
  });
}
