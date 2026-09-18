/** Practice-run creation and reference validation. */
import {
  studyDb,
  makeId,
  nowIso,
  uniqueStrings,
} from "./db-core";
import type { CreatePracticeRunInput } from "./db-core";
import { enqueueChangeSet } from "./db-change-sets";
import { bankLabel, getQuestionsForBanks } from "./db-bank";
import { practiceRunRecord } from "./practice-run-store";
import { updatePracticeRunStatsInTx } from "./db-practice-stats";
import { restrictPracticeRunMappings } from "../practice/practice-run-invariants";
import type { Bank, PracticeRun } from "./types";

type PracticeRunReferences = Pick<PracticeRun, "bankId" | "bankIds" | "questionIds" | "reviewRoundId">;

/** Caller must already own a transaction containing banks/questions/reviewRounds. */
export async function validatePracticeRunReferencesInTx(
  run: PracticeRunReferences,
  options?: { requireActiveRound?: boolean },
) {
  const bankIds = uniqueStrings(run.bankIds);
  if (!run.bankId || !bankIds.length) throw new Error("练习至少需要一个有效题库。");
  if (!bankIds.includes(run.bankId)) throw new Error("练习主题库必须包含在题库范围中。");
  const bankRows = await studyDb.banks.bulkGet(bankIds);
  if (bankRows.some((bank) => !bank)) throw new Error("部分题库不存在或已被删除。");
  const questionIds = uniqueStrings(run.questionIds);
  const questions = await studyDb.questions.bulkGet(questionIds);
  if (questions.some((question) => !question)) throw new Error("部分题目不存在或已被删除。");
  if (run.reviewRoundId) {
    const round = await studyDb.reviewRounds.get(run.reviewRoundId);
    if (!round) throw new Error("复习轮次不存在或已被删除。");
    if (options?.requireActiveRound && round.status !== "active") throw new Error("只能为 active 复习轮次创建练习。");
  }
  return { banks: bankRows as Bank[], questions, bankIds, questionIds };
}

/** Internal question-range resolver shared with review-round operations. */
export async function deriveRunQuestions(bankIds: string[]): Promise<string[]> {
  return (await getQuestionsForBanks(bankIds)).map((question) => question.id);
}

export async function createPracticeRun(input: CreatePracticeRunInput = {}): Promise<PracticeRun> {
  const bankIds = uniqueStrings(input.bankIds ?? (input.bankId ? [input.bankId] : []));
  const bankId = input.bankId ?? bankIds[0] ?? "";
  if (!bankId || !bankIds.length) throw new Error("练习至少需要一个有效题库。");
  if (!bankIds.includes(bankId)) throw new Error("练习主题库必须包含在题库范围中。");
  const timestamp = input.startedAt ?? nowIso();
  return studyDb.transaction("rw", [
    studyDb.banks,
    studyDb.bankQuestionMemberships,
    studyDb.questions,
    studyDb.reviewRounds,
    studyDb.practiceRuns,
    studyDb.practiceRunSources,
    studyDb.practiceRunItems,
    studyDb.bankPracticeStats,
    studyDb.changeSets,
    studyDb.syncMeta,
  ], async () => {
    const questionIds = uniqueStrings(input.questionIds ?? await deriveRunQuestions(bankIds));
    const { banks, questions } = await validatePracticeRunReferencesInTx(
      { bankId, bankIds, questionIds, reviewRoundId: input.reviewRoundId },
      { requireActiveRound: true },
    );
    const questionTypes = input.questionTypes ?? Object.fromEntries(questions.map((question) => [question!.id, question!.type]));
    const run = restrictPracticeRunMappings({
      id: input.id ?? makeId("run"),
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
    });
    if (Object.values(run.answers).some((answer) => answer.submitted)) {
      throw new Error("创建练习不能携带已提交答案；已提交答案必须通过 attempt 写入。");
    }
    const record = practiceRunRecord(run);
    const sources = bankIds.map((sourceBankId, position) => ({
      runId: run.id,
      bankId: sourceBankId,
      bankNameSnapshot: bankLabel(banks[position]),
      position,
    }));
    const items = questionIds.map((questionId, position) => {
      const draft = run.answers[questionId];
      return {
        runId: run.id,
        questionId,
        position,
        questionTypeSnapshot: run.questionTypes[questionId],
        optionOrder: [...(run.optionOrders[questionId] ?? [])],
        ...(!draft?.submitted && draft?.selected ? { draftSelected: [...draft.selected] } : {}),
        ...(!draft?.submitted && draft?.response ? { draftResponse: draft.response } : {}),
      };
    });
    await studyDb.practiceRuns.put(record);
    await studyDb.practiceRunSources.bulkPut(sources);
    await studyDb.practiceRunItems.bulkPut(items);
    await updatePracticeRunStatsInTx(undefined, run);
    await enqueueChangeSet([{ kind: "practice.run.saved", record, sources, items }], timestamp);
    return run;
  });
}
