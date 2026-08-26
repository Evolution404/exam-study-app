import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { dbV7, createPracticeRunV7, getV7DeviceId } from "@/lib/db/db-v7";
import { getQuestionViewV7, listQuestionViewsForBanksV7 } from "@/lib/db/app-data-v7";
import type { BankV7 } from "@/lib/db/v7-types";
import { statsNeedWrongReview } from "@/lib/practice/practice-metrics";
import { buildScopedQuestionStats, isQuestionDoneInScope, normalizeProgressScope, scopedStatsToAttemptStats } from "@/lib/practice/progress-scope";
import { toQuestionViewModel } from "@/app/bank/question-editor";
import type { SearchPracticeOptions } from "@/app/search/search-view";
import type { ActivePractice } from "@/types/types";
import {
  TYPE_ORDER,
  activePracticeFromRun,
  balancedRandomSample,
  deletePracticeRun,
  modeLabels,
  randomOptionOrder,
  savePracticeProgress,
  setPracticeRunStatus,
  shuffle,
  summarizeV7AttemptStats,
  type PracticeAnswerState,
  type PracticeFilter,
  type PracticePreferences,
  type PracticeRun,
  type View,
} from "./helpers";
import { removeDeletedQuestionFromSession } from "./shell-controller-model";

interface PracticeSessionControllerOptions {
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  enabledBanks: BankV7[];
  preferences: PracticePreferences;
  latestPracticeRun?: PracticeRun;
  selectBanks: (bankIds: string[]) => void;
  resultRunId?: string;
  setResultRunId: Dispatch<SetStateAction<string | undefined>>;
  setNotice: Dispatch<SetStateAction<string>>;
}

export function usePracticeSessionController({
  view,
  setView,
  enabledBanks,
  preferences,
  latestPracticeRun,
  selectBanks,
  resultRunId,
  setResultRunId,
  setNotice,
}: PracticeSessionControllerOptions) {
  const [practiceSession, setPracticeSession] = useState<ActivePractice | null>(null);
  const [practiceTransitionDirection, setPracticeTransitionDirection] = useState<1 | -1>(1);
  const [discardedRun, setDiscardedRun] = useState<PracticeRun | null>(null);
  const [finishPrompt, setFinishPrompt] = useState<number>();
  const practiceSessionRef = useRef(practiceSession);
  practiceSessionRef.current = practiceSession;

  function changeSession(mutator: (session: ActivePractice) => ActivePractice) {
    setPracticeSession((current) => {
      if (!current) return current;
      const changed = mutator(current);
      if (changed === current) return current;
      const next = { ...changed, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
      if (changed.answers !== current.answers) void savePracticeProgress(next);
      return next;
    });
  }

  const activeQuestionId = practiceSession?.questionIds[practiceSession.currentIndex];
  const activeQuestion = useLiveQuery(async () => {
    if (!activeQuestionId) return undefined;
    const questionView = await getQuestionViewV7(activeQuestionId, practiceSession?.bankId);
    if (!questionView) return null;
    const bank = questionView.banks.find((item) => item.id === questionView.sourceBankId) ?? questionView.banks[0];
    const membership = questionView.memberships.find((item) => item.bankId === questionView.sourceBankId) ?? questionView.memberships[0];
    return toQuestionViewModel(
      questionView.question,
      questionView.sourceBankId ?? "",
      bank?.displayName || bank?.name || "未归档题目",
      membership?.sortOrder ?? 0,
    );
  }, [activeQuestionId, practiceSession?.bankId]);

  useEffect(() => {
    if (view !== "practice" || !practiceSession || activeQuestion !== null || !activeQuestionId) return;
    const deletedId = activeQuestionId;
    const survivors = practiceSession.questionIds.filter((id) => id !== deletedId);
    let cancelled = false;
    void (async () => {
      const stillExists = await getQuestionViewV7(deletedId, practiceSession.bankId);
      if (cancelled || stillExists) return;
      if (!survivors.length) {
        setNotice("练习中的题目已被删除，本次练习结束");
        const answers = Object.fromEntries(Object.entries(practiceSession.answers).filter(([id]) => id !== deletedId));
        const runId = practiceSession.runId;
        setPracticeSession(null);
        void setPracticeRunStatus(runId, "completed", answers).then(() => {
          setResultRunId(runId);
          setFinishPrompt(undefined);
          setView("practiceResult");
        });
        return;
      }
      changeSession((session) => removeDeletedQuestionFromSession(session, deletedId));
      setNotice("题目已删除，自动跳过");
    })();
    return () => { cancelled = true; };
  }, [activeQuestion, activeQuestionId, practiceSession, setNotice, setResultRunId, setView, view]);

  const activeRunExists = useLiveQuery(async () => {
    if (!practiceSession) return undefined;
    return Boolean(await dbV7.practiceRuns.get(practiceSession.runId));
  }, [practiceSession?.runId]);
  useEffect(() => {
    if (view !== "practice" || !practiceSession || activeRunExists !== false) return;
    queueMicrotask(() => {
      setPracticeSession(null);
      setView("home");
      setNotice("本次练习对应的题库已被删除，练习已结束");
    });
  }, [activeRunExists, practiceSession, setNotice, setView, view]);

  async function discardSavedPractice(runId: string) {
    const run = await dbV7.practiceRuns.get(runId);
    if (!run || run.status !== "in_progress") return;
    setDiscardedRun(run);
    await setPracticeRunStatus(run.id, "abandoned", run.answers);
    if (practiceSession?.runId === run.id) setPracticeSession(null);
    setNotice("已放弃上次练习");
  }

  async function undoDiscardPractice() {
    if (!discardedRun) return;
    await setPracticeRunStatus(discardedRun.id, "in_progress", discardedRun.answers);
    setDiscardedRun(null);
    setNotice("已恢复上次练习");
  }

  async function refreshActivePracticeAfterSync() {
    const session = practiceSessionRef.current;
    if (!session) return;
    const run = await dbV7.practiceRuns.get(session.runId);
    if (!run) return;
    if (run.status !== "in_progress") {
      setPracticeSession(null);
      if (run.status === "completed") {
        setResultRunId(run.id);
        setView("practiceResult");
        setNotice("本次练习已在其他设备完成，已切换到结果页");
      } else {
        setView("home");
        setNotice("本次练习已在其他设备被放弃，练习已结束");
      }
      return;
    }
    const incoming = run.questionIds.filter((id) => run.answers[id]?.submitted && !session.answers[id]?.submitted);
    if (!incoming.length) {
      setPracticeSession(activePracticeFromRun(run, session.currentIndex));
      return;
    }
    let lastAnsweredIndex = -1;
    run.questionIds.forEach((id, index) => { if (run.answers[id]?.submitted) lastAnsweredIndex = index; });
    setPracticeTransitionDirection(lastAnsweredIndex >= session.currentIndex ? 1 : -1);
    setPracticeSession(activePracticeFromRun(run, Math.max(0, lastAnsweredIndex)));
    setNotice(`已同步本练习 ${incoming.length} 道新作答，切换到最后一道做完的题`);
  }

  async function startPractice(filter: PracticeFilter) {
    let requestedBankIds = [...new Set(filter.bankIds)];
    if (filter.reviewRoundId) {
      const round = await dbV7.reviewRounds.get(filter.reviewRoundId);
      if (!round || round.status !== "active") {
        setNotice("这条复习轮次已不存在或已结束，请重新选择。");
        return;
      }
      requestedBankIds = [...new Set(round.bankIds)];
    }
    requestedBankIds = requestedBankIds.filter((id) => enabledBanks.some((bank) => bank.id === id));
    const practiceBanks = enabledBanks.filter((item) => requestedBankIds.includes(item.id));
    if (!practiceBanks.length) {
      setNotice("请先选择一个题库");
      return;
    }
    let questions = (await listQuestionViewsForBanksV7(requestedBankIds)).map((questionView) => {
      const bank = questionView.banks.find((item) => item.id === questionView.sourceBankId) ?? questionView.banks[0];
      const membership = questionView.memberships.find((item) => item.bankId === questionView.sourceBankId) ?? questionView.memberships[0];
      return toQuestionViewModel(questionView.question, questionView.sourceBankId ?? "", bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0);
    });
    questions = questions.filter((question) => filter.types.includes(question.type));
    if (filter.tags.length) questions = questions.filter((question) => filter.tagMatch === "all"
      ? filter.tags.every((tag) => question.tags.includes(tag))
      : filter.tags.some((tag) => question.tags.includes(tag)));
    if (filter.keyword.trim()) {
      const keyword = filter.keyword.trim();
      let pattern: RegExp | null = null;
      if (filter.keywordMode === "regex") {
        try { pattern = new RegExp(keyword, "i"); } catch { setNotice("正则表达式格式不正确，请检查后重试"); return; }
      }
      questions = questions.filter((question) => {
        const searchable = [question.stem, ...question.options, ...question.tags].join("\n");
        return pattern ? pattern.test(searchable) : searchable.toLocaleLowerCase("zh-CN").includes(keyword.toLocaleLowerCase("zh-CN"));
      });
    }
    const [statsRows, roundProgress, attemptRows] = await Promise.all([dbV7.attemptStats.toArray(), dbV7.reviewRoundProgress.toArray(), dbV7.attempts.toArray()]);
    const attemptMetrics = new Map(statsRows.map((stats) => [stats.questionId, summarizeV7AttemptStats(stats)]));
    const progressScope = normalizeProgressScope(filter.progressScope ?? preferences.progressScope);
    const lastAttemptFrom = filter.lastAttemptFrom ? new Date(`${filter.lastAttemptFrom}T00:00:00`).getTime() : null;
    const lastAttemptTo = filter.lastAttemptTo ? new Date(`${filter.lastAttemptTo}T23:59:59.999`).getTime() : null;
    const scopedWrongStats = filter.status === "wrong"
      ? buildScopedQuestionStats(questions.map((question) => question.id), progressScope, attemptRows, roundProgress, Date.now())
      : null;
    questions = questions.filter((question) => {
      const metric = attemptMetrics.get(question.id) ?? summarizeV7AttemptStats();
      const doneInScope = isQuestionDoneInScope(question.id, progressScope, statsRows, roundProgress, Date.now());
      if (filter.status === "unanswered" && doneInScope) return false;
      if (filter.status === "wrong") {
        const scoped = scopedWrongStats?.get(question.id);
        if (!statsNeedWrongReview(scoped ? scopedStatsToAttemptStats(scoped) : undefined, preferences.wrongRemovalStreak)) return false;
      }
      if (filter.status === "favorite" && !question.favorite) return false;
      if (filter.totalAttemptsMin !== null && metric.total < filter.totalAttemptsMin) return false;
      if (filter.totalAttemptsMax !== null && metric.total > filter.totalAttemptsMax) return false;
      if (filter.wrongAttemptsMin !== null && metric.wrong < filter.wrongAttemptsMin) return false;
      if (filter.wrongAttemptsMax !== null && metric.wrong > filter.wrongAttemptsMax) return false;
      if (filter.difficultyMin !== null && metric.difficulty < filter.difficultyMin) return false;
      if (filter.difficultyMax !== null && metric.difficulty > filter.difficultyMax) return false;
      if ((lastAttemptFrom !== null || lastAttemptTo !== null) && metric.latest === null) return false;
      if (lastAttemptFrom !== null && metric.latest !== null && metric.latest < lastAttemptFrom) return false;
      if (lastAttemptTo !== null && metric.latest !== null && metric.latest > lastAttemptTo) return false;
      return true;
    });
    let limitApplied = false;
    if (filter.order === "random") {
      if (filter.limit) {
        questions = preferences.randomTypeBalance === "balanced"
          ? balancedRandomSample(questions, filter.limit)
          : shuffle(questions).slice(0, filter.limit);
        limitApplied = true;
      } else questions = shuffle(questions);
    }
    questions = TYPE_ORDER.flatMap((type) => {
      const group = questions.filter((question) => question.type === type);
      if (filter.order === "random") return shuffle(group);
      if (filter.order === "difficulty") return group.sort((a, b) => {
        const left = attemptMetrics.get(a.id);
        const right = attemptMetrics.get(b.id);
        return (right?.reviewPriority ?? 50) - (left?.reviewPriority ?? 50)
          || (right?.personalDifficulty ?? 50) - (left?.personalDifficulty ?? 50)
          || a.id.localeCompare(b.id);
      });
      return group;
    });
    if (filter.limit && !limitApplied) questions = questions.slice(0, filter.limit);
    if (!questions.length) {
      setNotice("没有符合当前条件的题目，请调整筛选条件");
      return;
    }
    const now = new Date().toISOString();
    const run = await createPracticeRunV7({
      bankId: practiceBanks[0].id,
      bankIds: requestedBankIds,
      bankName: practiceBanks.length === 1 ? (practiceBanks[0].displayName || practiceBanks[0].name) : `${practiceBanks.length} 个题库组合`,
      mode: filter.mode,
      modeLabel: filter.modeLabel ?? (filter.mode === "random30" || filter.mode === "randomCustom" ? `随机 ${filter.limit ?? preferences.groupSize} 题` : modeLabels[filter.mode]),
      questionIds: questions.map((question) => question.id),
      questionTypes: Object.fromEntries(questions.map((question) => [question.id, question.type])),
      shuffleOptions: preferences.shuffleOptions,
      optionOrders: preferences.shuffleOptions ? Object.fromEntries(questions.map((question) => [question.id, randomOptionOrder(question)])) : {},
      startedAt: now,
      updatedAt: now,
      revision: 1,
      ...(filter.reviewRoundId ? { reviewRoundId: filter.reviewRoundId } : {}),
    });
    setPracticeSession(activePracticeFromRun(run, 0));
    setView("practice");
  }

  async function startSearchPractice({ questions, label, shuffleOptions }: SearchPracticeOptions, questionId?: string, avoidOptionOrders?: Record<string, number[]>) {
    const enabledBankIds = new Set(enabledBanks.map((bank) => bank.id));
    const uniqueQuestions = [...new Map(questions.filter((question) => enabledBankIds.has(question.bankId)).map((question) => [question.id, question])).values()];
    const orderedQuestions = TYPE_ORDER.flatMap((type) => uniqueQuestions.filter((question) => question.type === type));
    const practiceBanks = enabledBanks.filter((bank) => orderedQuestions.some((question) => question.bankId === bank.id));
    if (!orderedQuestions.length || !practiceBanks.length) return;
    const now = new Date().toISOString();
    const run = await createPracticeRunV7({
      bankId: practiceBanks[0].id,
      bankIds: practiceBanks.map((bank) => bank.id),
      bankName: practiceBanks.length === 1 ? (practiceBanks[0].displayName || practiceBanks[0].name) : `${practiceBanks.length} 个题库组合`,
      mode: "advanced",
      modeLabel: label,
      questionIds: orderedQuestions.map((question) => question.id),
      questionTypes: Object.fromEntries(orderedQuestions.map((question) => [question.id, question.type])),
      shuffleOptions,
      optionOrders: shuffleOptions ? Object.fromEntries(orderedQuestions.map((question) => [question.id, randomOptionOrder(question, avoidOptionOrders?.[question.id])])) : {},
      startedAt: now,
      updatedAt: now,
      revision: 1,
    });
    setPracticeSession(activePracticeFromRun(run, Math.max(0, orderedQuestions.findIndex((question) => question.id === questionId))));
    setView("practice");
  }

  async function resumePractice(runId?: string, preferredIndex?: number) {
    const run = runId ? await dbV7.practiceRuns.get(runId) : latestPracticeRun;
    if (!run || run.status !== "in_progress" || !run.questionIds.length) {
      setNotice("没有可以继续的练习记录");
      return;
    }
    let session = activePracticeFromRun(run, preferredIndex);
    if (!session.questionTypes || Object.keys(session.questionTypes).length !== session.questionIds.length) {
      const questions = await dbV7.questions.bulkGet(session.questionIds);
      session = {
        ...session,
        questionTypes: Object.fromEntries(questions.filter(Boolean).map((question) => [question!.id, question!.type])),
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
      };
      await savePracticeProgress(session);
    }
    setPracticeSession(session);
    selectBanks(session.bankIds?.length ? session.bankIds : [session.bankId]);
    setView("practice");
  }

  async function abandonHistoryRun(runId: string) {
    const run = await dbV7.practiceRuns.get(runId);
    if (!run || run.status !== "in_progress") return;
    await setPracticeRunStatus(runId, "abandoned", run.answers);
    if (practiceSession?.runId === runId) setPracticeSession(null);
    setNotice("已放弃这次练习，记录仍会保留");
  }

  async function removeHistoryRun(runId: string) {
    const removed = await deletePracticeRun(runId);
    if (!removed) return;
    if (practiceSession?.runId === runId) setPracticeSession(null);
    if (resultRunId === runId) setResultRunId(undefined);
    setNotice("练习记录已删除，并加入同步队列");
  }

  function movePractice(offset: number) {
    setPracticeTransitionDirection(offset < 0 ? -1 : 1);
    changeSession((session) => {
      const nextIndex = session.currentIndex + offset;
      if (nextIndex >= session.questionIds.length) {
        setNotice("已到最后一题，可以回顾或查看本次结果");
        return session;
      }
      if (nextIndex < 0) return session;
      return { ...session, currentIndex: nextIndex };
    });
  }

  async function finishPractice() {
    if (!practiceSession) return;
    const answered = Object.values(practiceSession.answers).filter((answer) => answer.submitted).length;
    if (answered < practiceSession.questionIds.length && preferences.requireAllAnswered) {
      const firstUnanswered = practiceSession.questionIds.findIndex((id) => !practiceSession.answers[id]?.submitted);
      if (firstUnanswered >= 0) jumpPractice(firstUnanswered);
      setNotice(`还有 ${practiceSession.questionIds.length - answered} 道题未作答，已定位到第一道未答题`);
      return;
    }
    if (answered < practiceSession.questionIds.length) {
      setFinishPrompt(practiceSession.questionIds.length - answered);
      return;
    }
    await completePractice();
  }

  async function completePractice() {
    if (!practiceSession) return;
    await setPracticeRunStatus(practiceSession.runId, "completed", practiceSession.answers);
    setResultRunId(practiceSession.runId);
    setFinishPrompt(undefined);
    setView("practiceResult");
  }

  function saveAnswerState(questionId: string, answerState: PracticeAnswerState) {
    const stamped = { ...answerState, updatedAt: new Date().toISOString(), deviceId: getV7DeviceId(), eventId: crypto.randomUUID() };
    changeSession((session) => ({
      ...session,
      answers: { ...session.answers, [questionId]: stamped },
      lastAnsweredIndex: stamped.submitted ? session.questionIds.indexOf(questionId) : session.lastAnsweredIndex,
    }));
  }

  function jumpPractice(index: number) {
    if (!practiceSession || index < 0 || index >= practiceSession.questionIds.length) return;
    setPracticeTransitionDirection(index < practiceSession.currentIndex ? -1 : 1);
    changeSession((session) => ({ ...session, currentIndex: index }));
  }

  function exitPractice() {
    setPracticeSession(null);
    setView("home");
  }

  function resetAfterRestore() {
    setPracticeSession(null);
    setDiscardedRun(null);
    setFinishPrompt(undefined);
  }

  return {
    practiceSession,
    practiceTransitionDirection,
    discardedRun,
    finishPrompt,
    setFinishPrompt,
    activeQuestion,
    discardSavedPractice,
    undoDiscardPractice,
    refreshActivePracticeAfterSync,
    startPractice,
    startSearchPractice,
    resumePractice,
    abandonHistoryRun,
    removeHistoryRun,
    movePractice,
    finishPractice,
    completePractice,
    saveAnswerState,
    jumpPractice,
    exitPractice,
    resetAfterRestore,
  };
}
