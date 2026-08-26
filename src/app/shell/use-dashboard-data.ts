import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { dbV7 } from "@/lib/db/db-v7";
import { listQuestionViewsForBanksV7 } from "@/lib/db/app-data-v7";
import { isBankEnabled } from "@/lib/db/v7-types";
import { calendarDate } from "@/lib/practice/practice-metrics";
import { buildScopedQuestionStats, calculateProgressCompletion, normalizeProgressScope, progressScopeLabel, summarizeScopedQuestionStats } from "@/lib/practice/progress-scope";
import { syncApplication } from "@/lib/sync/sync-application";
import { loadSelectedBankIds, type PracticePreferences, type View } from "./helpers";
import { summarizeDashboardRows } from "./shell-controller-model";

export function useDashboardData(view: View, preferences: PracticePreferences) {
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>(loadSelectedBankIds);
  const bankRows = useLiveQuery(
    async () => (await dbV7.banks.toArray()).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)),
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

  const latestPracticeRun = useLiveQuery(async () => {
    return dbV7.practiceRuns.where("status").equals("in_progress").sortBy("updatedAt").then((runs) => runs.at(-1));
  }, []);

  const statsBaseQuery = useLiveQuery(async () => {
    const today = calendarDate(new Date());
    const [questions, attemptStats, todayRows, notes] = await Promise.all([
      dbV7.questions.count(),
      dbV7.attemptStats.toArray(),
      dbV7.attemptDailyStats.where("date").equals(today).toArray(),
      dbV7.notes.count(),
    ]);
    return {
      questions,
      ...summarizeDashboardRows(attemptStats, todayRows),
      notes,
    };
  }, []);
  const pendingCountQuery = useLiveQuery(() => syncApplication.pendingCount(), []);
  const stats = useMemo(() => {
    const base = statsBaseQuery ?? { questions: 0, attempts: 0, correct: 0, todayAttempts: 0, todayCorrect: 0, notes: 0, last: undefined };
    return { ...base, pending: pendingCountQuery ?? 0 };
  }, [statsBaseQuery, pendingCountQuery]);

  const reviewRounds = useLiveQuery(() => dbV7.reviewRounds.orderBy("updatedAt").reverse().toArray(), []) ?? [];
  const normalizedProgressScope = normalizeProgressScope(preferences.progressScope);
  const selectedScopeLabel = normalizedProgressScope.type === "round"
    ? reviewRounds.find((round) => round.id === normalizedProgressScope.roundId)?.name || "当前复习轮次"
    : progressScopeLabel(normalizedProgressScope);
  const activeBankKey = activeBankIds.join("|");

  const scopeProgress = useLiveQuery(async () => {
    if (view !== "home") return { completed: 0, total: 0 };
    if (!activeBankIds.length) return { completed: 0, total: 0 };
    const [questions, attemptStats, roundProgress] = await Promise.all([
      listQuestionViewsForBanksV7(activeBankIds),
      dbV7.attemptStats.toArray(),
      dbV7.reviewRoundProgress.toArray(),
    ]);
    const ids = [...new Set(questions.map((questionView) => questionView.question.id))];
    const completion = calculateProgressCompletion(ids, normalizeProgressScope(preferences.progressScope), attemptStats, roundProgress, Date.now());
    return { completed: completion.completed, total: completion.total };
  }, [view, activeBankKey, preferences.progressScope]) ?? { completed: 0, total: 0 };

  const scopeStats = useLiveQuery(async () => {
    if (view !== "home") return { questions: 0, attempts: 0, correct: 0, notes: 0, last: undefined, bankCount: 0 };
    const questionIds = activeBankIds.length
      ? [...new Set((await dbV7.bankQuestionMemberships.where("bankId").anyOf(activeBankIds).toArray()).map((membership) => membership.questionId))]
      : await dbV7.questions.toCollection().primaryKeys();
    const [attempts, roundProgress, notes] = await Promise.all([
      dbV7.attempts.toArray(),
      dbV7.reviewRoundProgress.toArray(),
      dbV7.notes.toArray(),
    ]);
    const questionIdSet = new Set(questionIds);
    const summary = summarizeScopedQuestionStats(buildScopedQuestionStats(questionIds, normalizedProgressScope, attempts, roundProgress, Date.now()));
    return {
      questions: questionIds.length,
      attempts: summary.attempts,
      correct: summary.correct,
      notes: notes.filter((note) => questionIdSet.has(note.questionId) && note.content.trim()).length,
      last: summary.lastAttemptAt,
      bankCount: activeBankIds.length || banks.length,
    };
  }, [view, activeBankKey, preferences.progressScope, banks.length]) ?? {
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
