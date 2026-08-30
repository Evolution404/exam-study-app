import { dbV7, listChangeSetsV7 } from "../db/db-v7";
import type { GitHubSettings } from "../../types/types";
import { bandPercent, monotonicProgress, remote, report, type SyncProgressCallback, type SyncWithGitHubOptions } from "./sync-v7-context";
import { saveHeadCache, saveInstalledCursors, saveInstalledHead, saveRemoteCache } from "./sync-v7-cache";
import { downloadRemoteV7 } from "./sync-v7-download";
import { checkpointFromProjection, installProjection, projectionFromCheckpoint, replayInWireOrder, saveQueueBase } from "./sync-v7-checkpoint-bridge";
import { withSyncLock } from "./sync-lock";
import { installFingerprint, pruneCommittedChangeSets } from "./sync-v7-watermark";

/**
 * Destructive recovery entry point. Full restore intentionally ignores the
 * device-local history window and installs all remote runs/attempts. Keep the
 * local-unsynced guard and install queue guard in the same locked transaction.
 */
export async function restoreFullHistoryFromGitHub(
  settings: GitHubSettings,
  token: string,
  callback?: SyncProgressCallback,
  options?: SyncWithGitHubOptions,
) {
  return withSyncLock(async () => {
    const client = remote(settings, token, options?.fetch, options?.transport);
    const read = await client.readHead();
    if (!read.initialized) throw new Error("远端还没有 v9 数据。");

    // Restore wipes the whole local change-set queue. Never silently discard
    // unsynced local edits; the same snapshot is checked again in the install
    // transaction for edits that arrive while remote history is downloading.
    const queueSnapshot = await listChangeSetsV7();
    const unsynced = queueSnapshot.filter((record) => record.state === "pending" || record.state === "blocked" || record.state === "claimed");
    if (unsynced.length) throw new Error(`还有 ${unsynced.length} 组未同步的本地更改，请先同步或处理后再恢复远程历史。`);

    const bands = { download: [6, 55] as const, merge: [55, 75] as const, install: [75, 92] as const, cache: [92, 98] as const };
    const progress = monotonicProgress(callback);
    report(progress, "download", "正在从远端抓取完整 v9 数据", bandPercent(bands.download, 0.02), bands.download[1]);
    // Explicit remote full restore deliberately ignores historySyncStart.
    const downloaded = await downloadRemoteV7(
      client,
      read.head,
      undefined,
      (fraction, label) => report(progress, "download", label, bandPercent(bands.download, fraction), bands.download[1]),
      {},
    );
    const projection = replayInWireOrder(
      await projectionFromCheckpoint(downloaded.checkpoint),
      downloaded.changes,
      (done, total) => report(progress, "merge", `正在回放远端变更（${done}/${total}）`, bandPercent(bands.merge, total ? done / total : 1), bands.merge[1]),
    );
    report(progress, "merge", `正在比较本机数据（远端 ${projection.questions.length.toLocaleString("zh-CN")} 道题、${projection.attempts.length.toLocaleString("zh-CN")} 条作答）`, bandPercent(bands.install, 0.02), bands.install[1]);

    const installed = await installProjection(projection, {
      queueGuard: queueSnapshot,
      clearChangeSets: true,
      onProgress: ({ completed, total, label }) => {
        const fraction = total ? completed / total : 1;
        report(progress, "merge", `${label}（${completed.toLocaleString("zh-CN")}/${total.toLocaleString("zh-CN")}）`, bandPercent(bands.install, fraction), bands.install[1]);
      },
    });
    if (!installed) throw new Error("恢复期间检测到新的本地更改，请先同步或处理后再重试。");

    report(progress, "cache", "正在更新本机同步状态", bandPercent(bands.cache, 0.4), bands.cache[1]);
    await dbV7.changeSets.bulkPut(downloaded.changes.map((change) => ({ ...change, state: "committed" as const, committedAt: new Date().toISOString() })));
    await saveHeadCache(settings, read.cache);
    // `projection` is the exact state that was just installed. Building the
    // folded local cache from it avoids immediately reading every projection
    // store back through IndexedDB (`createSyncCheckpointV7` used to do a full
    // toArray + clone pass here after the write had already completed).
    const checkpoint = await checkpointFromProjection(projection, read.head.cursors);
    await saveRemoteCache({ ...settings, historySyncStart: undefined }, checkpoint, read.cache);
    await saveQueueBase(projection);
    await saveInstalledHead(settings, installFingerprint(read.cache));
    await saveInstalledCursors(settings, read.head.cursors);
    await pruneCommittedChangeSets(read.head.cursors);
    report(callback, "complete", "v9 远端恢复完成", 100);

    return {
      pulled: downloaded.changes.length,
      formatVersion: 9 as const,
      counts: checkpoint.counts,
      deferred: 0,
      cachedAt: new Date().toISOString(),
      archivedAttempts: downloaded.archivedAttempts,
      archivedPracticeRuns: downloaded.archivedPracticeRuns,
      skippedArchivedAttempts: downloaded.skippedArchivedAttempts,
      skippedArchivedPracticeRuns: downloaded.skippedArchivedPracticeRuns,
      historySyncStart: undefined,
    };
  });
}
