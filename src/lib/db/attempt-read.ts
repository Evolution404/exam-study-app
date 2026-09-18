import { studyDb } from "./db-core";
import type { Attempt } from "./types";

function uniqueQuestionIds(questionIds: readonly string[]): string[] {
  return [...new Set(questionIds.filter(Boolean))];
}

/**
 * Read only attempts for the requested questions inside one closed time window.
 * The compound index prevents unrelated questions in the same busy time window
 * from being materialized and filtered in JavaScript.
 */
export async function readAttemptsForQuestionIdsInWindow(
  questionIds: readonly string[],
  from: string,
  to: string,
): Promise<Attempt[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  const rows = await Promise.all(ids.map((questionId) => studyDb.attempts
    .where("[questionId+createdAt]")
    .between([questionId, from], [questionId, to], true, true)
    .toArray()));
  return rows.flat();
}
