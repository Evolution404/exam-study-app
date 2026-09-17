import Dexie from "dexie";
import { dbV7 } from "./db-v7-core";
import type { PracticeRunV7 } from "./v7-types";

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Read only runs associated with one bank through the current multiEntry index. */
export async function listPracticeRunsForBankV7(bankId: string): Promise<PracticeRunV7[]> {
  if (!bankId) return [];
  return dbV7.practiceRuns.where("bankIds").equals(bankId).toArray();
}

/** Read only the newest visible runs for a bank without materializing its full history. */
export async function listRecentPracticeRunsForBankV7(bankId: string, limit: number): Promise<PracticeRunV7[]> {
  if (!bankId) return [];
  const safeLimit = Math.max(0, Math.floor(limit));
  if (!safeLimit) return [];
  return dbV7.practiceRuns
    .orderBy("updatedAt")
    .reverse()
    .filter((run) => run.bankIds.includes(bankId))
    .limit(safeLimit)
    .toArray();
}

/** Read only runs affected by one or more question ids through the current multiEntry index. */
export async function listPracticeRunsForQuestionIdsV7(questionIds: readonly string[]): Promise<PracticeRunV7[]> {
  const ids = uniqueIds(questionIds);
  if (!ids.length) return [];
  return dbV7.practiceRuns.where("questionIds").anyOf(ids).distinct().toArray();
}

/** Read the newest active run directly from the compound status/time index. */
export async function latestInProgressPracticeRunV7(): Promise<PracticeRunV7 | undefined> {
  return dbV7.practiceRuns
    .where("[status+activityAt]")
    .between(["in_progress", Dexie.minKey], ["in_progress", Dexie.maxKey], true, true)
    .last();
}

export interface PracticeHistoryReadV7 {
  runs: PracticeRunV7[];
  total: number;
  filteredTotal: number;
  counts: Record<PracticeRunV7["status"], number>;
}

/**
 * Read only the visible history page through the canonical run activityAt
 * index, without a second activity table or full-history materialization.
 */
export async function readPracticeHistoryV7(status: "all" | PracticeRunV7["status"], limit: number): Promise<PracticeHistoryReadV7> {
  const safeLimit = Math.max(0, Math.floor(limit));
  const [total, inProgress, completed, abandoned] = await Promise.all([
    dbV7.practiceRuns.count(),
    dbV7.practiceRuns.where("status").equals("in_progress").count(),
    dbV7.practiceRuns.where("status").equals("completed").count(),
    dbV7.practiceRuns.where("status").equals("abandoned").count(),
  ]);
  const rows = safeLimit === 0
    ? []
    : status === "all"
      ? await dbV7.practiceRuns.orderBy("activityAt").reverse().limit(safeLimit).toArray()
      : await dbV7.practiceRuns
        .where("[status+activityAt]")
        .between([status, Dexie.minKey], [status, Dexie.maxKey], true, true)
        .reverse()
        .limit(safeLimit)
        .toArray();
  const filteredTotal = status === "all" ? total : status === "in_progress" ? inProgress : status === "completed" ? completed : abandoned;
  return {
    runs: rows,
    total,
    filteredTotal,
    counts: { in_progress: inProgress, completed, abandoned },
  };
}
