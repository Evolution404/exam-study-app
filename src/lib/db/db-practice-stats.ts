import { studyDb, uniqueStrings } from "./db-core";
import { runActivityAt } from "../practice/practice-metrics";
import type { BankPracticeStats, PracticeRun } from "./types";

/** internal：练习 run 的题库归属，按 bankIds 优先回退到 bankId。 */
function runBankIds(run: Pick<PracticeRun, "bankId" | "bankIds">): string[] {
  return uniqueStrings(run.bankIds?.length ? run.bankIds : [run.bankId]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function summarizeBankRuns(
  bankId: string,
  runs: readonly { status: PracticeRun["status"]; activityAt: string }[],
): BankPracticeStats | undefined {
  if (!runs.length) return undefined;
  const stats: BankPracticeStats = {
    bankId,
    total: 0,
    completed: 0,
    inProgress: 0,
    abandoned: 0,
    latestActivityAt: "",
  };
  for (const run of runs) {
    stats.total += 1;
    if (run.status === "completed") stats.completed += 1;
    else if (run.status === "abandoned") stats.abandoned += 1;
    else stats.inProgress += 1;
    if (run.activityAt > stats.latestActivityAt) stats.latestActivityAt = run.activityAt;
  }
  return stats;
}

/**
 * Maintain bankPracticeStats from canonical run facts.
 *
 * The old implementation used irreversible arithmetic and could not lower
 * latestActivityAt after deleting the newest run. Recompute only the affected
 * banks, overlaying the pending transition because callers may invoke this
 * before the run/source rows themselves are updated.
 */
export async function updatePracticeRunStatsInTx(previous: PracticeRun | undefined, next: PracticeRun | undefined): Promise<void> {
  const previousBankIds = previous ? runBankIds(previous) : [];
  const nextBankIds = next ? runBankIds(next) : [];
  if (
    previous
    && next
    && previous.status === next.status
    && runActivityAt(previous) === runActivityAt(next)
    && sameIds(previousBankIds, nextBankIds)
  ) return;

  const affectedBankIds = uniqueStrings([...previousBankIds, ...nextBankIds]);
  for (const bankId of affectedBankIds) {
    if (!bankId) continue;
    const sourceRows = await studyDb.practiceRunSources.where("bankId").equals(bankId).toArray();
    const runIds = uniqueStrings(sourceRows.map((row) => row.runId));
    const records = runIds.length ? await studyDb.practiceRuns.bulkGet(runIds) : [];
    const byId = new Map(
      records
        .filter((record) => record !== undefined)
        .map((record) => [record!.id, { status: record!.status, activityAt: record!.activityAt }]),
    );

    if (previous && previousBankIds.includes(bankId)) byId.delete(previous.id);
    if (next && nextBankIds.includes(bankId)) {
      byId.set(next.id, { status: next.status, activityAt: runActivityAt(next) });
    }

    const exact = summarizeBankRuns(bankId, [...byId.values()]);
    if (exact) await studyDb.bankPracticeStats.put(exact);
    else await studyDb.bankPracticeStats.delete(bankId);

    if (previous && previousBankIds.includes(bankId)) {
      await studyDb.bankPracticeRunIndex.delete([bankId, previous.id]);
    }
    if (next && nextBankIds.includes(bankId)) {
      await studyDb.bankPracticeRunIndex.put({
        bankId,
        runId: next.id,
        activityAt: runActivityAt(next),
        status: next.status,
      });
    }
  }
}
