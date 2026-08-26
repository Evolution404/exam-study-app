import type { ChangeSetQueueRecordV7 } from "../db/db-v7";
import type { AttemptV7, PracticeRunV7 } from "../db/v7-types";
import type { ChangeSetV7 } from "./change-set-v7";
import type { ChangeSetProjectionV7 } from "./change-set-v7-projection";

export function formatTransferBytesV7(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function assetUploadProgressLabelV7(input: {
  completed: number;
  total: number;
  uploadedBytes: number;
  totalBytes: number;
  concurrency: number;
}): string {
  if (input.completed === 0) return `准备并发上传 ${input.total} 张图片（${input.concurrency} 路）`;
  const transferred = `${formatTransferBytesV7(input.uploadedBytes)} / ${formatTransferBytesV7(input.totalBytes)}`;
  return `正在上传图片（${input.completed}/${input.total}，${transferred}）`;
}

export function mergeActiveHistoryProjectionV7(
  projection: ChangeSetProjectionV7,
  activeRuns: readonly PracticeRunV7[],
  activeAttempts: readonly AttemptV7[],
): ChangeSetProjectionV7 {
  const runs = new Map(projection.practiceRuns.map((run) => [run.id, run]));
  for (const run of activeRuns) runs.set(run.id, run);
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  for (const attempt of activeAttempts) attempts.set(attempt.id, attempt);
  return { ...projection, practiceRuns: [...runs.values()], attempts: [...attempts.values()] };
}

export function reconcileInterruptedClaimsV7(
  records: readonly ChangeSetQueueRecordV7[],
  remoteChanges: readonly Pick<ChangeSetV7, "id" | "digest">[],
  remoteCursors: Readonly<Record<string, number>>,
  now: () => string = () => new Date().toISOString(),
): ChangeSetQueueRecordV7[] {
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
