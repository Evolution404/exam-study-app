import type { Attempt, PracticeRunItem, PracticeRunRecord, PracticeRunSource } from "../db/types";
import { historyTimestampIncluded, normalizeHistorySyncStart } from "./history-sync-range";
import type { SyncCheckpointCounts, SyncCheckpointState } from "./sync-checkpoint-types";

export interface PracticeRunHistoryFacts {
  practiceRuns: PracticeRunRecord[];
  practiceRunSources: PracticeRunSource[];
  practiceRunItems: PracticeRunItem[];
}

export function countsForHistoryState(
  state: SyncCheckpointState,
  totals: { attempts: number; practiceRuns: number } = { attempts: state.attempts.length, practiceRuns: state.practiceRuns.length },
): SyncCheckpointCounts {
  return {
    banks: state.banks.length,
    bankFolders: state.bankFolders.length,
    questions: state.questions.length,
    memberships: state.memberships.length,
    imageAssets: state.imageAssets.length,
    attempts: state.attempts.length,
    notes: state.notes.length,
    practiceRuns: state.practiceRuns.length,
    practiceRunSources: state.practiceRunSources.length,
    practiceRunItems: state.practiceRunItems.length,
    questionGroups: state.questionGroups.length,
    questionGroupItems: state.questionGroupItems.length,
    reviewRounds: state.reviewRounds.length,
    reviewRoundBanks: state.reviewRoundBanks.length,
    reviewRoundItems: state.reviewRoundItems.length,
    tombstones: state.tombstones.length,
    totalAttempts: totals.attempts,
    totalPracticeRuns: totals.practiceRuns,
  };
}

export function cloneHistoryBaseState(full: SyncCheckpointState): Omit<SyncCheckpointState, "attempts" | "practiceRuns" | "practiceRunSources" | "practiceRunItems"> {
  return {
    banks: structuredClone(full.banks),
    bankFolders: structuredClone(full.bankFolders),
    questions: structuredClone(full.questions),
    memberships: structuredClone(full.memberships),
    imageAssets: structuredClone(full.imageAssets),
    notes: structuredClone(full.notes),
    questionGroups: structuredClone(full.questionGroups),
    questionGroupItems: structuredClone(full.questionGroupItems),
    reviewRounds: structuredClone(full.reviewRounds),
    reviewRoundBanks: structuredClone(full.reviewRoundBanks),
    reviewRoundItems: structuredClone(full.reviewRoundItems),
    tombstones: structuredClone(full.tombstones),
  };
}

export function chronologicalHistoryAttempts(items: readonly Attempt[]): Attempt[] {
  return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function chronologicalHistoryRuns(items: readonly PracticeRunRecord[]): PracticeRunRecord[] {
  return [...items].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

/**
 * Produce the recent checkpoint seed while preserving canonical referential
 * closure. A retained attempt requires its run; a retained run requires every
 * submitted attempt referenced by its run-item facts.
 */
export function boundedCanonicalHistoryState(
  full: SyncCheckpointState,
  recentAttemptLimit: number,
  recentPracticeRunLimit: number,
): { state: SyncCheckpointState; archivedAttempts: Attempt[]; archivedPracticeRuns: PracticeRunRecord[] } {
  const attempts = chronologicalHistoryAttempts(full.attempts);
  const runs = chronologicalHistoryRuns(full.practiceRuns);
  const recentAttemptIds = new Set(attempts.slice(Math.max(0, attempts.length - recentAttemptLimit)).map((item) => item.id));
  const recentRunIds = new Set(runs.slice(Math.max(0, runs.length - recentPracticeRunLimit)).map((item) => item.id));
  const attemptById = new Map(attempts.map((item) => [item.id, item]));

  for (const attempt of attempts) if (recentAttemptIds.has(attempt.id)) recentRunIds.add(attempt.runId);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of full.practiceRunItems) {
      if (!recentRunIds.has(item.runId) || !item.submittedAttemptId || recentAttemptIds.has(item.submittedAttemptId)) continue;
      if (!attemptById.has(item.submittedAttemptId)) continue;
      recentAttemptIds.add(item.submittedAttemptId);
      expanded = true;
    }
    for (const attempt of attempts) {
      if (recentAttemptIds.has(attempt.id) && !recentRunIds.has(attempt.runId)) {
        recentRunIds.add(attempt.runId);
        expanded = true;
      }
    }
  }

  const recentAttempts = attempts.filter((item) => recentAttemptIds.has(item.id));
  const recentRuns = runs.filter((item) => recentRunIds.has(item.id));
  const state: SyncCheckpointState = {
    ...cloneHistoryBaseState(full),
    attempts: structuredClone(recentAttempts),
    practiceRuns: structuredClone(recentRuns),
    practiceRunSources: structuredClone(full.practiceRunSources.filter((item) => recentRunIds.has(item.runId))),
    practiceRunItems: structuredClone(full.practiceRunItems.filter((item) => recentRunIds.has(item.runId))),
  };
  return {
    state,
    archivedAttempts: attempts.filter((item) => !recentAttemptIds.has(item.id)),
    archivedPracticeRuns: runs.filter((item) => !recentRunIds.has(item.id)),
  };
}

export function mergeCanonicalHistoryState(
  bounded: SyncCheckpointState,
  archivedAttempts: readonly Attempt[],
  archivedRuns: PracticeRunHistoryFacts,
): SyncCheckpointState {
  const attemptMap = new Map([...archivedAttempts, ...bounded.attempts].map((item) => [item.id, item]));
  const runMap = new Map([...archivedRuns.practiceRuns, ...bounded.practiceRuns].map((item) => [item.id, item]));
  const sourceMap = new Map([...archivedRuns.practiceRunSources, ...bounded.practiceRunSources].map((item) => [`${item.runId}:${item.bankId}`, item]));
  const itemMap = new Map([...archivedRuns.practiceRunItems, ...bounded.practiceRunItems].map((item) => [`${item.runId}:${item.questionId}`, item]));
  return {
    ...cloneHistoryBaseState(bounded),
    attempts: chronologicalHistoryAttempts([...attemptMap.values()]),
    practiceRuns: chronologicalHistoryRuns([...runMap.values()]),
    practiceRunSources: [...sourceMap.values()],
    practiceRunItems: [...itemMap.values()],
  };
}

/**
 * Apply the device history window to canonical facts while keeping the graph
 * closed. An attempt retained by date brings in its run record; retained run
 * items bring in their submitted Attempt facts.
 */
export function filterCanonicalHistoryState(state: SyncCheckpointState, historySyncStart?: string): SyncCheckpointState {
  const start = normalizeHistorySyncStart(historySyncStart);
  if (!start) return state;
  const runById = new Map(state.practiceRuns.map((run) => [run.id, run]));
  const attemptById = new Map(state.attempts.map((attempt) => [attempt.id, attempt]));
  const keptRunIds = new Set(state.practiceRuns
    .filter((run) => run.status === "in_progress" || historyTimestampIncluded(run.startedAt, start))
    .map((run) => run.id));
  const keptAttemptIds = new Set(state.attempts
    .filter((attempt) => keptRunIds.has(attempt.runId) || historyTimestampIncluded(attempt.createdAt, start))
    .map((attempt) => attempt.id));

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const attemptId of keptAttemptIds) {
      const runId = attemptById.get(attemptId)?.runId;
      if (runId && runById.has(runId) && !keptRunIds.has(runId)) {
        keptRunIds.add(runId);
        expanded = true;
      }
    }
    for (const item of state.practiceRunItems) {
      if (!keptRunIds.has(item.runId) || !item.submittedAttemptId || keptAttemptIds.has(item.submittedAttemptId)) continue;
      if (!attemptById.has(item.submittedAttemptId)) continue;
      keptAttemptIds.add(item.submittedAttemptId);
      expanded = true;
    }
  }

  return {
    ...cloneHistoryBaseState(state),
    attempts: chronologicalHistoryAttempts(state.attempts.filter((attempt) => keptAttemptIds.has(attempt.id))),
    practiceRuns: chronologicalHistoryRuns(state.practiceRuns.filter((run) => keptRunIds.has(run.id))),
    practiceRunSources: state.practiceRunSources.filter((source) => keptRunIds.has(source.runId)),
    practiceRunItems: state.practiceRunItems.filter((item) => keptRunIds.has(item.runId)),
  };
}