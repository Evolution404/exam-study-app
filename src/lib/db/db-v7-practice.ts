/**
 * v7 practice runs, review rounds, answer recording and statistics.
 */
import {
  dailyStatsKey,
  datePart,
  dbV7,
  getV7DeviceId,
  makeV7Id,
  nextV7Sequence,
  nowIso,
  tombstoneKey,
  uniqueStrings,
} from "./db-v7-core";
import type { CreatePracticeRunInputV7, PracticeAnswerInputV7, PracticeAnswerV7 } from "./db-v7-core";
import { enqueueChangeSetV7 } from "./db-v7-change-sets";
import { bankLabel, getQuestionsForBanksV7 } from "./db-v7-bank";
import { updatePracticeRunStatsInTx } from "./db-v7-practice-stats";
import { withSyncLock } from "../sync/sync-lock";
import type {
  AttemptDailyStatsV7,
  AttemptStatsV7,
  AttemptV7,
  BankV7,
  PracticeRunV7,
  ReviewRound,
  ReviewRoundProgress,
} from "./v7-types";

/** internal，供兄弟模块使用 */
export async function deriveRunQuestions(bankIds: string[]): Promise<string[]> {
  return (await getQuestionsForBanksV7(bankIds)).map((question) => question.id);
}

export async function createPracticeRunV7(input: CreatePracticeRunInputV7 = {}): Promise<PracticeRunV7> {
  const bankIds = uniqueStrings(input.bankIds ?? (input.bankId ? [input.bankId] : []));
  const bankId = input.bankId ?? bankIds[0] ?? "";
  const banks = (await dbV7.banks.bulkGet(bankIds)).filter(Boolean) as BankV7[];
  const timestamp = input.startedAt ?? nowIso();
  const questionIds = uniqueStrings(input.questionIds ?? await deriveRunQuestions(bankIds));
  const questions = await dbV7.questions.bulkGet(questionIds);
  const questionTypes = input.questionTypes ?? Object.fromEntries(questions.filter(Boolean).map((question) => [question!.id, question!.type]));
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
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.changeSets, dbV7.syncMeta], async () => {
    await dbV7.practiceRuns.put(run);
    await updatePracticeRunStatsInTx(undefined, run);
    await enqueueChangeSetV7([{ kind: "practice.run.saved", run }], timestamp);
  });
  return run;
}

export async function savePracticeRunV7(run: PracticeRunV7): Promise<PracticeRunV7> {
  const current = await dbV7.practiceRuns.get(run.id);
  const updated = { ...run, updatedAt: run.updatedAt || nowIso() };
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.changeSets, dbV7.syncMeta], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV7.practiceRuns.put(updated);
    await enqueueChangeSetV7([{ kind: "practice.run.saved", run: updated }], updated.updatedAt);
  });
  return updated;
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
 * closes a read-after-write race where a concurrent deleteQuestionsV7 trims the
 * run between the old non-atomic get and put: previously the stale questionIds
 * were written back, resurrecting a just-deleted question in the run. Answers
 * referencing questions no longer in the run are dropped so they cannot
 * outlive their question. Returns undefined if the run was deleted (the caller
 * surfaces that as an ended session — see the run-disappears guard in study-app).
 */
export async function savePracticeProgressV7(run: PracticeRunV7): Promise<PracticeRunV7 | undefined> {
  return withSyncLock(() => dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats], async () => {
    const current = await dbV7.practiceRuns.get(run.id);
    if (!current) return undefined;
    const liveQuestionIds = new Set(current.questionIds);
    const answers = Object.fromEntries(Object.entries(run.answers).filter(([questionId]) => liveQuestionIds.has(questionId)));
    const questionTypes = Object.fromEntries(Object.entries(current.questionTypes).filter(([questionId]) => liveQuestionIds.has(questionId)));
    const updated: PracticeRunV7 = {
      ...current,
      questionIds: current.questionIds,
      questionTypes,
      answers,
      lastAnsweredIndex: run.lastAnsweredIndex,
      updatedAt: run.updatedAt || nowIso(),
      revision: current.revision + 1,
    };
    await updatePracticeRunStatsInTx(current, updated);
    await dbV7.practiceRuns.put(updated);
    return updated;
  }));
}

export async function getReviewRoundQuestionIdsV7(roundId: string): Promise<string[]> {
  const round = await dbV7.reviewRounds.get(roundId);
  if (!round) throw new Error("复习轮次不存在或已被删除。");
  if ((round.status === "completed" || round.status === "archived") && round.finalQuestionIds) return uniqueStrings(round.finalQuestionIds);
  return deriveRunQuestions(uniqueStrings(round.bankIds));
}

export const getRoundQuestionIdsV7 = getReviewRoundQuestionIdsV7;

export async function createReviewRoundV7(input: Pick<ReviewRound, "name" | "bankIds"> & Partial<ReviewRound>): Promise<ReviewRound> {
  const timestamp = input.startedAt ?? nowIso();
  const round: ReviewRound = {
    id: input.id ?? makeV7Id("round"),
    name: input.name.trim() || "复习轮次",
    bankIds: uniqueStrings(input.bankIds),
    startedAt: timestamp,
    status: "active",
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
    deviceId: getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.reviewRounds, dbV7.changeSets, dbV7.syncMeta], async () => {
    await dbV7.reviewRounds.put(round);
    await enqueueChangeSetV7([{ kind: "review.round.saved", round }], timestamp);
  });
  return round;
}

export async function updateReviewRoundV7(roundId: string, changes: Partial<Pick<ReviewRound, "name" | "bankIds">>): Promise<ReviewRound> {
  const current = await dbV7.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status !== "active") throw new Error("已完成或归档的复习轮次不可修改目标题库。");
  const updated: ReviewRound = {
    ...current,
    name: changes.name === undefined ? current.name : changes.name.trim() || current.name,
    bankIds: changes.bankIds === undefined ? current.bankIds : uniqueStrings(changes.bankIds),
    updatedAt: nowIso(),
    deviceId: getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.reviewRounds, dbV7.changeSets, dbV7.syncMeta], async () => {
    await dbV7.reviewRounds.put(updated);
    await enqueueChangeSetV7([{ kind: "review.round.saved", round: updated }], updated.updatedAt);
  });
  return updated;
}

async function completeRoundInTx(round: ReviewRound, finalQuestionIds: string[]): Promise<ReviewRound> {
  const timestamp = nowIso();
  const completed: ReviewRound = { ...round, status: "completed", completedAt: timestamp, finalQuestionIds: uniqueStrings(finalQuestionIds), updatedAt: timestamp, deviceId: getV7DeviceId() };
  await dbV7.reviewRounds.put(completed);
  return completed;
}

export async function completeReviewRoundV7(roundId: string, finalQuestionIds?: readonly string[]): Promise<ReviewRound> {
  const current = await dbV7.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status === "completed" || current.status === "archived") return current;
  const targets = finalQuestionIds ? uniqueStrings(finalQuestionIds) : await getReviewRoundQuestionIdsV7(roundId);
  return dbV7.transaction("rw", [dbV7.reviewRounds, dbV7.changeSets, dbV7.syncMeta], async () => {
    const completed = await completeRoundInTx(current, targets);
    await enqueueChangeSetV7([{ kind: "review.round.completed", round: completed }], completed.updatedAt);
    return completed;
  });
}

export async function archiveReviewRoundV7(roundId: string): Promise<ReviewRound> {
  const current = await dbV7.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status === "archived") return current;
  const updated: ReviewRound = { ...current, status: "archived", updatedAt: nowIso(), deviceId: getV7DeviceId() };
  await dbV7.transaction("rw", [dbV7.reviewRounds, dbV7.changeSets, dbV7.syncMeta], async () => {
    await dbV7.reviewRounds.put(updated);
    await enqueueChangeSetV7([{ kind: "review.round.archived", round: updated }], updated.updatedAt);
  });
  return updated;
}

export const archiveRoundV7 = archiveReviewRoundV7;

export async function setPracticeRunStatusV7(runId: string, status: PracticeRunV7["status"], answers?: PracticeRunV7["answers"]): Promise<PracticeRunV7 | undefined> {
  const current = await dbV7.practiceRuns.get(runId);
  if (!current) return undefined;
  const updatedAt = nowIso();
  const updated: PracticeRunV7 = {
    ...current,
    answers: answers ?? current.answers,
    status,
    updatedAt,
    completedAt: status === "completed" ? updatedAt : current.completedAt,
    abandonedAt: status === "abandoned" ? updatedAt : undefined,
    revision: current.revision + 1,
  };
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.changeSets, dbV7.syncMeta], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV7.practiceRuns.put(updated);
    await enqueueChangeSetV7([{ kind: "practice.run.status.changed", run: updated }], updatedAt);
  });
  return updated;
}

/** Remove the run projection without deleting global question learning stats. */
export async function deletePracticeRunV7(runId: string): Promise<boolean> {
  const current = await dbV7.practiceRuns.get(runId);
  if (!current) return false;
  const hasSubmittedAnswer = Object.values(current.answers).some((answer) => answer.submitted);
  const deletedAt = nowIso();
  const deviceId = getV7DeviceId();
  const eventId = makeV7Id("run-delete");
  const runDeleteSequence = await nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.tombstones, dbV7.changeSets], async () => {
    await updatePracticeRunStatsInTx(current, undefined);
    await dbV7.practiceRuns.delete(runId);
    if (!hasSubmittedAnswer) return;
    await dbV7.tombstones.put({
      key: tombstoneKey("practiceRun", runId), entityType: "practiceRun", entityId: runId,
      deletedAt, deviceId, eventId, sequence: runDeleteSequence,
    });
    await enqueueChangeSetV7([{ kind: "practice.run.deleted", runId, deletedAt }], deletedAt, { localSequence: runDeleteSequence });
  });
  return true;
}

async function autoCompleteRoundIfReadyInTx(roundId: string): Promise<void> {
  const round = await dbV7.reviewRounds.get(roundId);
  if (!round || round.status !== "active") return;
  const targets = await getReviewRoundQuestionIdsV7(roundId);
  if (!targets.length) return;
  const progress = await dbV7.reviewRoundProgress.where("roundId").equals(roundId).toArray();
  const done = new Set(progress.map((item) => item.questionId));
  if (targets.every((questionId) => done.has(questionId))) await completeRoundInTx(round, targets);
}

function addAttemptToStatsV7(current: AttemptStatsV7 | undefined, attempt: AttemptV7): AttemptStatsV7 {
  if (!current) {
    return {
      questionId: attempt.questionId,
      total: 1,
      correct: attempt.correct ? 1 : 0,
      wrong: attempt.correct ? 0 : 1,
      giveUps: attempt.selected ? 0 : 1,
      totalElapsedMs: Math.max(0, attempt.elapsedMs || 0),
      firstAttemptAt: attempt.createdAt,
      firstAttemptCorrect: attempt.correct,
      latestAttemptAt: attempt.createdAt,
      hasBeenWrong: !attempt.correct,
      correctStreakAfterWrong: 0,
      currentCorrectStreak: attempt.correct ? 1 : 0,
      recentOutcomes: [{ id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs || 0) }],
    };
  }
  const recentOutcomes = [...current.recentOutcomes, { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs || 0) }]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-32);
  let currentCorrectStreak = 0;
  for (let index = recentOutcomes.length - 1; index >= 0 && recentOutcomes[index].correct; index -= 1) currentCorrectStreak += 1;
  const first = attempt.createdAt < current.firstAttemptAt;
  return {
    ...current,
    total: current.total + 1,
    correct: current.correct + (attempt.correct ? 1 : 0),
    wrong: current.wrong + (attempt.correct ? 0 : 1),
    giveUps: current.giveUps + (attempt.selected ? 0 : 1),
    totalElapsedMs: current.totalElapsedMs + Math.max(0, attempt.elapsedMs || 0),
    firstAttemptAt: first ? attempt.createdAt : current.firstAttemptAt,
    firstAttemptCorrect: first ? attempt.correct : current.firstAttemptCorrect,
    latestAttemptAt: attempt.createdAt > current.latestAttemptAt ? attempt.createdAt : current.latestAttemptAt,
    hasBeenWrong: current.hasBeenWrong || !attempt.correct,
    correctStreakAfterWrong: (current.hasBeenWrong || !attempt.correct) ? currentCorrectStreak : 0,
    currentCorrectStreak,
    recentOutcomes,
  };
}

/** 一次性迁移：从原始 attempts 重建全部 attemptStats 行（为 recentOutcomes 补
 *  作答时间，难度 v2 需要）。attemptStats 是纯派生数据，重建幂等且无损。 */
export async function rebuildAttemptStatsFromAttemptsV7() {
  const attempts = await dbV7.attempts.toArray();
  const grouped = new Map<string, AttemptV7[]>();
  for (const attempt of attempts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const bucket = grouped.get(attempt.questionId);
    if (bucket) bucket.push(attempt);
    else grouped.set(attempt.questionId, [attempt]);
  }
  const rows: AttemptStatsV7[] = [];
  for (const bucket of grouped.values()) {
    let row: AttemptStatsV7 | undefined;
    for (const attempt of bucket) row = addAttemptToStatsV7(row, attempt);
    if (row) rows.push(row);
  }
  if (rows.length) await dbV7.attemptStats.bulkPut(rows);
}

function addDailyStatsV7(current: AttemptDailyStatsV7 | undefined, attempt: AttemptV7): AttemptDailyStatsV7 {
  return {
    key: dailyStatsKey(attempt.createdAt, attempt.questionId),
    date: datePart(attempt.createdAt),
    questionId: attempt.questionId,
    total: (current?.total ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    giveUps: (current?.giveUps ?? 0) + (attempt.selected ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs || 0),
  };
}

async function progressForAnswerInTx(roundId: string, questionId: string, attempt: AttemptV7): Promise<void> {
  const key = `${roundId}:${questionId}`;
  const current = await dbV7.reviewRoundProgress.get(key);
  const recentOutcomes = [...(current?.recentOutcomes ?? []), { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct, elapsedMs: Math.max(0, attempt.elapsedMs || 0) }]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-32);
  let currentCorrectStreak = 0;
  for (let index = recentOutcomes.length - 1; index >= 0 && recentOutcomes[index].correct; index -= 1) currentCorrectStreak += 1;
  const first = !current || attempt.createdAt < current.firstAttemptAt;
  const hasBeenWrong = Boolean(current?.hasBeenWrong ?? ((current?.wrong ?? 0) > 0)) || !attempt.correct;
  const progress: ReviewRoundProgress = {
    key,
    roundId,
    questionId,
    attempts: (current?.attempts ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    firstAttemptAt: first ? attempt.createdAt : current.firstAttemptAt,
    latestAttemptAt: attempt.createdAt > (current?.latestAttemptAt ?? "") ? attempt.createdAt : (current?.latestAttemptAt ?? attempt.createdAt),
    giveUps: (current?.giveUps ?? 0) + (attempt.selected ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs || 0),
    firstAttemptCorrect: first ? attempt.correct : current.firstAttemptCorrect,
    hasBeenWrong,
    currentCorrectStreak,
    correctStreakAfterWrong: hasBeenWrong ? currentCorrectStreak : 0,
    recentOutcomes,
  };
  await dbV7.reviewRoundProgress.put(progress);
}

/**
 * Submit one answer.  All local projections and the optional round progress
 * are committed in one transaction and exactly one domain event is emitted.
 */
export async function recordPracticeAnswerV7(input: PracticeAnswerInputV7): Promise<{ attempt: AttemptV7; answer: PracticeAnswerV7 }> {
  const selected = uniqueStrings(Array.isArray(input.selected) ? [...input.selected] : [input.selected]);
  const timestamp = input.createdAt ?? nowIso();
  const selectedAnswer = selected.join("");
  return dbV7.transaction("rw", [
    dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.practiceRuns,
    dbV7.practiceRunStats, dbV7.reviewRounds, dbV7.reviewRoundProgress,
    dbV7.questions, dbV7.bankQuestionMemberships, dbV7.changeSets, dbV7.syncMeta,
  ], async () => {
    // Re-read the authoritative run after the write transaction has acquired
    // its lock. Two answers submitted concurrently must merge their answers
    // and increment revision from the same serial order; using a snapshot read
    // before this transaction let the later writer erase the earlier answer.
    const run = await dbV7.practiceRuns.get(input.runId);
    if (!run) throw new Error("练习记录不存在或已被删除。");
    if (!run.questionIds.includes(input.questionId)) throw new Error("练习记录不包含当前题目。");
    if (input.reviewRoundId !== undefined && input.reviewRoundId !== run.reviewRoundId) {
      throw new Error("reviewRoundId 必须与练习记录绑定的 active 复习轮次一致。");
    }
    const reviewRoundId = run.reviewRoundId;
    if (reviewRoundId) {
      const round = await dbV7.reviewRounds.get(reviewRoundId);
      if (!round || round.status !== "active") throw new Error("reviewRoundId 必须匹配 active 复习轮次。");
      const targetIds = await getReviewRoundQuestionIdsV7(reviewRoundId);
      if (!targetIds.includes(input.questionId)) throw new Error("当前题目不属于 active 复习轮次。");
      if (run.reviewRoundId && run.reviewRoundId !== reviewRoundId) throw new Error("reviewRoundId 与练习记录不匹配。");
    }
    const deviceId = getV7DeviceId();
    const eventId = makeV7Id("answer");
    const sourceBankId = input.sourceBankId ?? input.bankId ?? run.bankIds[0];
    const attempt: AttemptV7 = {
      id: makeV7Id("attempt"),
      runId: input.runId,
      questionId: input.questionId,
      selected: selectedAnswer,
      correct: Boolean(input.correct),
      elapsedMs: Math.max(0, Number(input.elapsedMs) || 0),
      createdAt: timestamp,
      deviceId,
      ...(sourceBankId ? { sourceBankId } : {}),
    };
    const answer: PracticeAnswerV7 = {
      selected,
      submitted: true,
      correct: Boolean(input.correct),
      updatedAt: timestamp,
      deviceId,
      eventId,
    };
    const answers = { ...run.answers, [input.questionId]: answer };
    const lastSubmittedIndex = run.questionIds.reduce(
      (last, questionId, index) => answers[questionId]?.submitted ? index : last,
      -1,
    );
    const nextRun: PracticeRunV7 = {
      ...run,
      answers,
      updatedAt: timestamp,
      revision: run.revision + 1,
      lastAnsweredIndex: lastSubmittedIndex >= 0 ? lastSubmittedIndex : run.lastAnsweredIndex,
    };
    await dbV7.attempts.put(attempt);
    await dbV7.attemptStats.put(addAttemptToStatsV7(await dbV7.attemptStats.get(input.questionId), attempt));
    const key = dailyStatsKey(timestamp, input.questionId);
    await dbV7.attemptDailyStats.put(addDailyStatsV7(await dbV7.attemptDailyStats.get(key), attempt));
    await updatePracticeRunStatsInTx(run, nextRun);
    await dbV7.practiceRuns.put(nextRun);
    if (reviewRoundId) {
      await progressForAnswerInTx(reviewRoundId, input.questionId, attempt);
      await autoCompleteRoundIfReadyInTx(reviewRoundId);
    }
    const completedRound = reviewRoundId ? await dbV7.reviewRounds.get(reviewRoundId) : undefined;
    await enqueueChangeSetV7([
      { kind: "practice.answer.submitted", attempt, answer, runId: input.runId, questionId: input.questionId, ...(reviewRoundId ? { reviewRoundId } : {}) },
      ...(completedRound?.status === "completed" ? [{ kind: "review.round.completed" as const, round: completedRound }] : []),
    ], timestamp);
    return { attempt, answer };
  });
}
