import { runActivityAt } from "../practice/practice-metrics";
import { dbV7 } from "./db-v7-core";
import type { PracticeRunV7 } from "./v7-types";

export type PersistedPracticeRunV7 = PracticeRunV7 & { activityAt: string };

/** Persist activity directly on the run; there is no second activity table. */
export function practiceRunWithActivityV7(run: PracticeRunV7): PersistedPracticeRunV7 {
  return { ...run, activityAt: runActivityAt(run) };
}

/** Internal: caller must include practiceRuns in its transaction. */
export async function putPracticeRunInTx(run: PracticeRunV7): Promise<void> {
  await dbV7.practiceRuns.put(practiceRunWithActivityV7(run));
}

/** Internal: caller must include practiceRuns in its transaction. */
export async function bulkPutPracticeRunsInTx(runs: readonly PracticeRunV7[]): Promise<void> {
  if (!runs.length) return;
  await dbV7.practiceRuns.bulkPut(runs.map(practiceRunWithActivityV7));
}

/** Internal: caller must include practiceRuns in its transaction. */
export async function deletePracticeRunInTx(runId: string): Promise<void> {
  await dbV7.practiceRuns.delete(runId);
}
