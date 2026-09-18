import { studyDb } from "@/lib/db/db";
import { listQuestionViewsForBank } from "@/lib/db/app-data";
import { readAttemptsForQuestionIdsInWindow } from "@/lib/db/attempt-read";
import { listRecentPracticeRunsForBank } from "@/lib/db/practice-run-read";
import { normalizeProgressScope, progressScopeCutoff, type ProgressScope } from "@/lib/practice/progress-scope";
import { toQuestionViewModel } from "@/app/bank/question-editor";
import { bankTitle, type Bank } from "./bank-library-shared";

export async function readBankDetailDataset(
  bank: Bank,
  scope: ProgressScope = { type: "rolling", days: 90 },
  referenceTime = Date.now(),
  activityWindow?: { from: string; to: string },
) {
  const views = await listQuestionViewsForBank(bank.id);
  const questions = views.map((view) => toQuestionViewModel(view.question, bank.id, bankTitle(bank), view.memberships[0]?.sortOrder ?? 0));
  const questionIds = questions.map((question) => question.id);
  const normalizedScope = normalizeProgressScope(scope);
  const rollingAttempts = normalizedScope.type === "rolling" && questionIds.length
    ? readAttemptsForQuestionIdsInWindow(
        questionIds,
        new Date(progressScopeCutoff(normalizedScope, referenceTime)!).toISOString(),
        new Date(referenceTime).toISOString(),
      )
    : Promise.resolve([]);
  const roundRows = normalizedScope.type === "round" && questionIds.length
    ? studyDb.reviewRoundProgress.bulkGet(
        questionIds.map((questionId) => [normalizedScope.roundId, questionId] as [string, string]),
      ).then((rows) => rows.filter((row) => row !== undefined))
    : Promise.resolve([]);
  const dailyRows = activityWindow && questionIds.length
    ? Promise.all(questionIds.map((questionId) =>
        studyDb.questionDailyProgress
          .where("[questionId+date]")
          .between([questionId, activityWindow.from], [questionId, activityWindow.to], true, true)
          .toArray()
      )).then((groups) => groups.flat())
    : Promise.resolve([]);
  const [rawStats, attempts, notes, runs, runStats, roundProgress, activityDailyStats] = await Promise.all([
    studyDb.questionProgress.bulkGet(questionIds),
    rollingAttempts,
    studyDb.notes.bulkGet(questionIds),
    listRecentPracticeRunsForBank(bank.id, 5),
    studyDb.bankPracticeStats.get(bank.id),
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
