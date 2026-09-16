import { dbV7 } from "./db-v7-core";
import type { PracticeRunV7 } from "./v7-types";

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Read only runs associated with one bank through the v2 multiEntry index. */
export async function listPracticeRunsForBankV7(bankId: string): Promise<PracticeRunV7[]> {
  if (!bankId) return [];
  return dbV7.practiceRuns.where("bankIds").equals(bankId).toArray();
}

/** Read only runs affected by one or more question ids through the v2 index. */
export async function listPracticeRunsForQuestionIdsV7(questionIds: readonly string[]): Promise<PracticeRunV7[]> {
  const ids = uniqueIds(questionIds);
  if (!ids.length) return [];
  return dbV7.practiceRuns.where("questionIds").anyOf(ids).distinct().toArray();
}
