import type { ChangeSetQueueRecord } from "../db/db";
import type { Attempt, PracticeRun } from "../db/types";
import type { ChangeSet } from "./change-set-types";
import type { ChangeSetProjection } from "./change-set-projection";

export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function assetUploadProgressLabel(input: {
  completed: number;
  total: number;
  uploadedBytes: number;
  totalBytes: number;
  concurrency: number;
}): string {
  if (input.completed === 0) return `准备并发上传 ${input.total} 张图片（${input.concurrency} 路）`;
  const transferred = `${formatTransferBytes(input.uploadedBytes)} / ${formatTransferBytes(input.totalBytes)}`;
  return `正在上传图片（${input.completed}/${input.total}，${transferred}）`;
}

export function mergeActiveHistoryProjection(
  projection: ChangeSetProjection,
  activeRuns: readonly PracticeRun[],
  activeAttempts: readonly Attempt[],
): ChangeSetProjection {
  const runs = new Map(projection.practiceRuns.map((run) => [run.id, run]));
  for (const run of activeRuns) runs.set(run.id, run);
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  for (const attempt of activeAttempts) attempts.set(attempt.id, attempt);
  return { ...projection, practiceRuns: [...runs.values()], attempts: [...attempts.values()] };
}

export function pendingQueueSnapshotChanged(
  snapshot: readonly Pick<ChangeSetQueueRecord, "id" | "digest">[],
  current: readonly Pick<ChangeSetQueueRecord, "id" | "digest">[],
): boolean {
  const currentById = new Map(current.map((record) => [record.id, record.digest] as const));
  return snapshot.some((record) => currentById.get(record.id) !== record.digest);
}

export function reconcileInterruptedClaims(
  records: readonly ChangeSetQueueRecord[],
  remoteChanges: readonly Pick<ChangeSet, "id" | "digest">[],
  remoteCursors: Readonly<Record<string, number>>,
  now: () => string = () => new Date().toISOString(),
): ChangeSetQueueRecord[] {
  const remoteById = new Map(remoteChanges.map((change) => [change.id, change]));
  return records.map((record) => {
    const remoteChange = remoteById.get(record.id);
    // A claimed record whose id exists remotely with another digest is a stale
    // locked version. Keep the conflict local and let unrelated remote data pull.
    if (remoteChange && remoteChange.digest !== record.digest) {
      return {
        ...record,
        state: "blocked",
        blockedReason: "远端已存在同 id 但内容不同的变更集，本地锁定版本已过期。",
        claimId: undefined,
        claimedAt: undefined,
      };
    }
    const coveredByRemote = Boolean(remoteChange) || (remoteCursors[record.deviceId] ?? 0) >= record.localSequence;
    return coveredByRemote
      ? { ...record, state: "committed", committedAt: now(), claimId: undefined, claimedAt: undefined }
      : { ...record, state: "pending", claimId: undefined, claimedAt: undefined };
  });
}
