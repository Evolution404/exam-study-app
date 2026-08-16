/**
 * v7 atomic checkpoint restore.
 */
import { dbV7 } from "./db-v7-core";
import type { V7RestoreState } from "./db-v7-core";

/**
 * Replace every v7 projection atomically.  The `events` store stays dormant
 * (Phase 3) and pending change-sets are deliberately left in place: callers
 * clear `changeSets` separately when a remote tail is being replayed.
 */
export async function restoreV7Checkpoint(state: V7RestoreState): Promise<void> {
  const cachedAssets = await dbV7.imageAssets.toArray();
  const cachedBlobs = new Map(cachedAssets.filter((asset) => asset.blob).map((asset) => [asset.id, asset]));
  const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];
  const tables = [
    dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.imageAssets,
    dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.notes, dbV7.practiceRuns,
    dbV7.practiceRunStats, dbV7.questionGroups, dbV7.reviewRounds, dbV7.reviewRoundProgress,
    dbV7.tombstones,
  ];
  await dbV7.transaction("rw", tables, async () => {
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
  });
}
