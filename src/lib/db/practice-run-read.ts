import Dexie from "dexie";
import { studyDb } from "./db-core";
import type { PracticeRun } from "./types";
import { hydratePracticeRunRecords } from "./practice-run-store";

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Read only runs associated with one bank through normalized source rows. */
export async function listPracticeRunsForBank(bankId: string): Promise<PracticeRun[]> {
  if (!bankId) return [];
  const sources = await studyDb.practiceRunSources.where("bankId").equals(bankId).toArray();
  const records = sources.length ? await studyDb.practiceRuns.bulkGet(sources.map((source) => source.runId)) : [];
  return hydratePracticeRunRecords(records.filter((record): record is NonNullable<typeof record> => Boolean(record)));
}

/** Read only the newest visible runs for a bank without materializing its full history. */
export async function listRecentPracticeRunsForBank(bankId: string, limit: number): Promise<PracticeRun[]> {
  if (!bankId) return [];
  const safeLimit = Math.max(0, Math.floor(limit));
  if (!safeLimit) return [];
  const indexRows = await studyDb.bankPracticeRunIndex
    .where("[bankId+activityAt]")
    .between([bankId, Dexie.minKey], [bankId, Dexie.maxKey], true, true)
    .reverse()
    .limit(safeLimit)
    .toArray();
  if (!indexRows.length) return [];
  const records = await studyDb.practiceRuns.bulkGet(indexRows.map((row) => row.runId));
  return hydratePracticeRunRecords(records.filter((record): record is NonNullable<typeof record> => Boolean(record)));
}

/** Read only runs affected by one or more question ids through normalized item rows. */
export async function listPracticeRunsForQuestionIds(questionIds: readonly string[]): Promise<PracticeRun[]> {
  const ids = uniqueIds(questionIds);
  if (!ids.length) return [];
  const items = await studyDb.practiceRunItems.where("questionId").anyOf(ids).toArray();
  const runIds = [...new Set(items.map((item) => item.runId))];
  const records = runIds.length ? await studyDb.practiceRuns.bulkGet(runIds) : [];
  return hydratePracticeRunRecords(records.filter((record): record is NonNullable<typeof record> => Boolean(record)));
}

/** Read the newest active run directly from the compound status/time index. */
export async function latestInProgressPracticeRun(): Promise<PracticeRun | undefined> {
  const record = await studyDb.practiceRuns
    .where("[status+activityAt]")
    .between(["in_progress", Dexie.minKey], ["in_progress", Dexie.maxKey], true, true)
    .last();
  return record ? (await hydratePracticeRunRecords([record]))[0] : undefined;
}

export interface PracticeHistoryRead {
  runs: PracticeRun[];
  total: number;
  filteredTotal: number;
  counts: Record<PracticeRun["status"], number>;
}

/**
 * Read only the visible history page through the canonical run activityAt
 * index, without a second activity table or full-history materialization.
 */
export async function readPracticeHistory(status: "all" | PracticeRun["status"], limit: number): Promise<PracticeHistoryRead> {
  const safeLimit = Math.max(0, Math.floor(limit));
  const [total, inProgress, completed, abandoned] = await Promise.all([
    studyDb.practiceRuns.count(),
    studyDb.practiceRuns.where("status").equals("in_progress").count(),
    studyDb.practiceRuns.where("status").equals("completed").count(),
    studyDb.practiceRuns.where("status").equals("abandoned").count(),
  ]);
  const records = safeLimit === 0
    ? []
    : status === "all"
      ? await studyDb.practiceRuns.orderBy("activityAt").reverse().limit(safeLimit).toArray()
      : await studyDb.practiceRuns
        .where("[status+activityAt]")
        .between([status, Dexie.minKey], [status, Dexie.maxKey], true, true)
        .reverse()
        .limit(safeLimit)
        .toArray();
  const rows = await hydratePracticeRunRecords(records);
  const filteredTotal = status === "all" ? total : status === "in_progress" ? inProgress : status === "completed" ? completed : abandoned;
  return {
    runs: rows,
    total,
    filteredTotal,
    counts: { in_progress: inProgress, completed, abandoned },
  };
}
