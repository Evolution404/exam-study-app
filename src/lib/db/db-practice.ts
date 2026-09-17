/**
 * Practice runs, review rounds, answer recording and statistics.
 */
import {
  datePart,
  studyDb,
  getDeviceId,
  makeId,
  nowIso,
  uniqueStrings,
} from "./db-core";
import type { PracticeAnswerInput, PracticeAnswer } from "./db-core";
import { enqueueChangeSet } from "./db-change-sets";
import { deriveRunQuestions, validatePracticeRunReferencesInTx } from "./db-practice-run-create";
import { updatePracticeRunStatsInTx } from "./db-practice-stats";
import { addAttemptToStats, addDailyStats, updateReviewRoundProgressForAttemptInTx } from "./db-attempt-projections";
import { withSyncLock } from "../sync/sync-lock";
import { restrictPracticeRunMappings } from "../practice/practice-run-invariants";
import { stableQuestionOptionIds } from "../question/question-utils";
import { getReviewRound, putReviewRoundInTx } from "./review-round-store";
import {
  getPracticeRun,
  putPracticeRunRecordInTx,
} from "./practice-run-store";
import type {
  Attempt,
  PracticeRun,
  ReviewRound,
  AttemptOutcome,
  PracticeResponse,
  Question,
} from "./types";

export type StructuredPracticeAnswerInput = PracticeAnswerInput & {
  response?: PracticeResponse;
  outcome?: AttemptOutcome;
};

function stableOptionIdForAnswer(question: Question, letter: string): string | undefined {
  const index = letter.charCodeAt(0) - 65;
  return stableQuestionOptionIds(question)[index];
}

export async function savePracticeRun(run: PracticeRun): Promise<PracticeRun> {
  const updated = restrictPracticeRunMappings({ ...run, updatedAt: run.updatedAt || nowIso() });
  return studyDb.transaction("rw", [
    studyDb.banks,
    studyDb.questions,
    studyDb.reviewRounds,
    studyDb.practiceRuns,
    studyDb.practiceRunSources,
    studyDb.practiceRunItems,
    studyDb.attempts,
    studyDb.bankPracticeStats,
    studyDb.changeSets,
    studyDb.syncMeta,
  ], async () => {
    const { banks } = await validatePracticeRunReferencesInTx(updated);
    const current = await getPracticeRun(run.id);
    const existingItems = await studyDb.practiceRunItems.where("runId").equals(run.id).toArray();
    const existingItemByQuestion = new Map(existingItems.map((item) => [item.questionId, item]));
    for (const [questionId, answer] of Object.entries(updated.answers)) {
      if (answer.submitted && !existingItemByQuestion.get(questionId)?.submittedAttemptId) {
        throw new Error("完整练习保存不能创建已提交答案；已提交答案必须通过 attempt 写入。");
      }
    }
    await updatePracticeRunStatsInTx(current, updated);
    await putPracticeRunRecordInTx(updated);
    await studyDb.practiceRunSources.where("runId").equals(run.id).delete();
    await studyDb.practiceRunSources.bulkPut(updated.bankIds.map((bankId, position) => ({
      runId: run.id,
      bankId,
      bankNameSnapshot: position === 0 ? updated.bankName : (banks[position]?.displayName || banks[position]?.name || bankId),
      position,
    })));
    await studyDb.practiceRunItems.where("runId").equals(run.id).delete();
    await studyDb.practiceRunItems.bulkPut(updated.questionIds.map((questionId, position) => {
      const answer = updated.answers[questionId];
      const existing = existingItemByQuestion.get(questionId);
      return {
        runId: run.id,
        questionId,
        position,
        questionTypeSnapshot: updated.questionTypes[questionId],
        optionOrder: [...(updated.optionOrders[questionId] ?? [])],
        ...(existing?.submittedAttemptId ? { submittedAttemptId: existing.submittedAttemptId } : {}),
        ...(!answer?.submitted && answer?.selected ? { draftSelected: [...answer.selected] } : {}),
        ...(!answer?.submitted && answer?.response ? { draftResponse: answer.response } : {}),
      };
    }));
    await enqueueChangeSet([{ kind: "practice.run.saved", run: updated }], updated.updatedAt);
    return updated;
  });
}

/**
 * Persist navigation and unsubmitted UI progress without creating a domain
 * event. Submitted answers and status changes have their own single events;
 * emitting a run snapshot here would reintroduce the historical two-events-
 * per-answer bug and can exceed the event-page limit for large runs.
 *
 * The read and write are kept inside one transaction, and the run's structural
 * fields (questionIds/questionTypes) are always taken from the authoritative
 * DB row — never from the passed `run`, which may be a stale snapshot. This
 * closes a read-after-write race where a concurrent deleteQuestions trims the
 * run between the old non-atomic get and put: previously the stale questionIds
 * were written back, resurrecting a just-deleted question in the run. Answers
 * referencing questions no longer in the run are dropped so they cannot
 * outlive their question. Returns undefined if the run was deleted (the caller
 * surfaces that as an ended session — see the run-disappears guard in study-app).
 */
export async function savePracticeProgress(run: PracticeRun): Promise<PracticeRun | undefined> {
  return withSyncLock(() => studyDb.transaction("rw", [studyDb.practiceRuns, studyDb.practiceRunSources, studyDb.practiceRunItems, studyDb.attempts, studyDb.bankPracticeStats], async () => {
    const current = await getPracticeRun(run.id);
    if (!current) return undefined;
    const items = await studyDb.practiceRunItems.where("runId").equals(run.id).toArray();
    for (const item of items) {
      if (item.submittedAttemptId) continue;
      const draft = run.answers[item.questionId];
      await studyDb.practiceRunItems.put({
        ...item,
        ...(draft?.selected?.length ? { draftSelected: [...draft.selected] } : { draftSelected: undefined }),
        ...(draft?.response ? { draftResponse: draft.response } : { draftResponse: undefined }),
      });
    }
    const answers = { ...current.answers };
    for (const item of items) {
      if (item.submittedAttemptId) continue;
      const draft = run.answers[item.questionId];
      if (draft) answers[item.questionId] = { ...draft, submitted: false };
      else delete answers[item.questionId];
    }
    const updated: PracticeRun = {
      ...current,
      answers,
      lastAnsweredIndex: run.lastAnsweredIndex,
      updatedAt: run.updatedAt || nowIso(),
      revision: current.revision + 1,
    };
    await updatePracticeRunStatsInTx(current, updated);
    await putPracticeRunRecordInTx(updated);
    return updated;
  }));
}

export async function getReviewRoundQuestionIds(roundId: string): Promise<string[]> {
  const round = await getReviewRound(roundId);
  if (!round) throw new Error("复习轮次不存在或已被删除。");
  if ((round.status === "completed" || round.status === "archived") && round.finalQuestionIds) return uniqueStrings(round.finalQuestionIds);
  return deriveRunQuestions(uniqueStrings(round.bankIds));
}

export const getRoundQuestionIds = getReviewRoundQuestionIds;

export async function createReviewRound(input: Pick<ReviewRound, "name" | "bankIds"> & Partial<ReviewRound>): Promise<ReviewRound> {
  const timestamp = input.startedAt ?? nowIso();
  const bankIds = uniqueStrings(input.bankIds);
  return studyDb.transaction("rw", [studyDb.banks, studyDb.reviewRounds, studyDb.reviewRoundBanks, studyDb.reviewRoundItems, studyDb.changeSets, studyDb.syncMeta], async () => {
    const banks = await studyDb.banks.bulkGet(bankIds);
    if (banks.some((bank) => !bank)) throw new Error("部分题库不存在或已被删除。");
    const round: ReviewRound = {
      id: input.id ?? makeId("round"),
      name: input.name.trim() || "复习轮次",
      bankIds,
      startedAt: timestamp,
      status: "active",
      createdAt: input.createdAt ?? timestamp,
      updatedAt: timestamp,
      deviceId: getDeviceId(),
    };
    await putReviewRoundInTx(round, { replaceBanks: true, replaceItems: true });
    await enqueueChangeSet([{ kind: "review.round.saved", round }], timestamp);
    return round;
  });
}

export async function updateReviewRound(roundId: string, changes: Partial<Pick<ReviewRound, "name" | "bankIds">>): Promise<ReviewRound> {
  return studyDb.transaction("rw", [studyDb.banks, studyDb.reviewRounds, studyDb.reviewRoundBanks, studyDb.reviewRoundItems, studyDb.changeSets, studyDb.syncMeta], async () => {
    const current = await getReviewRound(roundId);
    if (!current) throw new Error("复习轮次不存在或已被删除。");
    if (current.status !== "active") throw new Error("已完成或归档的复习轮次不可修改目标题库。");
    const bankIds = changes.bankIds === undefined ? current.bankIds : uniqueStrings(changes.bankIds);
    if (changes.bankIds !== undefined) {
      const banks = await studyDb.banks.bulkGet(bankIds);
      if (banks.some((bank) => !bank)) throw new Error("部分题库不存在或已被删除。");
    }
    const updated: ReviewRound = {
      ...current,
      name: changes.name === undefined ? current.name : changes.name.trim() || current.name,
      bankIds,
      updatedAt: nowIso(),
      deviceId: getDeviceId(),
    };
    await putReviewRoundInTx(updated, { replaceBanks: true, replaceItems: false });
    await enqueueChangeSet([{ kind: "review.round.saved", round: updated }], updated.updatedAt);
    return updated;
  });
}

async function completeRoundInTx(round: ReviewRound, finalQuestionIds: string[]): Promise<ReviewRound> {
  const timestamp = nowIso();
  const completed: ReviewRound = { ...round, status: "completed", completedAt: timestamp, finalQuestionIds: uniqueStrings(finalQuestionIds), updatedAt: timestamp, deviceId: getDeviceId() };
  await putReviewRoundInTx(completed, { replaceBanks: false, replaceItems: true });
  return completed;
}

export async function completeReviewRound(roundId: string, finalQuestionIds?: readonly string[]): Promise<ReviewRound> {
  return studyDb.transaction("rw", [
    studyDb.reviewRounds,
    studyDb.reviewRoundBanks,
    studyDb.reviewRoundItems,
    studyDb.bankQuestionMemberships,
    studyDb.questions,
    studyDb.changeSets,
    studyDb.syncMeta,
  ], async () => {
    const current = await getReviewRound(roundId);
    if (!current) throw new Error("复习轮次不存在或已被删除。");
    if (current.status === "completed" || current.status === "archived") return current;
    const targets = finalQuestionIds ? uniqueStrings(finalQuestionIds) : await deriveRunQuestions(uniqueStrings(current.bankIds));
    if (finalQuestionIds) {
      const questions = await studyDb.questions.bulkGet(targets);
      if (questions.some((question) => !question)) throw new Error("部分题目不存在或已被删除。");
    }
    const completed = await completeRoundInTx(current, targets);
    await enqueueChangeSet([{ kind: "review.round.completed", round: completed }], completed.updatedAt);
    return completed;
  });
}

export async function archiveReviewRound(roundId: string): Promise<ReviewRound> {
  return studyDb.transaction("rw", [studyDb.reviewRounds, studyDb.reviewRoundBanks, studyDb.reviewRoundItems, studyDb.changeSets, studyDb.syncMeta], async () => {
    const current = await getReviewRound(roundId);
    if (!current) throw new Error("复习轮次不存在或已被删除。");
    if (current.status === "archived") return current;
    const updated: ReviewRound = { ...current, status: "archived", updatedAt: nowIso(), deviceId: getDeviceId() };
    await putReviewRoundInTx(updated, { replaceBanks: false, replaceItems: false });
    await enqueueChangeSet([{ kind: "review.round.archived", round: updated }], updated.updatedAt);
    return updated;
  });
}

export const archiveRound = archiveReviewRound;

export async function setPracticeRunStatus(runId: string, status: PracticeRun["status"], answers?: PracticeRun["answers"]): Promise<PracticeRun | undefined> {
  return studyDb.transaction("rw", [
    studyDb.practiceRuns,
    studyDb.practiceRunSources,
    studyDb.practiceRunItems,
    studyDb.attempts,
    studyDb.bankPracticeStats,
    studyDb.changeSets,
    studyDb.syncMeta,
  ], async () => {
    const current = await getPracticeRun(runId);
    if (!current) return undefined;
    const items = await studyDb.practiceRunItems.where("runId").equals(runId).toArray();
    if (answers) {
      for (const item of items) {
        if (item.submittedAttemptId) continue;
        const draft = answers[item.questionId];
        await studyDb.practiceRunItems.put({
          ...item,
          ...(draft?.selected?.length ? { draftSelected: [...draft.selected] } : { draftSelected: undefined }),
          ...(draft?.response ? { draftResponse: draft.response } : { draftResponse: undefined }),
        });
      }
    }
    const updatedAt = nowIso();
    const nextAnswers = { ...current.answers };
    if (answers) {
      for (const item of items) {
        if (item.submittedAttemptId) continue;
        const draft = answers[item.questionId];
        if (draft) nextAnswers[item.questionId] = { ...draft, submitted: false };
        else delete nextAnswers[item.questionId];
      }
    }
    const updated = restrictPracticeRunMappings({
      ...current,
      answers: nextAnswers,
      status,
      updatedAt,
      completedAt: status === "completed" ? updatedAt : current.completedAt,
      abandonedAt: status === "abandoned" ? updatedAt : undefined,
      revision: current.revision + 1,
    });
    await updatePracticeRunStatsInTx(current, updated);
    await putPracticeRunRecordInTx(updated);
    await enqueueChangeSet([{ kind: "practice.run.status.changed", run: updated }], updatedAt);
    return updated;
  });
}

async function autoCompleteRoundIfReadyInTx(roundId: string): Promise<void> {
  const round = await getReviewRound(roundId);
  if (!round || round.status !== "active") return;
  const targets = await getReviewRoundQuestionIds(roundId);
  if (!targets.length) return;
  const progress = await studyDb.reviewRoundProgress.where("roundId").equals(roundId).toArray();
  const done = new Set(progress.map((item) => item.questionId));
  if (targets.every((questionId) => done.has(questionId))) await completeRoundInTx(round, targets);
}


/**
 * Submit one answer.  All local projections and the optional round progress
 * are committed in one transaction and exactly one domain event is emitted.
 */
export async function recordPracticeAnswer(input: StructuredPracticeAnswerInput): Promise<{ attempt: Attempt; answer: PracticeAnswer & { response?: PracticeResponse; outcome?: AttemptOutcome } }> {
  // Calculation blanks are positional and may legitimately contain the same
  // value more than once, so answer state must preserve order and duplicates.
  const selected = (Array.isArray(input.selected) ? [...input.selected] : [input.selected]).map(String);
  const timestamp = input.createdAt ?? nowIso();
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) throw new Error("当前作答必须提供有效 elapsedMs。");
  const selectedAnswer = selected.join("");
  return studyDb.transaction("rw", [
    studyDb.attempts, studyDb.questionProgress, studyDb.questionDailyProgress, studyDb.practiceRuns,
    studyDb.practiceRunSources, studyDb.practiceRunItems,
    studyDb.bankPracticeStats, studyDb.reviewRounds, studyDb.reviewRoundBanks, studyDb.reviewRoundItems, studyDb.reviewRoundProgress,
    studyDb.questions, studyDb.bankQuestionMemberships, studyDb.changeSets, studyDb.syncMeta,
  ], async () => {
    // Re-read the authoritative run after the write transaction has acquired
    // its lock. Two answers submitted concurrently must merge their answers
    // and increment revision from the same serial order; using a snapshot read
    // before this transaction let the later writer erase the earlier answer.
    const run = await getPracticeRun(input.runId);
    if (!run) throw new Error("练习记录不存在或已被删除。");
    const runItem = await studyDb.practiceRunItems.get([input.runId, input.questionId]);
    if (!runItem) throw new Error("练习记录不包含当前题目。");
    if (input.reviewRoundId !== undefined && input.reviewRoundId !== run.reviewRoundId) {
      throw new Error("reviewRoundId 必须与练习记录绑定的 active 复习轮次一致。");
    }
    const reviewRoundId = run.reviewRoundId;
    if (reviewRoundId) {
      const round = await studyDb.reviewRounds.get(reviewRoundId);
      if (!round || round.status !== "active") throw new Error("reviewRoundId 必须匹配 active 复习轮次。");
      const targetIds = await getReviewRoundQuestionIds(reviewRoundId);
      if (!targetIds.includes(input.questionId)) throw new Error("当前题目不属于 active 复习轮次。");
      if (run.reviewRoundId && run.reviewRoundId !== reviewRoundId) throw new Error("reviewRoundId 与练习记录不匹配。");
    }
    const deviceId = getDeviceId();
    const eventId = makeId("answer");
    const sourceBankId = input.sourceBankId ?? input.bankId ?? run.bankIds[0];
    const question = await studyDb.questions.get(input.questionId);
    const outcome = input.outcome ?? (selected.length ? (input.correct ? "correct" : "incorrect") : "skipped");
    const response: PracticeResponse | undefined = input.response ?? (question?.type === "简答"
      ? { kind: "short", text: selected.join("\n") }
      : question?.type === "填空"
        ? { kind: "fill", values: selected }
        : question?.type === "计算"
          ? { kind: "calculation", values: selected }
          : question
            ? { kind: "choice", selectedOptionIds: selected.map((letter) => stableOptionIdForAnswer(question, letter)).filter((id): id is string => Boolean(id)) }
            : undefined);
    const attempt: Attempt = {
      id: makeId("attempt"),
      runId: input.runId,
      questionId: input.questionId,
      ...(reviewRoundId ? { reviewRoundId } : {}),
      selected: selectedAnswer,
      correct: Boolean(input.correct),
      elapsedMs: input.elapsedMs,
      createdAt: timestamp,
      deviceId,
      ...(sourceBankId ? { sourceBankId } : {}),
      ...(response ? { response } : {}),
      outcome,
    };
    const answer: PracticeAnswer & { response?: PracticeResponse; outcome?: AttemptOutcome } = {
      selected,
      submitted: true,
      correct: Boolean(input.correct),
      updatedAt: timestamp,
      deviceId,
      eventId,
      ...(response ? { response } : {}),
      outcome,
    };
    const answers = { ...run.answers, [input.questionId]: answer };
    const lastSubmittedIndex = run.questionIds.reduce(
      (last, questionId, index) => answers[questionId]?.submitted ? index : last,
      -1,
    );
    const nextRun: PracticeRun = {
      ...run,
      answers,
      updatedAt: timestamp,
      revision: run.revision + 1,
      lastAnsweredIndex: lastSubmittedIndex >= 0 ? lastSubmittedIndex : run.lastAnsweredIndex,
    };
    await studyDb.attempts.put(attempt);
    await studyDb.practiceRunItems.put({
      ...runItem,
      submittedAttemptId: attempt.id,
      draftSelected: undefined,
      draftResponse: undefined,
    });
    await studyDb.questionProgress.put(addAttemptToStats(await studyDb.questionProgress.get(input.questionId), attempt));
    await studyDb.questionDailyProgress.put(addDailyStats(await studyDb.questionDailyProgress.get([datePart(timestamp), input.questionId]), attempt));
    await updatePracticeRunStatsInTx(run, nextRun);
    await putPracticeRunRecordInTx(nextRun);
    if (reviewRoundId) {
      await updateReviewRoundProgressForAttemptInTx(reviewRoundId, input.questionId, attempt);
      await autoCompleteRoundIfReadyInTx(reviewRoundId);
    }
    const completedRound = reviewRoundId ? await getReviewRound(reviewRoundId) : undefined;
    await enqueueChangeSet([
      { kind: "practice.answer.submitted", attempt, answer, runId: input.runId, questionId: input.questionId, ...(reviewRoundId ? { reviewRoundId } : {}) },
      ...(completedRound?.status === "completed" ? [{ kind: "review.round.completed" as const, round: completedRound }] : []),
    ], timestamp);
    return { attempt, answer };
  });
}
