import { runActivityAt } from "../practice/practice-metrics";
import { dbV7 } from "./db-v7-core";
import type { PracticeRunActivityV7, PracticeRunV7 } from "./v7-types";

/** Device-local derived row; this table is deliberately excluded from sync/checkpoints. */
export function practiceRunActivityRowV7(run: PracticeRunV7): PracticeRunActivityV7 {
  return { runId: run.id, status: run.status, activityAt: runActivityAt(run) };
}

/** Internal: caller must include practiceRuns + practiceRunActivity in its transaction. */
export async function putPracticeRunInTx(run: PracticeRunV7): Promise<void> {
  await dbV7.practiceRuns.put(run);
  await dbV7.practiceRunActivity.put(practiceRunActivityRowV7(run));
}

/** Internal: caller must include practiceRuns + practiceRunActivity in its transaction. */
export async function bulkPutPracticeRunsInTx(runs: readonly PracticeRunV7[]): Promise<void> {
  if (!runs.length) return;
  await dbV7.practiceRuns.bulkPut([...runs]);
  await dbV7.practiceRunActivity.bulkPut(runs.map(practiceRunActivityRowV7));
}

/** Internal: caller must include practiceRuns + practiceRunActivity in its transaction. */
export async function deletePracticeRunInTx(runId: string): Promise<void> {
  await dbV7.practiceRuns.delete(runId);
  await dbV7.practiceRunActivity.delete(runId);
}

/** Internal: caller must include practiceRuns + practiceRunActivity in its transaction. */
export async function deletePracticeRunsInTx(runIds: readonly string[]): Promise<void> {
  if (!runIds.length) return;
  await dbV7.practiceRuns.bulkDelete([...runIds]);
  await dbV7.practiceRunActivity.bulkDelete([...runIds]);
}
