import type { GitHubSettings } from "../../types/types";
import type { CanonicalState } from "../db/types";
import { normalizeCanonicalStateForReplay } from "./change-set-projection";
import type { ChangeSet } from "./change-set-types";

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
export function changeSetOutsideHistoryRange(change: ChangeSet, start?: string): boolean {
  const normalized = normalizeHistorySyncStart(start);
  if (!normalized) return false;
  const timestamps = change.mutations.map((mutation): string | undefined => {
    if (mutation.kind === "attempt.create") return mutation.attempt.createdAt;
    if (mutation.kind === "practice.answer.submitted") return mutation.attempt.createdAt;
    if (mutation.kind === "practice.run.saved" || mutation.kind === "practice.run.status.changed") return mutation.record.startedAt;
    return undefined;
  });
  return timestamps.length > 0 && timestamps.every((timestamp) => timestamp !== undefined && !historyTimestampIncluded(timestamp, normalized));
}

/**
 * Apply the device-local history window without touching content entities.
 * Active local runs are retained even when they started before the selected
 * date; their canonical relation rows stay with the retained run.
 */
export function filterCanonicalHistory(state: CanonicalState, start?: string): CanonicalState {
  const normalized = normalizeHistorySyncStart(start);
  if (!normalized) return normalizeCanonicalStateForReplay(state);
  const practiceRuns = state.practiceRuns.filter((run) => run.status === "in_progress" || historyTimestampIncluded(run.startedAt, normalized));
  const runIds = new Set(practiceRuns.map((run) => run.id));
  const activeRunIds = new Set(practiceRuns.filter((run) => run.status === "in_progress").map((run) => run.id));
  const attempts = state.attempts.filter((attempt) => activeRunIds.has(attempt.runId) || historyTimestampIncluded(attempt.createdAt, normalized));
  return normalizeCanonicalStateForReplay({
    ...state,
    attempts,
    practiceRuns,
    practiceRunSources: state.practiceRunSources.filter((row) => runIds.has(row.runId)),
    practiceRunItems: state.practiceRunItems.filter((row) => runIds.has(row.runId)),
  });
}
