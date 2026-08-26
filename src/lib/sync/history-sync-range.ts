import type { GitHubSettings } from "../../types/types";
import { recomputeChangeSetProjectionV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import type { ChangeSetV7 } from "./change-set-v7-types";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeHistorySyncStart(value: unknown): string | undefined {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? undefined : value;
}

export function historySyncStartFor(settings: Pick<GitHubSettings, "historySyncStart">): string | undefined {
  return normalizeHistorySyncStart(settings.historySyncStart);
}

export function historyTimestampIncluded(timestamp: string, start?: string): boolean {
  return !start || timestamp.slice(0, 10) >= start;
}

/** Old, unsent history-only events are deliberately dropped when a device
 * narrows its range. Content edits and explicit deletes are never suppressed. */
export function changeSetOutsideHistoryRange(change: ChangeSetV7, start?: string): boolean {
  const normalized = normalizeHistorySyncStart(start);
  if (!normalized) return false;
  const timestamps = change.mutations.map((mutation): string | undefined => {
    if (mutation.kind === "attempt.create" || mutation.kind === "attempt.update") return mutation.attempt.createdAt;
    if (mutation.kind === "practice.answer.submitted" || mutation.kind === "practice.answer.updated") return mutation.attempt.createdAt;
    if (mutation.kind === "practice.run.saved" || mutation.kind === "practice.run.status.changed") return mutation.run.startedAt;
    return undefined;
  });
  return timestamps.length > 0 && timestamps.every((timestamp) => timestamp !== undefined && !historyTimestampIncluded(timestamp, normalized));
}

/**
 * Apply the device-local history window without touching content entities.
 * Active local runs are retained even when they started before the selected
 * date; their attempts stay with them so an in-flight session remains usable.
 */
export function filterProjectionHistoryV7(projection: ChangeSetProjectionV7, start?: string): ChangeSetProjectionV7 {
  const normalized = normalizeHistorySyncStart(start);
  if (!normalized) return recomputeChangeSetProjectionV7(projection);
  const practiceRuns = projection.practiceRuns.filter((run) => run.status === "in_progress" || historyTimestampIncluded(run.startedAt, normalized));
  const activeRunIds = new Set(practiceRuns.filter((run) => run.status === "in_progress").map((run) => run.id));
  const attempts = projection.attempts.filter((attempt) => activeRunIds.has(attempt.runId) || historyTimestampIncluded(attempt.createdAt, normalized));
  return recomputeChangeSetProjectionV7({ ...projection, attempts, practiceRuns });
}
