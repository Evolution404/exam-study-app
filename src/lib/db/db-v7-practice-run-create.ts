/** Practice-run creation and reference validation. */
import {
  dbV7,
  makeV7Id,
  nowIso,
  uniqueStrings,
} from "./db-v7-core";
import type { CreatePracticeRunInputV7 } from "./db-v7-core";
import { enqueueChangeSetV7 } from "./db-v7-change-sets";
import { bankLabel, getQuestionsForBanksV7 } from "./db-v7-bank";
import { putPracticeRunInTx } from "./db-v7-practice-activity";
import { updatePracticeRunStatsInTx } from "./db-v7-practice-stats";
import type { BankV7, PracticeRunV7 } from "./v7-types";

/** Internal question-range resolver shared with review-round operations. */
export async function deriveRunQuestions(bankIds: string[]): Promise<string[]> {
  return (await getQuestionsForBanksV7(bankIds)).map((question) => question.id);
}

export async function createPracticeRunV7(input: CreatePracticeRunInputV7 = {}): Promise<PracticeRunV7> {
  const bankIds = uniqueStrings(input.bankIds ?? (input.bankId ? [input.bankId] : []));
  const bankId = input.bankId ?? bankIds[0] ?? "";
  if (!bankId || !bankIds.length) throw new Error("练习至少需要一个有效题库。");
  if (!bankIds.includes(bankId)) throw new Error("练习主题库必须包含在题库范围中。");
  const timestamp = input.startedAt ?? nowIso();
  return dbV7.transaction("rw", [
    dbV7.banks,
    dbV7.bankQuestionMemberships,
    dbV7.questions,
    dbV7.reviewRounds,
    dbV7.practiceRuns,
    dbV7.practiceRunActivity,
    dbV7.practiceRunStats,
    dbV7.changeSets,
    dbV7.syncMeta,
  ], async () => {
    const bankRows = await dbV7.banks.bulkGet(bankIds);
    if (bankRows.some((bank) => !bank)) throw new Error("部分题库不存在或已被删除。");
    const banks = bankRows as BankV7[];
    if (input.reviewRoundId) {
      const round = await dbV7.reviewRounds.get(input.reviewRoundId);
      if (!round) throw new Error("复习轮次不存在或已被删除。");
      if (round.status !== "active") throw new Error("只能为 active 复习轮次创建练习。");
    }
    const questionIds = uniqueStrings(input.questionIds ?? await deriveRunQuestions(bankIds));
    const questions = await dbV7.questions.bulkGet(questionIds);
    if (questions.some((question) => !question)) throw new Error("部分题目不存在或已被删除。");
    const questionTypes = input.questionTypes ?? Object.fromEntries(questions.map((question) => [question!.id, question!.type]));
    const run: PracticeRunV7 = {
      id: input.id ?? makeV7Id("run"),
      bankId,
      bankIds,
      bankName: input.bankName ?? (banks.length === 1 ? bankLabel(banks[0]) : `${banks.length} 个题库组合`),
      mode: input.mode ?? "sequential",
      modeLabel: input.modeLabel ?? "练习",
      questionIds,
      questionTypes,
      answers: input.answers ?? {},
      shuffleOptions: Boolean(input.shuffleOptions),
      optionOrders: input.optionOrders ?? {},
      startedAt: timestamp,
      updatedAt: input.updatedAt ?? timestamp,
      status: input.status ?? "in_progress",
      revision: input.revision ?? 0,
      lastAnsweredIndex: input.lastAnsweredIndex,
      reviewRoundId: input.reviewRoundId,
    };
    await putPracticeRunInTx(run);
    await updatePracticeRunStatsInTx(undefined, run);
    await enqueueChangeSetV7([{ kind: "practice.run.saved", run }], timestamp);
    return run;
  });
}
