import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listBankReadModels, studyDb } from "@/lib/db/db";
import { isBankEnabled } from "@/lib/db/types";
import { calendarDate } from "@/lib/practice/practice-metrics";
import { buildScopedQuestionStats, calculateProgressCompletion, normalizeProgressScope, progressScopeKey, progressScopeLabel, summarizeScopedQuestionStats } from "@/lib/practice/progress-scope";
import { syncApplication } from "@/lib/sync/sync-application";
import { latestInProgressPracticeRun } from "@/lib/db/practice-run-read";
import { listReviewRounds } from "@/lib/db/review-round-store";
import { loadSelectedBankIds, type PracticePreferences, type View } from "./helpers";
import { readDashboardScopedRows, summarizeDashboardLifetimeStats } from "./dashboard-read-data";
import { summarizeDashboardRows } from "./shell-controller-model";

type DashboardScopeProgress = { completed: number; total: number };
const scopeProgressCache = new Map<string, DashboardScopeProgress>();
const SCOPE_PROGRESS_CACHE_LIMIT = 24;

function rememberScopeProgress(key: string, progress: DashboardScopeProgress) {
  scopeProgressCache.delete(key);
  scopeProgressCache.set(key, progress);
  if (scopeProgressCache.size <= SCOPE_PROGRESS_CACHE_LIMIT) return;
  const oldestKey = scopeProgressCache.keys().next().value;
  if (oldestKey) scopeProgressCache.delete(oldestKey);
}

export function useDashboardData(view: View, preferences: PracticePreferences) {
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>(loadSelectedBankIds);
  const bankRows = useLiveQuery(
    async () => (await listBankReadModels()).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)),
    [],
  );
  const banks = bankRows ?? [];
  const enabledBanks = banks.filter(isBankEnabled);
  const activeBankIds = selectedBankIds.filter((id) => enabledBanks.some((bank) => bank.id === id));

  useEffect(() => {
    if (bankRows === undefined) return;
    const enabledIds = new Set(bankRows.filter(isBankEnabled).map((bank) => bank.id));
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSelectedBankIds((current) => {
        const next = current.filter((id) => enabledIds.has(id));
        if (next.length === current.length && next.every((id, index) => id === current[index])) return current;
        localStorage.setItem("study-current-banks", JSON.stringify(next));
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [bankRows]);

  const latestPracticeRunQuery = useLiveQuery(() => latestInProgressPracticeRun().then((run) => run ?? null), []);
  const latestPracticeRun = latestPracticeRunQuery ?? undefined;
  const latestPracticeRunLoaded = latestPracticeRunQuery !== undefined;

  const statsBaseQuery = useLiveQuery(async () => {
    if (view !== "home") return null;
    const today = calendarDate(new Date());
    const todayRows = await studyDb.questionDailyProgress.where("date").equals(today).toArray();
    const { todayAttempts, todayCorrect } = summarizeDashboardRows([], todayRows);
    return { todayAttempts, todayCorrect };
  }, [view]);
  const pendingCountQuery = useLiveQuery(() => syncApplication.pendingCount(), []);
  const stats = useMemo(() => {
    const base = statsBaseQuery ?? { todayAttempts: 0, todayCorrect: 0 };
    return { ...base, pending: pendingCountQuery ?? 0 };
  }, [statsBaseQuery, pendingCountQuery]);

  const reviewRounds = useLiveQuery(() => listReviewRounds(), []) ?? [];
  const normalizedProgressScope = normalizeProgressScope(preferences.progressScope);
  const selectedScopeLabel = normalizedProgressScope.type === "round"
    ? reviewRounds.find((round) => round.id === normalizedProgressScope.roundId)?.name || "当前复习轮次"
    : progressScopeLabel(normalizedProgressScope);
  const activeBankKey = activeBankIds.join("|");

  const scopeProgressCacheKey = `${[...activeBankIds].sort().join("|")}::${progressScopeKey(normalizedProgressScope)}`;
  const scopeProgressQuery = useLiveQuery(async () => {
    if (view !== "home" || !activeBankIds.length) return null;
    const memberships = await studyDb.bankQuestionMemberships.where("bankId").anyOf(activeBankIds).toArray();
    const questionIds = [...new Set(memberships.map((membership) => membership.questionId))];
    if (!questionIds.length) return { completed: 0, total: 0 };

    const referenceTime = Date.now();
    if (normalizedProgressScope.type === "round") {
      const roundProgress = await studyDb.reviewRoundProgress.where("roundId").equals(normalizedProgressScope.roundId).toArray();
      const completion = calculateProgressCompletion(questionIds, normalizedProgressScope, [], roundProgress, referenceTime);
      return { completed: completion.completed, total: completion.total };
    }

    const attemptStats = (await studyDb.questionProgress.bulkGet(questionIds)).filter((row) => row !== undefined);
    const completion = calculateProgressCompletion(questionIds, normalizedProgressScope, attemptStats, [], referenceTime);
    return { completed: completion.completed, total: completion.total };
  }, [view, activeBankKey, preferences.progressScope]);

  useEffect(() => {
    if (!scopeProgressQuery) return;
    rememberScopeProgress(scopeProgressCacheKey, scopeProgressQuery);
  }, [scopeProgressCacheKey, scopeProgressQuery]);

  const scopeProgress = scopeProgressQuery ?? scopeProgressCache.get(scopeProgressCacheKey);

  const scopeStatsQuery = useLiveQuery(async () => {
    const emptyStats = { questions: 0, attempts: 0, correct: 0, notes: 0, last: undefined as string | undefined, bankCount: 0 };
    if (view !== "home") return null;
    const questionIds = activeBankIds.length
      ? [...new Set((await studyDb.bankQuestionMemberships.where("bankId").anyOf(activeBankIds).toArray()).map((membership) => membership.questionId))]
      : await studyDb.questions.toCollection().primaryKeys();
    if (!questionIds.length) return { ...emptyStats, bankCount: activeBankIds.length || banks.length };

    const referenceTime = Date.now();
    const { attempts, attemptStats, roundProgress, notes } = await readDashboardScopedRows(
      questionIds,
      normalizedProgressScope,
      referenceTime,
      { allQuestions: activeBankIds.length === 0 },
    );
    const questionIdSet = new Set(questionIds);
    const summary = normalizedProgressScope.type === "lifetime"
      ? summarizeDashboardLifetimeStats(attemptStats)
      : summarizeScopedQuestionStats(buildScopedQuestionStats(questionIds, normalizedProgressScope, attempts, roundProgress, referenceTime));
    return {
      questions: questionIds.length,
      attempts: summary.attempts,
      correct: summary.correct,
      notes: notes.filter((note) => questionIdSet.has(note.questionId) && note.content.trim()).length,
      last: summary.lastAttemptAt,
      bankCount: activeBankIds.length || banks.length,
    };
  }, [view, activeBankKey, preferences.progressScope, banks.length]);
  const scopeStats = scopeStatsQuery ?? {
    questions: 0,
    attempts: 0,
    correct: 0,
    notes: 0,
    last: undefined,
    bankCount: activeBankIds.length || banks.length,
  };

  function selectBanks(bankIds: string[]) {
    const unique = [...new Set(bankIds)];
    setSelectedBankIds(unique);
    localStorage.setItem("study-current-banks", JSON.stringify(unique));
  }

  function toggleBank(bankId: string) {
    const next = activeBankIds.includes(bankId)
      ? activeBankIds.filter((id) => id !== bankId)
      : [...activeBankIds, bankId];
    selectBanks(next);
  }

  function resetSelectedBanks() {
    localStorage.removeItem("study-current-banks");
    setSelectedBankIds([]);
  }

  return {
    banks,
    enabledBanks,
    activeBankIds,
    latestPracticeRun,
    latestPracticeRunLoaded,
    stats,
    reviewRounds,
    selectedScopeLabel,
    scopeProgress,
    scopeStats,
    selectBanks,
    toggleBank,
    resetSelectedBanks,
  };
}
