import { dbV7 } from "@/lib/db/db-v7";
import type { AttemptStatsV7 } from "@/lib/db/v7-types";
import { normalizeProgressScope, progressScopeCutoff, type ProgressScope } from "@/lib/practice/progress-scope";

export function summarizeDashboardLifetimeStatsV7(attemptStats: readonly AttemptStatsV7[]) {
  let attempts = 0;
  let correct = 0;
  let lastAttemptAt: string | undefined;
  for (const row of attemptStats) {
    attempts += row.total;
    correct += row.correct;
    if (!lastAttemptAt || row.latestAttemptAt > lastAttemptAt) lastAttemptAt = row.latestAttemptAt;
  }
  return { attempts, correct, lastAttemptAt };
}

export async function readDashboardScopedRowsV7(
  questionIds: readonly string[],
  scope: ProgressScope,
  referenceTime: number,
  options: { allQuestions: boolean },
) {
  const ids = [...new Set(questionIds.filter(Boolean))];
  if (!ids.length) return { attempts: [], attemptStats: [], roundProgress: [], notes: [] };
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
      attemptStats: [],
      roundProgress: options.allQuestions ? roundRows : roundRows.filter((row) => idSet.has(row.questionId)),
      notes,
    };
  }

  if (normalized.type === "lifetime") {
    const [attemptStatsRows, notes] = await Promise.all([
      dbV7.questionProgress.bulkGet(ids),
      notesPromise,
    ]);
    return {
      attempts: [],
      attemptStats: attemptStatsRows.filter((row): row is AttemptStatsV7 => row !== undefined),
      roundProgress: [],
      notes,
    };
  }

  const attemptsPromise = dbV7.attempts.where("createdAt").between(
    new Date(progressScopeCutoff(normalized, referenceTime)!).toISOString(),
    new Date(referenceTime).toISOString(),
    true,
    true,
  ).toArray().then((rows) => options.allQuestions ? rows : rows.filter((row) => idSet.has(row.questionId)));
  const [attempts, notes] = await Promise.all([attemptsPromise, notesPromise]);
  return { attempts, attemptStats: [], roundProgress: [], notes };
}
