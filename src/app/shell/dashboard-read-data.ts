import { dbV7 } from "@/lib/db/db-v7";
import { normalizeProgressScope, progressScopeCutoff, type ProgressScope } from "@/lib/practice/progress-scope";

export async function readDashboardScopedRowsV7(
  questionIds: readonly string[],
  scope: ProgressScope,
  referenceTime: number,
  options: { allQuestions: boolean },
) {
  const ids = [...new Set(questionIds.filter(Boolean))];
  if (!ids.length) return { attempts: [], roundProgress: [], notes: [] };
  const normalized = normalizeProgressScope(scope);
  const idSet = new Set(ids);

  const notesPromise = options.allQuestions
    ? dbV7.notes.toArray()
    : dbV7.notes.bulkGet(ids).then((rows) => rows.filter((row) => row !== undefined));

  if (normalized.type === "round") {
    const [roundRows, notes] = await Promise.all([
      dbV7.reviewRoundProgress.where("roundId").equals(normalized.roundId).toArray(),
      notesPromise,
    ]);
    return {
      attempts: [],
      roundProgress: options.allQuestions ? roundRows : roundRows.filter((row) => idSet.has(row.questionId)),
      notes,
    };
  }

  const attemptsPromise = options.allQuestions
    ? normalized.type === "rolling"
      ? dbV7.attempts.where("createdAt").between(
          new Date(progressScopeCutoff(normalized, referenceTime)!).toISOString(),
          new Date(referenceTime).toISOString(),
          true,
          true,
        ).toArray()
      : dbV7.attempts.toArray()
    : dbV7.attempts.where("questionId").anyOf(ids).toArray();
  const [attempts, notes] = await Promise.all([attemptsPromise, notesPromise]);
  return { attempts, roundProgress: [], notes };
}
