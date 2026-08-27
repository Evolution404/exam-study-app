import { dbV7 } from "./db-v7";
import type { NoteV7 } from "./v7-types";

function uniqueQuestionIds(questionIds: readonly string[]): string[] {
  return [...new Set(questionIds)];
}

/** Read only notes belonging to the current search question set. */
export async function readNotesForQuestionIdsV7(questionIds: readonly string[]): Promise<NoteV7[]> {
  const ids = uniqueQuestionIds(questionIds);
  if (!ids.length) return [];
  const rows = await dbV7.notes.bulkGet(ids);
  return rows.filter((row): row is NoteV7 => row !== undefined);
}
