import { dbV7 } from "@/lib/db/db-v7";
import { listQuestionViewsForBankV7 } from "@/lib/db/app-data-v7";
import { listPracticeRunsForBankV7 } from "@/lib/db/practice-run-read-v7";
import { normalizeProgressScope, progressScopeCutoff, type ProgressScope } from "@/lib/practice/progress-scope";
import { toQuestionViewModel } from "@/app/bank/question-editor";
import { bankTitle, type Bank } from "./bank-library-shared";

export async function readBankDetailDatasetV7(
  bank: Bank,
  scope: ProgressScope = { type: "rolling", days: 90 },
  referenceTime = Date.now(),
  activityWindow?: { from: string; to: string },
) {
  const views = await listQuestionViewsForBankV7(bank.id);
  const questions = views.map((view) => toQuestionViewModel(view.question, bank.id, bankTitle(bank), view.memberships[0]?.sortOrder ?? 0));
  const questionIds = questions.map((question) => question.id);
  const questionIdSet = new Set(questionIds);
  const normalizedScope = normalizeProgressScope(scope);
  const rollingAttempts = normalizedScope.type === "rolling" && questionIds.length
    ? dbV7.attempts.where("createdAt").between(
        new Date(progressScopeCutoff(normalizedScope, referenceTime)!).toISOString(),
        new Date(referenceTime).toISOString(),
        true,
        true,
      ).toArray().then((rows) => rows.filter((row) => questionIdSet.has(row.questionId)))
    : Promise.resolve([]);
  const roundRows = normalizedScope.type === "round" && questionIds.length
    ? dbV7.reviewRoundProgress.where("roundId").equals(normalizedScope.roundId).toArray()
      .then((rows) => rows.filter((row) => questionIdSet.has(row.questionId)))
    : Promise.resolve([]);
  const dailyRows = activityWindow && questionIds.length
    ? dbV7.attemptDailyStats.where("date").between(activityWindow.from, activityWindow.to, true, true).toArray()
      .then((rows) => rows.filter((row) => questionIdSet.has(row.questionId)))
    : Promise.resolve([]);
  const [rawStats, attempts, notes, runs, runStats, roundProgress, activityDailyStats] = await Promise.all([
    dbV7.attemptStats.bulkGet(questionIds),
    rollingAttempts,
    dbV7.notes.bulkGet(questionIds),
    listPracticeRunsForBankV7(bank.id),
    dbV7.practiceRunStats.get(bank.id),
    roundRows,
    dailyRows,
  ]);
  return {
    questions,
    lifetimeAttemptStats: rawStats.filter((stats) => stats !== undefined).map((stats) => ({ ...stats, bankId: bank.id })),
    attempts,
    notes: notes.flatMap((note) => note?.content.trim() ? [note] : []),
    runs,
    runStats,
    roundProgress,
    activityDailyStats,
  };
}
