import { dbV7 } from "@/lib/db/db-v7";
import { listQuestionViewsForBankV7 } from "@/lib/db/app-data-v7";
import { listPracticeRunsForBankV7 } from "@/lib/db/practice-run-read-v7";
import { toQuestionViewModel } from "@/app/bank/question-editor";
import { bankTitle, type Bank } from "./bank-library-shared";

export async function readBankDetailDatasetV7(bank: Bank) {
  const views = await listQuestionViewsForBankV7(bank.id);
  const questions = views.map((view) => toQuestionViewModel(view.question, bank.id, bankTitle(bank), view.memberships[0]?.sortOrder ?? 0));
  const questionIds = questions.map((question) => question.id);
  const [rawStats, attempts, notes, runs, runStats, roundProgress] = await Promise.all([
    dbV7.attemptStats.bulkGet(questionIds),
    questionIds.length ? dbV7.attempts.where("questionId").anyOf(questionIds).toArray() : [],
    dbV7.notes.bulkGet(questionIds),
    listPracticeRunsForBankV7(bank.id),
    dbV7.practiceRunStats.get(bank.id),
    questionIds.length ? dbV7.reviewRoundProgress.where("questionId").anyOf(questionIds).toArray() : [],
  ]);
  return {
    questions,
    lifetimeAttemptStats: rawStats.filter((stats) => stats !== undefined).map((stats) => ({ ...stats, bankId: bank.id })),
    attempts,
    notes: notes.flatMap((note) => note?.content.trim() ? [note] : []),
    runs,
    runStats,
    roundProgress,
  };
}
