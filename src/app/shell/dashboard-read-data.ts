import { studyDb } from "@/lib/db/db";
import { readAttemptsForQuestionIdsInWindow } from "@/lib/db/attempt-read";
import type { AttemptStats } from "@/lib/db/types";
import { normalizeProgressScope, progressScopeCutoff, type ProgressScope } from "@/lib/practice/progress-scope";

export function summarizeDashboardLifetimeStats(attemptStats: readonly AttemptStats[]) {
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

export async function readDashboardScopedRows(
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
    ? studyDb.notes.toArray()
    : studyDb.notes.bulkGet(ids).then((rows) => rows.filter((row) => row !== undefined));

  if (normalized.type === "round") {
    const [roundRows, notes] = await Promise.all([
      studyDb.reviewRoundProgress.where("roundId").equals(normalized.roundId).toArray(),
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
      studyDb.questionProgress.bulkGet(ids),
      notesPromise,
    ]);
    return {
      attempts: [],
      attemptStats: attemptStatsRows.filter((row): row is AttemptStats => row !== undefined),
      roundProgress: [],
      notes,
    };
  }

  const from = new Date(progressScopeCutoff(normalized, referenceTime)!).toISOString();
  const to = new Date(referenceTime).toISOString();
  const attemptsPromise = options.allQuestions
    ? studyDb.attempts.where("createdAt").between(from, to, true, true).toArray()
    : readAttemptsForQuestionIdsInWindow(ids, from, to);
  const [attempts, notes] = await Promise.all([attemptsPromise, notesPromise]);
  return { attempts, attemptStats: [], roundProgress: [], notes };
}
