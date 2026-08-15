"use client";

import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen, Brain, Check, CheckCheck, ChevronLeft, ChevronRight, ClipboardCheck, Cloud, Copy,
  BadgeInfo, CircleHelp, FileUp, Grid3X3, Home, Library, Link2, ListFilter,
  LoaderCircle, Menu, Monitor, Moon, NotebookPen, Pencil, Play, RefreshCw,
  Settings2, Sparkles, Star, Sun, Target, X,
} from "lucide-react";
import { archiveReviewRoundV6, clearImageCacheV6, completeReviewRoundV6, createReviewRoundV6, dbV6, deletePracticeRunV6, getImageCacheSizeV6, getV6DeviceId, createPracticeRunV6, recordPracticeAnswerV6, saveNoteV6, savePracticeProgressV6, setPracticeRunStatusV6, toggleQuestionFavoriteV6, updateReviewRoundV6 } from "@/lib/db-v6";
import { getQuestionViewV6, listQuestionViewsForBanksV6 } from "@/lib/app-data-v6";
import { resumeIndexAfterLastAnswer } from "@/lib/practice-resume";
import type { SyncProgress } from "@/lib/github-sync";
import { loadGitHubSettings, loadGitHubToken, saveGitHubSettings } from "@/lib/github-credentials";
import { calendarDate, difficultyLabel, difficultyTone, statsNeedWrongReview, summarizeAttemptStats } from "@/lib/practice-metrics";
import { SharedQuestionEditor, loadImageAssetV6, toQuestionViewModel, type QuestionViewModel } from "@/app/question-editor";
import type { SearchPracticeOptions } from "@/app/search-view";
import type { BankQuickMode } from "@/app/bank-library-view";
import { useSmoothProgress } from "@/app/use-smooth-progress";
import { NoteMarkdown } from "@/app/note-markdown";
import { QuickSearch } from "@/app/quick-search";
import { ContentBlockRenderer } from "@/app/content-block-renderer";
import { ProgressScopeSetting } from "@/app/progress-scope-setting";
import { ReviewRoundManager } from "@/app/review-round-manager";
import { ShortcutSetting } from "@/app/shortcut-setting";
import { ConfirmDialog } from "@/app/confirm-dialog";
import { ModalPortal } from "@/app/modal-portal";
import { AppSelect } from "@/app/app-select";
import { ScopeSummaryChips } from "@/app/scope-summary-chips";
import { useAppTheme, useAppViewport } from "@/app/hooks/use-app-environment";
import { DEFAULT_KEYBOARD_SHORTCUTS, formatKeyboardShortcut, normalizeKeyboardShortcuts, resolveKeyboardShortcut, type KeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { classifyPressIntent, QUICK_RESTORE_HOLD_MS } from "@/lib/press-intent";
import { shouldSubmitOnChoice } from "@/lib/answer-submission";
import { isCalculationAnswerCorrect } from "@/lib/question-utils";
import type { ActivePractice, GitHubSettings } from "@/lib/types";
import type { AttemptStatsV6, BankV6, PracticeRunV6, QuestionTypeV6, ReviewRound } from "@/lib/v6-types";
import type { V6PracticeFilter } from "@/app/practice-setup";
import type { ProgressScope } from "@/lib/progress-scope";
import { buildScopedQuestionStats, calculateProgressCompletion, normalizeProgressScope, isQuestionDoneInScope, progressScopeLabel, summarizeScopedQuestionStats } from "@/lib/progress-scope";
import { classifyNoticeTone } from "@/lib/notice-tone";
import { questionOverviewProgress } from "@/lib/question-overview";
import { importQuestionBankFile, QUESTION_BANK_FILE_ACCEPT } from "@/lib/question-bank-file-import";
import { SyncEventDrawer } from "@/app/sync-event-drawer";
import type { SyncChangeSetItemV7 } from "@/app/sync-event-manager";
import { dependentChangeSetIdsV7 } from "@/lib/change-set-v7";
import { discardManagedChangeSetV7, ensureChangeSetQueueBaseV7 } from "@/lib/change-set-v7-queue";

type Question = QuestionViewModel;
type QuestionType = QuestionTypeV6;
type PracticeFilter = V6PracticeFilter;
type PracticeRun = PracticeRunV6;
type PracticeAnswerState = PracticeRunV6["answers"][string];
type AttemptStats = AttemptStatsV6 & { bankId: string };

function toLegacyAttemptStats(stats?: AttemptStatsV6, bankId = ""): AttemptStats | undefined {
  return stats ? { ...stats, bankId } : undefined;
}

function summarizeV6AttemptStats(stats?: AttemptStatsV6) {
  return summarizeAttemptStats(toLegacyAttemptStats(stats));
}

async function saveNote(questionId: string, content: string) { return saveNoteV6(questionId, content); }
async function toggleQuestionFavorite(questionId: string) { return toggleQuestionFavoriteV6(questionId); }
async function recordPracticeAnswer(input: { runId: string; questionId: string; bankId?: string; selected: string | string[]; correct: boolean; elapsedMs?: number; reviewRoundId?: string }) { return recordPracticeAnswerV6({ ...input, sourceBankId: input.bankId }); }
async function savePracticeProgress(session: ActivePractice) { const current = await dbV6.practiceRuns.get(session.runId); if (!current) return; return savePracticeProgressV6({ ...current, answers: session.answers, lastAnsweredIndex: session.lastAnsweredIndex, updatedAt: session.updatedAt, revision: session.revision }); }
async function setPracticeRunStatus(runId: string, status: PracticeRunV6["status"], answers?: PracticeRun["answers"]) { return setPracticeRunStatusV6(runId, status, answers); }
async function deletePracticeRun(runId: string) { return deletePracticeRunV6(runId); }

const PracticeSetupView = lazy(() => import("@/app/practice-setup").then((module) => ({ default: module.PracticeSetupView })));
const SearchView = lazy(() => import("@/app/search-view").then((module) => ({ default: module.SearchView })));
const BankLibraryView = lazy(() => import("@/app/bank-library-view").then((module) => ({ default: module.BankLibraryView })));
const KnowledgeView = lazy(() => import("@/app/knowledge-view").then((module) => ({ default: module.KnowledgeView })));
const SyncView = lazy(() => import("@/app/sync-view").then((module) => ({ default: module.SyncView })));
const LatestPracticeBanner = lazy(() => import("@/app/practice-history").then((module) => ({ default: module.LatestPracticeBanner })));
const PracticeHistory = lazy(() => import("@/app/practice-history").then((module) => ({ default: module.PracticeHistory })));
const PracticeRunResult = lazy(() => import("@/app/practice-history").then((module) => ({ default: module.PracticeRunResult })));

type View = "home" | "banks" | "relations" | "practiceSetup" | "preferences" | "settings" | "search" | "practice" | "practiceResult";

const SCROLL_RESTORABLE_VIEWS: View[] = ["home", "banks", "relations", "practiceSetup", "preferences", "settings", "search"];

interface PracticePreferences {
  submitOnSelect: boolean;
  autoNextCorrect: boolean;
  autoNextDelayMs: 0 | 500 | 1000 | 2000;
  showAnswerOnWrong: boolean;
  swipeNavigation: boolean;
  questionTransition: "instant" | "slide";
  shuffleOptions: boolean;
  multiSelectAllAutoSubmit: boolean;
  randomTypeBalance: "natural" | "balanced";
  wrongReappearance: "immediate" | "end" | "next";
  defaultOrder: PracticeFilter["order"];
  fontSize: "small" | "standard" | "large" | "xlarge";
  requireAllAnswered: boolean;
  feedbackSound: boolean;
  feedbackHaptics: boolean;
  dailyGoalCount: number;
  dailyGoalAccuracy: number;
  wrongRemovalStreak: number;
  groupSize: number;
  themeMode: "system" | "light" | "dark";
  keyboardShortcuts: KeyboardShortcuts;
  autoSyncEnabled: boolean;
  autoSyncEventThreshold: number;
  periodicPullEnabled: boolean;
  periodicPullSeconds: number;
  calculationTolerancePercent: number;
  progressScope: ProgressScope;
}

const DEFAULT_PREFERENCES: PracticePreferences = {
  submitOnSelect: true,
  autoNextCorrect: true,
  autoNextDelayMs: 500,
  showAnswerOnWrong: true,
  swipeNavigation: true,
  questionTransition: "instant",
  shuffleOptions: true,
  multiSelectAllAutoSubmit: true,
  randomTypeBalance: "balanced",
  wrongReappearance: "end",
  defaultOrder: "sequential",
  fontSize: "standard",
  requireAllAnswered: true,
  feedbackSound: true,
  feedbackHaptics: true,
  dailyGoalCount: 30,
  dailyGoalAccuracy: 80,
  wrongRemovalStreak: 3,
  groupSize: 30,
  themeMode: "system",
  keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
  autoSyncEnabled: false,
  autoSyncEventThreshold: 20,
  periodicPullEnabled: false,
  periodicPullSeconds: 300,
  calculationTolerancePercent: 1,
  progressScope: { type: "rolling", days: 90 },
};

function loadPreferences(): PracticePreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const saved = { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem("study-v6-preferences") ?? "{}") } as PracticePreferences;
    return {
      ...saved,
      groupSize: Math.min(500, Math.max(1, Math.floor(Number(saved.groupSize) || 30))),
      dailyGoalCount: Math.min(1000, Math.max(1, Math.floor(Number(saved.dailyGoalCount) || 30))),
      dailyGoalAccuracy: Math.min(100, Math.max(1, Math.floor(Number(saved.dailyGoalAccuracy) || 80))),
      autoSyncEventThreshold: Math.min(1_000, Math.max(1, Math.floor(Number(saved.autoSyncEventThreshold) || 20))),
      periodicPullSeconds: Math.min(86_400, Math.max(30, Math.floor(Number(saved.periodicPullSeconds) || 300))),
      calculationTolerancePercent: Math.min(100, Math.max(0, Number(saved.calculationTolerancePercent) || 0)),
      themeMode: ["system", "light", "dark"].includes(saved.themeMode) ? saved.themeMode : "system",
      questionTransition: saved.questionTransition === "slide" ? "slide" : "instant",
      keyboardShortcuts: normalizeKeyboardShortcuts(saved.keyboardShortcuts),
      progressScope: normalizeProgressScope(saved.progressScope),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function displayedAnswer(question: Question, optionOrder: number[]) {
  if (question.type === "计算") return question.answer;
  return question.answer
    .split("")
    .map((letter) => optionOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((index) => index >= 0)
    .map((index) => String.fromCharCode(65 + index))
    .sort()
    .join("");
}

function answerText(question: Question, optionOrder: number[]) {
  if (question.type === "计算") return question.answer;
  return question.answer
    .split("")
    .map((letter) => letter.charCodeAt(0) - 65)
    .map((originalIndex) => ({ originalIndex, displayIndex: optionOrder.indexOf(originalIndex) }))
    .sort((a, b) => a.displayIndex - b.displayIndex)
    .map(({ originalIndex, displayIndex }) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`)
    .join("；");
}

function formatDate(value?: string) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function shuffle<T>(values: T[]) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function balancedRandomSample(questions: Question[], limit: number) {
  const groups = TYPE_ORDER.map((type) => shuffle(questions.filter((question) => question.type === type)));
  const picked: Question[] = [];
  while (picked.length < limit && groups.some((group) => group.length)) {
    for (const group of groups) {
      const question = group.shift();
      if (question) picked.push(question);
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

function playAnswerFeedback(correct: boolean, preferences: PracticePreferences) {
  if (preferences.feedbackHaptics && "vibrate" in navigator) navigator.vibrate(correct ? 35 : [45, 35, 45]);
  if (!preferences.feedbackSound) return;
  try {
    const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = correct ? 720 : 230;
    gain.gain.setValueAtTime(0.055, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + (correct ? .11 : .18));
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + (correct ? .11 : .18));
    oscillator.addEventListener("ended", () => void context.close());
  } catch { /* Browsers may block audio until the next gesture. */ }
}

const modeLabels = {
  random30: "随机一组",
  randomCustom: "随机指定题数",
  sequential: "全量顺序练习",
  randomAll: "全量随机练习",
  wrong: "错题模式",
  favorite: "收藏题模式",
  difficult: "难题优先",
  tag: "标签模式",
  advanced: "高级筛选",
};

const TYPE_ORDER: QuestionType[] = ["单选", "多选", "判断", "计算"];

function randomOptionOrder(question: Question, avoid?: number[]) {
  const original = question.options.map((_, index) => index);
  if (question.type === "判断" || question.type === "计算" || original.length < 2) return original;
  const randomized = shuffle(original);
  if (avoid?.length === randomized.length && randomized.every((value, index) => value === avoid[index])) {
    return [...randomized.slice(1), randomized[0]];
  }
  return randomized;
}

function loadSelectedBankIds() {
  if (typeof window === "undefined") return [];
  try {
    const saved = JSON.parse(localStorage.getItem("study-current-banks") ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

function quickFilter(bankIds: string[], mode: BankQuickMode = "random30", groupSize = 30, progressScope: ProgressScope = { type: "rolling", days: 90 }): PracticeFilter {
  return {
    bankIds,
    mode,
    types: TYPE_ORDER,
    tags: [],
    tagMatch: "any",
    status: mode === "wrong" ? "wrong" : mode === "favorite" ? "favorite" : "all",
    order: mode === "random30" || mode === "randomAll" ? "random" : mode === "difficult" ? "difficulty" : "sequential",
    limit: mode === "random30" ? groupSize : null,
    keyword: "",
    keywordMode: "plain",
    totalAttemptsMin: null,
    totalAttemptsMax: null,
    wrongAttemptsMin: null,
    wrongAttemptsMax: null,
    difficultyMin: null,
    difficultyMax: null,
    lastAttemptFrom: "",
    lastAttemptTo: "",
    progressScope: normalizeProgressScope(progressScope),
  };
}

function activePracticeFromRun(run: PracticeRun, preferredIndex?: number): ActivePractice {
  const currentIndex = preferredIndex ?? resumeIndexAfterLastAnswer(run.questionIds, run.answers);
  return {
    id: "active",
    runId: run.id,
    bankId: run.bankId,
    bankIds: run.bankIds,
    bankName: run.bankName,
    mode: run.mode,
    modeLabel: run.modeLabel,
    questionIds: run.questionIds,
    questionTypes: run.questionTypes,
    currentIndex: Math.min(Math.max(0, currentIndex), Math.max(0, run.questionIds.length - 1)),
    lastAnsweredIndex: run.lastAnsweredIndex,
    answers: run.answers,
    shuffleOptions: run.shuffleOptions,
    optionOrders: run.optionOrders,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    revision: run.revision,
  };
}

const formatBuildTimestamp = () =>
  new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(__APP_COMMIT_TIME__));
const formatBuildTimestampShort = () =>
  new Intl.DateTimeFormat("zh-CN", { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(__APP_COMMIT_TIME__));

export function StudyApp() {
  const [view, setView] = useState<View>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [searchQuestionId, setSearchQuestionId] = useState<string>();
  const [searchRevision, setSearchRevision] = useState(0);
  const [groupQuestionIds, setGroupQuestionIds] = useState<string[]>([]);
  const [practiceSession, setPracticeSession] = useState<ActivePractice | null>(null);
  const [practiceTransitionDirection, setPracticeTransitionDirection] = useState<1 | -1>(1);
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>(loadSelectedBankIds);
  const [preferences, setPreferences] = useState<PracticePreferences>(loadPreferences);
  const [discardedRun, setDiscardedRun] = useState<PracticeRun | null>(null);
  const [practiceHubTab, setPracticeHubTab] = useState<"start" | "history">("start");
  const [resultRunId, setResultRunId] = useState<string>();
  const [quickSyncing, setQuickSyncing] = useState(false);
  const [quickRestoring, setQuickRestoring] = useState(false);
  const [quickSyncProgress, setQuickSyncProgress] = useState<SyncProgress>();
  const smoothQuickSyncProgress = useSmoothProgress(quickSyncProgress);
  const [quickSyncHolding, setQuickSyncHolding] = useState(false);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [quickRestorePrompt, setQuickRestorePrompt] = useState<{ settings: GitHubSettings; cachedAt: string; questionCount: number }>();
  const [quickRestoreSuccess, setQuickRestoreSuccess] = useState<string>();
  const [finishPrompt, setFinishPrompt] = useState<number>();
  const fileRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const viewScrollPositions = useRef<Partial<Record<View, number>>>({});
  const quickSyncPress = useRef<{ timer: number; pointerId: number; startX: number; startY: number; startedAt: number; longPressed: boolean; cancelled: boolean } | null>(null);
  const syncOperationRunning = useRef(false);
  const automaticSyncRunning = useRef(false);
  const periodicPullRunning = useRef(false);
  const quickSyncAction = useRef<(options?: { silent?: boolean }) => Promise<void>>(async () => undefined);
  const lastAutomaticSyncAt = useRef(0);

  useAppViewport();
  useAppTheme(preferences.themeMode);

  useEffect(() => { void ensureChangeSetQueueBaseV7(); }, []);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const positions = viewScrollPositions.current;
    workspace.scrollTop = SCROLL_RESTORABLE_VIEWS.includes(view) ? positions[view] ?? 0 : 0;
  }, [view]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !SCROLL_RESTORABLE_VIEWS.includes(view)) return;
    const positions = viewScrollPositions.current;
    const rememberPosition = () => { positions[view] = workspace.scrollTop; };
    workspace.addEventListener("scroll", rememberPosition, { passive: true });
    return () => workspace.removeEventListener("scroll", rememberPosition);
  }, [view]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), notice === "已放弃上次练习" ? 6000 : 3000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function handleRestoreSuccess(message: string) {
    // Restoring replaces the IndexedDB contents while this component is still
    // mounted. Reset transient React state so live queries can render the new
    // data without requiring a full document reload.
    localStorage.removeItem("study-current-banks");
    setView("home");
    setSidebarOpen(false);
    setNotice("");
    setQuery("");
    setSearchQuestionId(undefined);
    setSearchRevision((revision) => revision + 1);
    setGroupQuestionIds([]);
    setPracticeSession(null);
    setSelectedBankIds([]);
    setDiscardedRun(null);
    setPracticeHubTab("start");
    setResultRunId(undefined);
    setFinishPrompt(undefined);
    setQuickSyncing(false);
    setQuickRestoring(false);
    setQuickSyncHolding(false);
    setQuickSyncProgress(undefined);
    setQuickRestorePrompt(undefined);
    if (quickSyncPress.current) window.clearTimeout(quickSyncPress.current.timer);
    quickSyncPress.current = null;
    viewScrollPositions.current = {};
    workspaceRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setQuickRestoreSuccess(message);
  }


  const banks = useLiveQuery(async () => (await dbV6.banks.toArray()).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)), []) ?? [];
  const validSelectedBankIds = selectedBankIds.filter((id) => banks.some((bank) => bank.id === id));
  const activeBankIds = validSelectedBankIds;
  const latestPracticeRun = useLiveQuery(async () => {
    return dbV6.practiceRuns.where("status").equals("in_progress").sortBy("updatedAt").then((runs) => runs.at(-1));
  }, []);
  const activeQuestionId = practiceSession?.questionIds[practiceSession.currentIndex];
  const activeQuestion = useLiveQuery(async () => {
    if (!activeQuestionId) return undefined;
    const view = await getQuestionViewV6(activeQuestionId, practiceSession?.bankId);
    // null = 已解析但题目不存在（本机或后台同步删除），区别于加载中的 undefined，
    // 供下方「跳过已删题」effect 判定当前题已消失。
    if (!view) return null;
    const bank = view.banks.find((item) => item.id === view.sourceBankId) ?? view.banks[0];
    const membership = view.memberships.find((item) => item.bankId === view.sourceBankId) ?? view.memberships[0];
    return toQuestionViewModel(view.question, view.sourceBankId ?? "", bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0);
  }, [activeQuestionId, practiceSession?.bankId]);

  // 练习中当前题被删除（本机管理或后台同步拉取）时自动跳过；若练习内已无存活的题，
  // 则保存已作答并结束进入结果页。删除操作已把该题从持久化 run 里剔除，这里只需对齐内存会话。
  useEffect(() => {
    if (view !== "practice" || !practiceSession || activeQuestion !== null || !activeQuestionId) return;
    const deletedId = activeQuestionId;
    const survivors = practiceSession.questionIds.filter((id) => id !== deletedId);
    // activeQuestion 用 useLiveQuery 解析（异步）；session 刚被本 effect 裁剪后到 liveQuery
    // 重解析之间存在窗口，此时 activeQuestion 仍为 null 但题目其实还在。直接查 DB 确认真伪，
    // 避免把「liveQuery 尚未刷新」误判为删除，导致连环跳过把整组题清空。
    let cancelled = false;
    void (async () => {
      const stillExists = await getQuestionViewV6(deletedId, practiceSession.bankId);
      if (cancelled || stillExists) return; // 题目还在，只是 liveQuery 没刷新，不跳过
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
      changeSession((session) => {
        if (!session.questionIds.includes(deletedId)) return session;
        const answers = Object.fromEntries(Object.entries(session.answers).filter(([id]) => id !== deletedId));
        const questionTypes = Object.fromEntries(Object.entries(session.questionTypes ?? {}).filter(([id]) => id !== deletedId));
        const nextQuestionIds = session.questionIds.filter((id) => id !== deletedId);
        let lastAnsweredIndex = -1;
        nextQuestionIds.forEach((id, index) => { if (session.answers[id]?.submitted) lastAnsweredIndex = index; });
        return {
          ...session,
          questionIds: nextQuestionIds,
          answers,
          questionTypes,
          currentIndex: Math.min(session.currentIndex, nextQuestionIds.length - 1),
          lastAnsweredIndex,
        };
      });
      setNotice("题目已删除，自动跳过");
    })();
    return () => { cancelled = true; };
  }, [activeQuestion, activeQuestionId, practiceSession, view]);

  // E3: 删除题库（本机管理或后台同步拉取）会硬删活动 run 行并写墓碑，但 React 的 practiceSession
  // 仍是陈旧快照——继续答题时 savePracticeProgress 会命中 if(!current) return 而静默丢答案（幽灵会话）。
  // 监听当前 run 行是否存在，消失时置空会话、回首页并提示。activeRunExists 用 false 显式区分
  // 「已解析且不存在」与加载中的 undefined。
  const activeRunExists = useLiveQuery(async () => {
    if (!practiceSession) return undefined;
    return Boolean(await dbV6.practiceRuns.get(practiceSession.runId));
  }, [practiceSession?.runId]);
  useEffect(() => {
    if (view !== "practice" || !practiceSession || activeRunExists !== false) return;
    queueMicrotask(() => {
      setPracticeSession(null);
      setView("home");
      setNotice("本次练习对应的题库已被删除，练习已结束");
    });
  }, [activeRunExists, practiceSession, view]);
  const stats = useLiveQuery(async () => {
    const today = calendarDate(new Date());
    const [questions, attemptStats, todayRows, pending, notes] = await Promise.all([
      dbV6.questions.count(), dbV6.attemptStats.toArray(), dbV6.attemptDailyStats.where("date").equals(today).toArray(),
      dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count(), dbV6.notes.count(),
    ]);
    const totals = attemptStats.reduce((result, row) => ({ attempts: result.attempts + row.total, correct: result.correct + row.correct }), { attempts: 0, correct: 0 });
    const todayTotals = todayRows.reduce((result, row) => ({ attempts: result.attempts + row.total, correct: result.correct + row.correct }), { attempts: 0, correct: 0 });
    const last = [...attemptStats].sort((a, b) => b.latestAttemptAt.localeCompare(a.latestAttemptAt))[0];
    return {
      questions,
      attempts: totals.attempts,
      correct: totals.correct,
      todayAttempts: todayTotals.attempts,
      todayCorrect: todayTotals.correct,
      pending,
      notes,
      last: last?.latestAttemptAt,
    };
  }, []) ?? { questions: 0, attempts: 0, correct: 0, todayAttempts: 0, todayCorrect: 0, pending: 0, notes: 0, last: undefined };
  const syncChangeSets = useLiveQuery(() => dbV6.changeSets.orderBy("createdAt").reverse().limit(300).toArray(), []) ?? [];
  // Dependency resolution is only needed when the change-set list actually
  // changes; memoising it keeps every answer submission (which re-renders the
  // app) from re-running the O(n) scan over the event queue.
  const syncItems: SyncChangeSetItemV7[] = useMemo(() => {
    const manageableChangeSets = syncChangeSets.filter((record) => record.state === "pending" || record.state === "blocked");
    return syncChangeSets.map((record) => ({
      changeSet: record,
      state: record.state,
      blockers: record.blockedReason ? [record.blockedReason] : undefined,
      dependentChangeSetIds: dependentChangeSetIdsV7(record, manageableChangeSets),
      editable: record.state === "pending" || record.state === "blocked",
      cancellable: record.state === "pending" || record.state === "blocked",
    }));
  }, [syncChangeSets]);
  const reviewRounds = useLiveQuery(() => dbV6.reviewRounds.orderBy("updatedAt").reverse().toArray(), []) ?? [];
  const normalizedProgressScope = normalizeProgressScope(preferences.progressScope);
  const selectedScopeLabel = normalizedProgressScope.type === "round"
    ? reviewRounds.find((round) => round.id === normalizedProgressScope.roundId)?.name || "当前复习轮次"
    : progressScopeLabel(normalizedProgressScope);
  const activeBankKey = activeBankIds.join("|");
  const scopeProgress = useLiveQuery(async () => {
    if (!activeBankIds.length) return { completed: 0, total: 0 };
    const [questions, stats, roundProgress] = await Promise.all([listQuestionViewsForBanksV6(activeBankIds), dbV6.attemptStats.toArray(), dbV6.reviewRoundProgress.toArray()]);
    const ids = [...new Set(questions.map((view) => view.question.id))];
    const completion = calculateProgressCompletion(ids, normalizeProgressScope(preferences.progressScope), stats, roundProgress, Date.now());
    return { completed: completion.completed, total: completion.total };
  }, [activeBankKey, preferences.progressScope]) ?? { completed: 0, total: 0 };
  const scopeStats = useLiveQuery(async () => {
    const questionIds = activeBankIds.length
      ? [...new Set((await dbV6.bankQuestionMemberships.where("bankId").anyOf(activeBankIds).toArray()).map((membership) => membership.questionId))]
      : await dbV6.questions.toCollection().primaryKeys();
    const [attempts, roundProgress, notes] = await Promise.all([
      dbV6.attempts.toArray(), dbV6.reviewRoundProgress.toArray(), dbV6.notes.toArray(),
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
  }, [activeBankKey, preferences.progressScope, banks.length]) ?? { questions: 0, attempts: 0, correct: 0, notes: 0, last: undefined, bankCount: activeBankIds.length || banks.length };

  async function onImport(file?: File) {
    if (!file) return;
    try {
      setNotice("正在识别并校验题库…");
      const { bank, type } = await importQuestionBankFile(file);
      setNotice(`已从 ${type === "xlsx" ? "Excel" : type === "zip" ? "压缩包" : "JSON"} 导入「${bank.displayName || bank.name}」的 ${bank.questionCount} 道题`);
      setView("banks");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "题库导入失败");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function selectBanks(bankIds: string[]) {
    const unique = [...new Set(bankIds)];
    setSelectedBankIds(unique);
    localStorage.setItem("study-current-banks", JSON.stringify(unique));
  }

  function toggleBank(bankId: string) {
    const next = activeBankIds.includes(bankId) ? activeBankIds.filter((id) => id !== bankId) : [...activeBankIds, bankId];
    selectBanks(next);
  }

  async function discardSavedPractice(runId: string) {
    const run = await dbV6.practiceRuns.get(runId);
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

  function updatePreferences(value: PracticePreferences) {
    setPreferences(value);
    localStorage.setItem("study-v6-preferences", JSON.stringify(value));
  }

  async function quickSync({ silent = false }: { silent?: boolean } = {}) {
    if (syncOperationRunning.current || quickRestoring) return;
    const token = loadGitHubToken();
    const settings = loadGitHubSettings();
    if (!settings.repo || !token) {
      if (!silent) {
        setNotice("请先在配置页面填写 GitHub 令牌");
        setView(window.matchMedia("(max-width: 760px)").matches ? "preferences" : "settings");
      }
      return;
    }
    syncOperationRunning.current = true;
    try {
      if (!silent) {
        setQuickSyncing(true);
        setQuickSyncProgress({ phase: "prepare", label: "正在准备同步", percent: 0 });
      }
      const { getGitHubLogin, syncWithGitHub } = await import("@/lib/github-sync");
      const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
      saveGitHubSettings(resolved);
      const result = await syncWithGitHub(resolved, token, silent ? undefined : setQuickSyncProgress);
      if (!silent) {
        const received = result.receivedSnapshot
          ? `接收 ${result.receivedSnapshot.questions.toLocaleString("zh-CN")} 道题、${result.receivedSnapshot.totalAttempts.toLocaleString("zh-CN")} 条作答`
          : `接收 ${result.pulled} 组操作`;
        setNotice(`同步完成：上传 ${result.pushed} 组操作，${received}${result.compacted ? "，远程数据已压缩" : ""}${result.remaining ? `，待同步 ${result.remaining} 组操作` : ""}`);
      }
    } catch (error) {
      if (!silent) setNotice(error instanceof Error ? error.message : "同步失败，请检查令牌和网络");
    } finally {
      syncOperationRunning.current = false;
      if (!silent) {
        setQuickSyncing(false);
        setQuickSyncProgress(undefined);
      }
    }
  }
  quickSyncAction.current = quickSync;

  useEffect(() => {
    if (!preferences.autoSyncEnabled || stats.pending < preferences.autoSyncEventThreshold || automaticSyncRunning.current || syncOperationRunning.current || quickRestoring || Date.now() - lastAutomaticSyncAt.current < 30_000) return;
    if (!loadGitHubSettings().repo || !loadGitHubToken()) return;
    const timer = window.setTimeout(() => {
      automaticSyncRunning.current = true;
      lastAutomaticSyncAt.current = Date.now();
      void quickSyncAction.current({ silent: true }).finally(() => { automaticSyncRunning.current = false; });
    });
    return () => window.clearTimeout(timer);
  }, [preferences.autoSyncEnabled, preferences.autoSyncEventThreshold, quickRestoring, quickSyncing, stats.pending]);

  useEffect(() => {
    if (!preferences.periodicPullEnabled) return;
    const pull = async () => {
      if (periodicPullRunning.current || syncOperationRunning.current || quickRestoring) return;
      const token = loadGitHubToken();
      const settings = loadGitHubSettings();
      if (!settings.repo || !token) return;
      periodicPullRunning.current = true;
      syncOperationRunning.current = true;
      try {
        const { getGitHubLogin, pullFromGitHub } = await import("@/lib/github-sync");
        const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
        saveGitHubSettings(resolved);
        await pullFromGitHub(resolved, token);
      } catch (error) {
        setNotice(error instanceof Error ? `定期拉取失败：${error.message}` : "定期拉取失败");
      } finally {
        periodicPullRunning.current = false;
        syncOperationRunning.current = false;
      }
    };
    const timer = window.setInterval(() => void pull(), preferences.periodicPullSeconds * 1_000);
    return () => window.clearInterval(timer);
  }, [preferences.periodicPullEnabled, preferences.periodicPullSeconds, quickRestoring, quickSyncing]);

  async function prepareQuickRestore() {
    if (quickSyncing || quickRestoring) return;
    let settings: GitHubSettings;
    try {
      settings = JSON.parse(localStorage.getItem("github-settings") ?? "") as GitHubSettings;
    } catch {
      setNotice("本机还没有远程缓存，请先成功同步一次");
      return;
    }
    if (!settings.owner || !settings.repo) {
      setNotice("本机还没有远程缓存，请先成功同步一次");
      return;
    }
    try {
      const { getLastRemoteCache } = await import("@/lib/github-sync");
      const cached = await getLastRemoteCache(settings);
      if (!cached) {
        setNotice("本机还没有远程缓存，请先成功同步一次");
        return;
      }
      setQuickRestorePrompt({ settings, cachedAt: cached.cachedAt, questionCount: cached.counts.questions });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取本地恢复记录");
    }
  }

  async function confirmQuickRestore() {
    if (!quickRestorePrompt || quickRestoring) return;
    try {
      setQuickRestoring(true);
      setQuickSyncProgress({ phase: "prepare", label: "正在准备恢复", percent: 0 });
      const { restoreLastRemoteCache } = await import("@/lib/github-sync");
      const result = await restoreLastRemoteCache(quickRestorePrompt.settings, setQuickSyncProgress);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      setQuickRestorePrompt(undefined);
      setQuickRestoring(false);
      setQuickSyncProgress(undefined);
      handleRestoreSuccess(`已从本机缓存恢复 ${result.counts.questions} 道题及对应学习记录。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "本地缓存恢复失败");
      setQuickRestoring(false);
      setQuickSyncProgress(undefined);
    }
  }

  function beginQuickSyncPress(event: ReactPointerEvent<HTMLButtonElement>) {
    if (quickSyncing || quickRestoring || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const press = {
      timer: 0,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: event.timeStamp,
      longPressed: false,
      cancelled: false,
    };
    press.timer = window.setTimeout(() => {
      press.longPressed = true;
      void prepareQuickRestore().finally(() => setQuickSyncHolding(false));
    }, QUICK_RESTORE_HOLD_MS);
    quickSyncPress.current = press;
    setQuickSyncHolding(true);
  }

  function moveQuickSyncPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = quickSyncPress.current;
    if (!press || press.pointerId !== event.pointerId || press.longPressed) return;
    if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) <= 10) return;
    window.clearTimeout(press.timer);
    press.cancelled = true;
    setQuickSyncHolding(false);
  }

  function endQuickSyncPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = quickSyncPress.current;
    if (!press || press.pointerId !== event.pointerId) return;
    window.clearTimeout(press.timer);
    quickSyncPress.current = null;
    setQuickSyncHolding(false);
    const intent = classifyPressIntent(event.timeStamp - press.startedAt, press.cancelled, press.longPressed);
    if (intent === "tap") void quickSync();
    else if (intent === "complete" && !press.longPressed) void prepareQuickRestore();
  }

  function cancelQuickSyncPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = quickSyncPress.current;
    if (!press || press.pointerId !== event.pointerId) return;
    window.clearTimeout(press.timer);
    quickSyncPress.current = null;
    setQuickSyncHolding(false);
  }

  async function startPractice(filter: PracticeFilter) {
    let requestedBankIds = [...new Set(filter.bankIds)];
    if (filter.reviewRoundId) {
      const round = await dbV6.reviewRounds.get(filter.reviewRoundId);
      if (!round || round.status !== "active") {
        setNotice("这条复习轮次已不存在或已结束，请重新选择。");
        return;
      }
      // A round owns its dynamic bank membership. Re-read it at start time so
      // a stale setup screen can never create a run against another scope.
      requestedBankIds = [...new Set(round.bankIds)];
    }
    const practiceBanks = banks.filter((item) => requestedBankIds.includes(item.id));
    if (!practiceBanks.length) {
      setNotice("请先选择一个题库");
      return;
    }
    // app-data-v6 joins memberships and deliberately de-duplicates shared
    // global questions across the selected banks.
    let questions = (await listQuestionViewsForBanksV6(requestedBankIds)).map((view) => {
      const bank = view.banks.find((item) => item.id === view.sourceBankId) ?? view.banks[0];
      const membership = view.memberships.find((item) => item.bankId === view.sourceBankId) ?? view.memberships[0];
      return toQuestionViewModel(view.question, view.sourceBankId ?? "", bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0);
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
    const [statsRows, roundProgress] = await Promise.all([dbV6.attemptStats.toArray(), dbV6.reviewRoundProgress.toArray()]);
    const statsByQuestion = new Map(statsRows.map((stats) => [stats.questionId, stats]));
    const attemptMetrics = new Map(statsRows.map((stats) => [stats.questionId, summarizeV6AttemptStats(stats)]));
    const progressScope = normalizeProgressScope(filter.progressScope ?? preferences.progressScope);
    const lastAttemptFrom = filter.lastAttemptFrom ? new Date(`${filter.lastAttemptFrom}T00:00:00`).getTime() : null;
    const lastAttemptTo = filter.lastAttemptTo ? new Date(`${filter.lastAttemptTo}T23:59:59.999`).getTime() : null;
    questions = questions.filter((question) => {
      const stats = statsByQuestion.get(question.id);
      const metric = attemptMetrics.get(question.id) ?? summarizeV6AttemptStats();
      const doneInScope = isQuestionDoneInScope(question.id, progressScope, statsRows, roundProgress, Date.now());
      if (filter.status === "unanswered" && doneInScope) return false;
      if (filter.status === "wrong" && !statsNeedWrongReview(toLegacyAttemptStats(stats), preferences.wrongRemovalStreak)) return false;
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
      if (filter.order === "difficulty") return group.sort((a, b) => (attemptMetrics.get(b.id)?.difficulty ?? 50) - (attemptMetrics.get(a.id)?.difficulty ?? 50));
      return group;
    });
    if (filter.limit && !limitApplied) questions = questions.slice(0, filter.limit);
    if (!questions.length) {
      setNotice("没有符合当前条件的题目，请调整筛选条件");
      return;
    }
    const now = new Date().toISOString();
    const run = await createPracticeRunV6({
      bankId: practiceBanks[0].id,
      bankIds: requestedBankIds,
      bankName: practiceBanks.length === 1 ? (practiceBanks[0].displayName || practiceBanks[0].name) : `${practiceBanks.length} 个题库组合`,
      mode: filter.mode,
      modeLabel: filter.mode === "random30" || filter.mode === "randomCustom" ? `随机 ${filter.limit ?? preferences.groupSize} 题` : modeLabels[filter.mode],
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
    const uniqueQuestions = [...new Map(questions.map((question) => [question.id, question])).values()];
    const orderedQuestions = TYPE_ORDER.flatMap((type) => uniqueQuestions.filter((question) => question.type === type));
    const practiceBanks = banks.filter((bank) => orderedQuestions.some((question) => question.bankId === bank.id));
    if (!orderedQuestions.length || !practiceBanks.length) return;
    const now = new Date().toISOString();
    const run = await createPracticeRunV6({
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

  function openSearch(questionId?: string, keyword?: string) {
    const kw = (keyword ?? query).trim();
    if (kw) {
      try {
        const previous = JSON.parse(localStorage.getItem("study-search-history") ?? "[]") as unknown;
        const history = Array.isArray(previous) ? previous.filter((item): item is string => typeof item === "string") : [];
        localStorage.setItem("study-search-history", JSON.stringify([kw, ...history.filter((item) => item !== kw)].slice(0, 10)));
      } catch { localStorage.setItem("study-search-history", JSON.stringify([kw])); }
    }
    setSearchQuestionId(questionId);
    setSearchRevision((revision) => revision + 1);
    setView("search");
  }

  function changeSession(mutator: (session: ActivePractice) => ActivePractice) {
    setPracticeSession((current) => {
      if (!current) return current;
      const changed = mutator(current);
      if (changed === current) return current;
      const next = { ...changed, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
      // The current question is React-only view state. Persist answer changes,
      // but do not let browsing back and forth create newer run revisions that
      // could outrank submitted progress received from another device.
      if (changed.answers !== current.answers) void savePracticeProgress(next);
      return next;
    });
  }

  async function resumePractice(runId?: string, preferredIndex?: number) {
    const run = runId ? await dbV6.practiceRuns.get(runId) : latestPracticeRun;
    if (!run || run.status !== "in_progress" || !run.questionIds.length) {
      setNotice("没有可以继续的练习记录");
      return;
    }
    let session = activePracticeFromRun(run, preferredIndex);
    if (!session.questionTypes || Object.keys(session.questionTypes).length !== session.questionIds.length) {
      const questions = await dbV6.questions.bulkGet(session.questionIds);
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
    const run = await dbV6.practiceRuns.get(runId);
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
    const stamped = { ...answerState, updatedAt: new Date().toISOString(), deviceId: getV6DeviceId(), eventId: crypto.randomUUID() };
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

  const navItems = [
    { id: "home" as const, label: "今日", icon: Home },
    { id: "banks" as const, label: "题库", icon: Library },
    { id: "practiceSetup" as const, label: "练习", icon: ListFilter },
    { id: "relations" as const, label: "知识整理", icon: Link2 },
    { id: "preferences" as const, label: "配置", icon: Settings2 },
    { id: "settings" as const, label: "同步", icon: Cloud },
  ];

  const mobileNavItems = navItems.filter(({ id }) => id !== "settings").map((item) => item.id === "relations" ? { ...item, label: "整理" } : item);

  function openMainView(nextView: View) {
    if (nextView === "relations") setGroupQuestionIds([]);
    if (nextView === "practiceSetup") setPracticeHubTab("start");
    if (nextView === view) workspaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else {
      if (SCROLL_RESTORABLE_VIEWS.includes(view) && workspaceRef.current) viewScrollPositions.current[view] = workspaceRef.current.scrollTop;
      setView(nextView);
    }
    setSidebarOpen(false);
  }

  return (
    <main className={`app-shell font-${preferences.fontSize} transition-${preferences.questionTransition} transition-${practiceTransitionDirection < 0 ? "back" : "forward"}`}>
      <PullToRefresh />
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand"><span className="brand-mark">拾</span><span>拾卷</span></div>
        <nav>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`${view === id ? "nav-active" : ""} ${id === "settings" ? "desktop-sync-nav" : ""}`} aria-current={view === id ? "page" : undefined} onClick={() => openMainView(id)}>
              <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="local-dot" />本地数据已保存
          <small>{stats.pending ? `${stats.pending} 条等待同步` : "没有待同步更改"}</small>
          <small className="sidebar-build"><code>{__APP_COMMIT_SHA__.slice(0, 7)}</code> · {formatBuildTimestampShort()}</small>
        </div>
      </aside>
      <button className={`sidebar-backdrop ${sidebarOpen ? "visible" : ""}`} aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />

      <section ref={workspaceRef} className={`workspace ${view === "search" ? "view-search" : ""}`}>
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={20} /></button>
          <QuickSearch banks={banks} activeBankIds={activeBankIds} onOpenSearch={(keyword, questionId) => { setQuery(keyword); openSearch(questionId, keyword); }} />
          <div className="quick-sync-split"><button className={`sync-pill quick-sync ${quickSyncing || quickRestoring ? "syncing" : ""} ${quickSyncHolding ? "holding" : ""}`} disabled={quickSyncing || quickRestoring} aria-label="单击立即同步，长按恢复本地记录" title="单击立即同步；长按恢复本地记录" onPointerDown={beginQuickSyncPress} onPointerMove={moveQuickSyncPress} onPointerUp={endQuickSyncPress} onPointerCancel={cancelQuickSyncPress} onContextMenu={(event) => event.preventDefault()} onClick={(event) => { if (event.detail === 0) void quickSync(); }}><span className="quick-sync-icon"><svg className="quick-sync-progress" viewBox="0 0 32 32" aria-hidden="true"><circle className="track" cx="16" cy="16" r="14" /><circle className="value" cx="16" cy="16" r="14" /></svg>{quickSyncing || quickRestoring ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}</span><span className="quick-sync-label">{quickSyncHolding ? "恢复" : quickRestoring ? "恢复中" : quickSyncing ? "同步中" : "同步"}</span></button><button className="sync-queue-trigger" type="button" aria-label={`查看本次同步，共 ${stats.pending} 组待同步事件`} onClick={() => setSyncDrawerOpen(true)}>{stats.pending.toLocaleString("zh-CN")}<ChevronRight size={14} /></button></div>
        </header>

        {smoothQuickSyncProgress && <div className="top-sync-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={smoothQuickSyncProgress.percent}><span>{smoothQuickSyncProgress.label}<em>{smoothQuickSyncProgress.percent}%</em></span><i aria-hidden="true"><b style={{ width: `${smoothQuickSyncProgress.percent}%` }} /></i></div>}

        {notice && <div className={`toast ${classifyNoticeTone(notice)}`}><Sparkles size={16} /><span>{notice}</span>{notice === "已放弃上次练习" && discardedRun && <button className="toast-action" onClick={() => void undoDiscardPractice()}>撤销</button>}<button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}
        <input ref={fileRef} type="file" accept={QUESTION_BANK_FILE_ACCEPT} hidden onChange={(event) => onImport(event.target.files?.[0])} />

        <div className={`content ${view === "practice" ? "practice-content" : ""}`}><Suspense fallback={<div className="route-loading"><LoaderCircle className="spin" size={24} /><span>正在载入页面…</span></div>}>
          {view === "home" && <Dashboard groupSize={preferences.groupSize} dailyGoalCount={preferences.dailyGoalCount} dailyGoalAccuracy={preferences.dailyGoalAccuracy} scopeProgress={scopeProgress} scopeLabel={selectedScopeLabel} scopeStats={scopeStats} stats={stats} banks={banks} latestPracticeRun={latestPracticeRun} selectedBankIds={activeBankIds} onBankToggle={toggleBank} onImport={() => fileRef.current?.click()} onStart={() => activeBankIds.length && void startPractice(quickFilter(activeBankIds, "random30", preferences.groupSize, preferences.progressScope))} onResume={(runId) => void resumePractice(runId)} onDiscardResume={(runId) => void discardSavedPractice(runId)} onMoreModes={() => setView("practiceSetup")} />}
          {view === "banks" && <BankLibraryView banks={banks} progressScope={preferences.progressScope} progressScopeLabel={selectedScopeLabel} wrongRemovalStreak={preferences.wrongRemovalStreak} onImport={() => fileRef.current?.click()} onOpenRun={(runId) => { setResultRunId(runId); setView("practiceResult"); }} onNotice={setNotice} />}
          {view === "practiceSetup" && <><div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>练习中心</h1><p>开始新的练习，或回看每一次练习的题目和成绩。</p></div></div><div className="practice-hub-tabs"><button className={practiceHubTab === "start" ? "active" : ""} onClick={() => setPracticeHubTab("start")}><Play size={16} />开始练习</button><button className={practiceHubTab === "history" ? "active" : ""} onClick={() => setPracticeHubTab("history")}><ClipboardCheck size={16} />练习记录</button></div>{practiceHubTab === "start" ? <><LatestPracticeBanner onContinue={(runId) => void resumePractice(runId)} onAbandon={(runId) => void abandonHistoryRun(runId)} onViewAll={() => setPracticeHubTab("history")} /><PracticeSetupView hideHeading groupSize={preferences.groupSize} defaultOrder={preferences.defaultOrder} progressScope={preferences.progressScope} rounds={reviewRounds} banks={banks} currentBankIds={activeBankIds} onBankChange={selectBanks} onStart={(filter) => void startPractice(filter)} /></> : <PracticeHistory onOpen={(runId) => { setResultRunId(runId); setView("practiceResult"); }} onContinue={(runId) => void resumePractice(runId)} onAbandon={(runId) => void abandonHistoryRun(runId)} onDelete={(runId) => void removeHistoryRun(runId)} />}</>}
          {view === "relations" && <KnowledgeView initialQuestionIds={groupQuestionIds} onStartTag={(tag) => { const bankIds = banks.map((bank) => bank.id); const filter = { ...quickFilter(bankIds, "sequential", preferences.groupSize, preferences.progressScope), mode: "tag" as const, tags: [tag] }; void startPractice(filter); }} onStartQuestions={(questions, label) => void startSearchPractice({ questions, label, shuffleOptions: preferences.shuffleOptions })} onNotice={setNotice} />}
          {view === "preferences" && <PreferencesView preferences={preferences} rounds={reviewRounds} banks={banks} pendingSync={stats.pending} onNotice={setNotice} onChange={updatePreferences} onRestored={handleRestoreSuccess} />}
          {view === "settings" && <SyncView pending={stats.pending} onNotice={setNotice} onRestored={handleRestoreSuccess} />}
          {view === "search" && <SearchView key={`search-${searchRevision}`} query={query} onQueryChange={setQuery} banks={banks} currentBankIds={activeBankIds} focusQuestionId={searchQuestionId} onFocusHandled={() => setSearchQuestionId(undefined)} wrongRemovalStreak={preferences.wrongRemovalStreak} progressScope={preferences.progressScope} defaultShuffleOptions={preferences.shuffleOptions} onStart={(options) => startSearchPractice(options)} onGroup={(questionIds) => { setGroupQuestionIds(questionIds); setView("relations"); }} onNotice={setNotice} />}
          {view === "practiceResult" && resultRunId && <PracticeRunResult runId={resultRunId} onBack={() => { setPracticeHubTab("history"); setView("practiceSetup"); }} onContinue={(runId, index) => void resumePractice(runId, index)} onRepeat={(questions, label, previousOptionOrders) => void startSearchPractice({ questions, label, shuffleOptions: preferences.shuffleOptions }, undefined, previousOptionOrders)} />}
          {view === "practice" && practiceSession && activeQuestion && (
            <Practice key={activeQuestion.id} runId={practiceSession.runId} question={activeQuestion} initialState={practiceSession.answers[activeQuestion.id]} optionOrder={practiceSession.optionOrders?.[activeQuestion.id]} questionIds={practiceSession.questionIds} questionTypes={practiceSession.questionTypes ?? {}} answers={practiceSession.answers} index={practiceSession.currentIndex} total={practiceSession.questionIds.length} modeLabel={practiceSession.modeLabel} preferences={preferences} onStateChange={(state) => saveAnswerState(activeQuestion.id, state)} onJump={jumpPractice} onFavorite={async () => { const updated = await toggleQuestionFavorite(activeQuestion.id); setNotice(updated.favorite ? "已收藏这道题" : "已取消收藏"); }} onExit={() => { setPracticeSession(null); setView("home"); }} onPrevious={() => movePractice(-1)} onNext={() => movePractice(1)} onFinish={() => void finishPractice()} />
          )}
        </Suspense></div>
      </section>
      <SyncEventDrawer open={syncDrawerOpen} onClose={() => setSyncDrawerOpen(false)} items={syncItems} syncing={quickSyncing} progress={smoothQuickSyncProgress ?? quickSyncProgress} onSyncNow={() => quickSync()} onDelete={async (id, options) => { await discardManagedChangeSetV7(id, options); }} />
      <ConfirmDialog open={Boolean(quickRestorePrompt)} eyebrow="恢复本地记录" title="确认恢复" tone="danger" busy={quickRestoring} progress={quickRestoring ? smoothQuickSyncProgress ?? quickSyncProgress : undefined} confirmLabel="确认恢复" onCancel={() => setQuickRestorePrompt(undefined)} onConfirm={() => void confirmQuickRestore()} description={quickRestorePrompt ? <><strong>恢复到本地 {new Date(quickRestorePrompt.cachedAt).toLocaleString("zh-CN")} 的记录</strong><span>共包含 {quickRestorePrompt.questionCount} 道题。当前设备在此时间之后产生的题库编辑、作答记录、解析、标签和练习进度将被放弃。</span></> : null} />
      <ConfirmDialog open={Boolean(quickRestoreSuccess)} eyebrow="数据恢复" title="恢复成功" tone="success" hideCancel confirmLabel="返回首页" onCancel={() => undefined} onConfirm={() => setQuickRestoreSuccess(undefined)} description={<><strong>本地数据已经恢复</strong><span>{quickRestoreSuccess} 已清空当前练习界面并返回首页。</span></>} />
      <ConfirmDialog open={finishPrompt !== undefined} eyebrow="结束本次练习" title="还有题目未作答" tone="danger" confirmLabel="仍然结束" onCancel={() => setFinishPrompt(undefined)} onConfirm={() => void completePractice()} description={<><strong>还有 {finishPrompt ?? 0} 道题未作答</strong><span>结束后会保存当前作答，并直接进入本次练习结果。</span></>} />
      <nav className={`mobile-tabbar ${view === "practice" ? "hidden" : ""}`} aria-label="手机主导航">
        {mobileNavItems.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => openMainView(id)}>
            <Icon size={20} strokeWidth={view === id ? 2.2 : 1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(undefined);
    });
  });
}

async function updateServiceWorkerWithinTimeout() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await settleWithTimeout(navigator.serviceWorker.getRegistration(), 300);
  if (!registration) return;
  await settleWithTimeout(registration.update(), 700);
}

function PullToRefresh() {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const currentDistance = useRef(0);

  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".workspace");
    if (!scroller) return;
    const reset = () => {
      start.current = null;
      currentDistance.current = 0;
      setPulling(false);
      setDistance(0);
    };
    const onStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (refreshing || scroller.scrollTop > 0 || event.touches.length !== 1 || target?.closest("button, a, input, textarea, select, [role='dialog'], [data-no-pull-refresh], .search-results, .editor-backdrop, .overview-backdrop, .search-detail-backdrop, .simple-dialog-backdrop")) return;
      start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const onMove = (event: TouchEvent) => {
      if (!start.current || scroller.scrollTop > 0) return;
      const dx = event.touches[0].clientX - start.current.x;
      const dy = event.touches[0].clientY - start.current.y;
      if (dy <= 0 || Math.abs(dx) >= dy) {
        if (Math.abs(dx) > 10 || dy < -4) reset();
        return;
      }
      if (dy < 12) return;
      event.preventDefault();
      const next = Math.min(104, (dy - 12) * .42);
      currentDistance.current = next;
      setPulling(true);
      setDistance(next);
    };
    const onEnd = async () => {
      start.current = null;
      setPulling(false);
      if (currentDistance.current < 64 || refreshing) {
        reset();
        return;
      }
      setRefreshing(true);
      setDistance(52);
      try {
        // A service-worker update is best-effort. Never make a pull gesture
        // wait forever when a browser has a stalled update request.
        await updateServiceWorkerWithinTimeout();
      } finally {
        reset();
        setRefreshing(false);
        window.location.reload();
      }
    };
    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: false });
    scroller.addEventListener("touchend", onEnd, { passive: true });
    scroller.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", reset);
    };
  }, [refreshing]);

  return <div role="status" aria-live="polite" className={`pull-refresh ${refreshing ? "refreshing" : ""} ${pulling ? "pulling" : ""} ${distance >= 64 ? "ready" : ""}`} style={{ transform: `translate(-50%, ${distance - 54}px)`, opacity: distance ? 1 : 0 }}><RefreshCw size={17} /><span>{refreshing ? "正在加载最新版…" : distance >= 64 ? "松开刷新" : "下拉刷新"}</span></div>;
}

function Dashboard({ groupSize, dailyGoalCount, dailyGoalAccuracy, scopeProgress, scopeLabel, scopeStats, stats, banks, latestPracticeRun, selectedBankIds, onBankToggle, onImport, onStart, onResume, onDiscardResume, onMoreModes }: {
  groupSize: number;
  dailyGoalCount: number;
  dailyGoalAccuracy: number;
  scopeProgress: { completed: number; total: number };
  scopeLabel: string;
  scopeStats: { questions: number; attempts: number; correct: number; notes: number; bankCount: number; last?: string };
  stats: { questions: number; attempts: number; correct: number; todayAttempts: number; todayCorrect: number; pending: number; notes: number; last?: string };
  banks: Array<{ id: string; name: string; displayName?: string; questionCount: number }>;
  latestPracticeRun?: PracticeRun;
  selectedBankIds: string[];
  onBankToggle: (bankId: string) => void;
  onImport: () => void; onStart: () => void; onResume: (runId: string) => void; onDiscardResume: (runId: string) => void; onMoreModes: () => void;
}) {
  const scopeAccuracy = scopeStats.attempts ? Math.round(scopeStats.correct / scopeStats.attempts * 100) : 0;
  const todayAccuracy = stats.todayAttempts ? Math.round(stats.todayCorrect / stats.todayAttempts * 100) : 0;
  const countProgress = Math.min(100, Math.round(stats.todayAttempts / dailyGoalCount * 100));
  const selectedBanks = banks.filter((bank) => selectedBankIds.includes(bank.id));
  const selectedQuestions = selectedBanks.reduce((total, bank) => total + bank.questionCount, 0);
  const answeredInRun = latestPracticeRun ? Object.values(latestPracticeRun.answers).filter((answer) => answer.submitted).length : 0;
  const resumeProgress = latestPracticeRun?.questionIds.length ? Math.round(answeredInRun / latestPracticeRun.questionIds.length * 100) : 0;
  return <>
    <div className="home-heading"><h1>今日练习</h1><p>选择题库开始练习，或继续上次进度。</p>{selectedBanks.length > 0 && <div className="home-scope-summary"><ScopeSummaryChips total={scopeProgress.total} done={scopeProgress.completed} scopeLabel={scopeLabel} /></div>}</div>
    {latestPracticeRun && <section className="resume-card"><span className="resume-mark"><Play size={21} /></span><div className="resume-copy"><small>继续上次练习</small><strong>{latestPracticeRun.bankName}</strong><p>{latestPracticeRun.modeLabel}</p></div><div className="resume-progress"><div><span><b>{answeredInRun}</b> / {latestPracticeRun.questionIds.length} 已作答</span><strong>{resumeProgress}%</strong></div><i aria-label={`练习进度 ${resumeProgress}%`}><b style={{ width: `${resumeProgress}%` }} /></i></div><div className="resume-card-actions"><button className="resume-continue" onClick={() => onResume(latestPracticeRun.id)}>继续练习<ChevronRight size={17} /></button><button className="resume-discard" aria-label="放弃上次练习" title="放弃上次练习" onClick={() => onDiscardResume(latestPracticeRun.id)}><X size={16} /></button></div></section>}
    {banks.length ? <section className="home-bank-scope"><div className="scope-heading"><div><span className="section-kicker">当前题库范围</span><h2>选择一个或多个题库</h2></div><small>可以暂不选择</small></div><div className={`home-bank-grid${banks.length === 1 ? " single-bank" : ""}`}>{banks.map((bank) => { const selected = selectedBankIds.includes(bank.id); return <button key={bank.id} aria-pressed={selected} className={selected ? "selected" : ""} onClick={() => onBankToggle(bank.id)}><span className="scope-check">{selected && <Check size={14} />}</span><div><strong>{bank.displayName || bank.name}</strong><small>{bank.questionCount.toLocaleString()} 题</small></div></button>; })}</div><div className="scope-footer"><p>{selectedBanks.length ? <>已选择 <strong>{selectedBanks.length}</strong> 个题库，共 <strong>{selectedQuestions.toLocaleString()}</strong> 题</> : "尚未选择练习题库，可以先查看题库或练习配置。"}</p><button className="primary" disabled={!selectedBankIds.length} onClick={onStart}><Brain size={18} />开始随机 {groupSize} 题</button></div></section> : <EmptyImport onImport={onImport} />}
    <section className="home-feature-grid">
      <article className="daily-practice"><div><span className="section-kicker">今日推荐</span><h2>来一组 {groupSize} 题</h2><p>{selectedBankIds.length ? "从已选题库随机抽题，再按单选、多选、判断、计算分组。" : "请先选择题库，或进入更多练习模式选择题库。"}</p><div><button disabled={!selectedBankIds.length} onClick={onStart}>开始这一组<ChevronRight size={17} /></button><button className="feature-secondary" onClick={onMoreModes}><ListFilter size={16} />更多练习模式</button></div></div><span className="daily-number"><strong>{groupSize}</strong><small>题</small></span></article>
      <article className="memory-card daily-goal-card"><span>今日目标</span><blockquote>{stats.todayAttempts} / {dailyGoalCount} 题</blockquote><div className="daily-goal-progress"><i style={{ width: `${countProgress}%` }} /></div><small>今日正确率 {todayAccuracy}% · 目标 {dailyGoalAccuracy}%</small>
        <p className={stats.todayAttempts >= dailyGoalCount && todayAccuracy >= dailyGoalAccuracy ? "achieved" : ""}>{stats.todayAttempts >= dailyGoalCount && todayAccuracy >= dailyGoalAccuracy ? "今日目标已达成" : stats.todayAttempts < dailyGoalCount ? `还差 ${dailyGoalCount - stats.todayAttempts} 题` : `正确率还差 ${Math.max(0, dailyGoalAccuracy - todayAccuracy)}%`}</p>
      </article>
    </section>
    <section className="stat-grid">
      <Stat icon={<BookOpen />} label="范围题目" value={scopeStats.questions.toLocaleString()} foot={`${scopeStats.bankCount} 个题库 · ${scopeLabel}`} />
      <Stat icon={<Target />} label={`作答（${scopeLabel}）`} value={scopeStats.attempts.toLocaleString()} foot={`最近：${formatDate(scopeStats.last)}`} />
      <Stat icon={<Check />} label={`正确率（${scopeLabel}）`} value={`${scopeAccuracy}%`} foot={scopeStats.attempts ? `${scopeStats.correct} 次答对` : "当前范围尚未作答"} />
      <Stat icon={<NotebookPen />} label="个人解析（当前题库范围）" value={scopeStats.notes.toLocaleString()} foot="不受时间范围影响" />
    </section>
    <section className="section-block"><div className="section-title"><div><span className="section-kicker">题库管理</span><h2>继续扩充你的练习范围</h2></div><button className="text-button" onClick={onImport}><FileUp size={16} />导入题库</button></div></section>
  </>;
}

function Stat({ icon, label, value, foot }: { icon: React.ReactNode; label: string; value: string; foot: string }) {
  return <article className="stat-card"><span className="stat-icon">{icon}</span><span>{label}</span><strong>{value}</strong><small>{foot}</small></article>;
}

function EmptyImport({ onImport }: { onImport: () => void }) {
  return <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入题库</strong><small>支持 JSON / XLSX，数据只写入本机</small></div><ChevronRight size={18} /></button>;
}

function PreferencesView({ preferences, rounds, banks, pendingSync, onNotice, onChange, onRestored }: { preferences: PracticePreferences; rounds: readonly ReviewRound[]; banks: readonly BankV6[]; pendingSync: number; onNotice: (message: string) => void; onChange: (value: PracticePreferences) => void; onRestored: (message: string) => void }) {
  const interactionItems: Array<{ key: "submitOnSelect" | "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions" | "multiSelectAllAutoSubmit"; title: string; detail: string }> = [
    { key: "submitOnSelect", title: "选择后立即提交", detail: "默认开启，仅用于单选题和判断题；关闭后选择只会高亮，需要点击“确认答案”或按回车提交。" },
    { key: "autoNextCorrect", title: "答对后自动下一题", detail: "单选题和判断题选对后自动前进；多选题确认答案正确后自动前进。" },
    { key: "showAnswerOnWrong", title: "答错显示正确答案", detail: "立即标出错误选项和正确选项，方便当场纠正记忆。" },
    { key: "swipeNavigation", title: "左右滑动切换题目", detail: "向左滑进入下一题，向右滑返回上一题。" },
    { key: "shuffleOptions", title: "随机排列选项", detail: "仅随机单选题和多选题；判断题和计算题不受影响。" },
    { key: "multiSelectAllAutoSubmit", title: "多选题全选后自动确认", detail: "点击“全选”后立即提交答案；关闭后只选中全部选项，可继续取消选项再手动确认。" },
  ];
  const feedbackItems: Array<{ key: "feedbackSound" | "feedbackHaptics"; title: string; detail: string }> = [
    { key: "feedbackSound", title: "答题提示音", detail: "用轻提示音区分答对和答错；系统静音时可能不播放。" },
    { key: "feedbackHaptics", title: "答题振动反馈", detail: "vibrate" in navigator ? "支持振动的手机会在判题后给出轻触反馈。" : "iPhone/Safari 不支持振动，此选项仅在 Android 上生效。" },
  ];
  const toggleRow = (item: { key: keyof Pick<PracticePreferences, "submitOnSelect" | "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions" | "multiSelectAllAutoSubmit" | "feedbackSound" | "feedbackHaptics" | "requireAllAnswered">; title: string; detail: string }) => <label aria-label={item.title} className="preference-row" key={item.key}><div><strong>{item.title}</strong><p>{item.detail}</p></div><input aria-label={item.title} type="checkbox" checked={Boolean(preferences[item.key])} onChange={(event) => onChange({ ...preferences, [item.key]: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>;
  return <><div className="page-heading compact"><div><p className="eyebrow">练习偏好</p><h1>答题配置</h1><p>设置只保存在当前浏览器，不会修改题库内容。</p></div></div><div className="preferences-view">
    <section className="preference-card"><div className="settings-title"><span><Moon /></span><div><h2>外观主题</h2><p>可以跟随手机或电脑的系统外观，也可以固定使用浅色或深色。</p></div></div>
      <ThemeSetting value={preferences.themeMode} onChange={(themeMode) => onChange({ ...preferences, themeMode })} />
    </section>
    <section className="preference-card"><div className="settings-title"><span><Settings2 /></span><div><h2>答题交互</h2><p>根据自己的背题节奏随时调整。</p></div></div>
      <div className="preference-list">
        <GroupSizeSetting value={preferences.groupSize} onChange={(groupSize) => onChange({ ...preferences, groupSize })} />
        {interactionItems.map(toggleRow)}
        <div className="mobile-question-transition"><PreferenceSelect title="切换题目方式" detail="“滑动”会像阅读页面一样平滑切入；“立即”直接显示目标题目。" value={preferences.questionTransition} onChange={(value) => onChange({ ...preferences, questionTransition: value as PracticePreferences["questionTransition"] })} options={[["instant", "立即"], ["slide", "滑动"]]} /></div>
        <PreferenceSelect title="自动下一题等待时间" detail="答对后留出查看反馈的时间；选择立即可最快连续刷题。" value={String(preferences.autoNextDelayMs)} onChange={(value) => onChange({ ...preferences, autoNextDelayMs: Number(value) as PracticePreferences["autoNextDelayMs"] })} options={[['0','立即'],['500','0.5 秒'],['1000','1 秒'],['2000','2 秒']]} />
      </div>
    </section>
    <div className="desktop-shortcut-settings"><ShortcutSetting value={preferences.keyboardShortcuts} onChange={(keyboardShortcuts) => onChange({ ...preferences, keyboardShortcuts })} /></div>
    <section className="preference-card"><div className="settings-title"><span><ListFilter /></span><div><h2>出题与复习</h2><p>控制抽题分布、默认顺序和错题复习节奏。</p></div></div><div className="preference-list">
      <ProgressScopeSetting value={preferences.progressScope} rounds={rounds} onChange={(progressScope) => onChange({ ...preferences, progressScope })} />
      <PreferenceSelect title="随机组题型分布" detail="均衡抽取会尽量平均包含单选、多选、判断、计算；不足的题型由其他题型补足。" value={preferences.randomTypeBalance} onChange={(value) => onChange({ ...preferences, randomTypeBalance: value as PracticePreferences["randomTypeBalance"] })} options={[['balanced','尽量均衡'],['natural','按题库自然比例']]} />
      <PreferenceSelect title="默认题目顺序" detail="进入练习中心和高级筛选时默认使用的题目顺序。" value={preferences.defaultOrder} onChange={(value) => onChange({ ...preferences, defaultOrder: value as PracticePreferences["defaultOrder"] })} options={[['sequential','题库顺序'],['random','随机打乱'],['difficulty','难题优先']]} />
      <PreferenceSelect title="答错后的复习方式" detail="立即重答会在当前题显示按钮；本组结束可在成绩页集中重练；留到下次进入错题练习。" value={preferences.wrongReappearance} onChange={(value) => onChange({ ...preferences, wrongReappearance: value as PracticePreferences["wrongReappearance"] })} options={[['immediate','立即重答'],['end','本组结束集中重练'],['next','留到下次错题练习']]} />
      <PreferenceSelect title="连续答对后移出错题" detail="题目答错或选择“不会”后进入错题；达到连续正确次数后自动移除。" value={String(preferences.wrongRemovalStreak)} onChange={(value) => onChange({ ...preferences, wrongRemovalStreak: Number(value) })} options={[['1','1 次'],['2','2 次'],['3','3 次'],['5','5 次']]} />
      <ToleranceSetting value={preferences.calculationTolerancePercent} onChange={(calculationTolerancePercent) => onChange({ ...preferences, calculationTolerancePercent })} />
      {toggleRow({ key: "requireAllAnswered", title: "必须答完才能结束", detail: "打开后点击查看结果会自动定位到第一道未答题，不允许带着空题结束。" })}
    </div></section>
    <ReviewRoundManager
      rounds={rounds}
      banks={banks}
      onCreate={async (name, bankIds) => { await createReviewRoundV6({ name, bankIds }); onNotice(`已创建复习轮次「${name}」`); }}
      onUpdate={async (roundId, name, bankIds) => { await updateReviewRoundV6(roundId, { name, bankIds }); onNotice("复习轮次已更新"); }}
      onComplete={async (roundId) => { await completeReviewRoundV6(roundId); onNotice("复习轮次已完成并保存最终快照"); }}
      onArchive={async (roundId) => { await archiveReviewRoundV6(roundId); onNotice("复习轮次已归档"); }}
    />
    <ImageCacheSetting onNotice={onNotice} />
    <section className="preference-card"><div className="settings-title"><span><Target /></span><div><h2>阅读、反馈与目标</h2><p>调整显示密度，设置每天的练习目标。</p></div></div><div className="preference-list">
      <PreferenceSelect title="答题字号" detail="只调整题干与选项的阅读字号，不影响题目内容。" value={preferences.fontSize} onChange={(value) => onChange({ ...preferences, fontSize: value as PracticePreferences["fontSize"] })} options={[['small','较小'],['standard','标准'],['large','较大'],['xlarge','特大']]} />
      <GoalSetting count={preferences.dailyGoalCount} accuracy={preferences.dailyGoalAccuracy} onChange={(dailyGoalCount, dailyGoalAccuracy) => onChange({ ...preferences, dailyGoalCount, dailyGoalAccuracy })} />
      {feedbackItems.map(toggleRow)}
    </div></section>
    <SyncAutomationSetting preferences={preferences} onChange={onChange} />
    <BuildVersionCard />
    <div className="mobile-sync-settings"><SyncView pending={pendingSync} onNotice={onNotice} onRestored={onRestored} /></div>
  </div></>;
}

function ImageCacheSetting({ onNotice }: { onNotice: (message: string) => void }) {
  const cachedBytes = useLiveQuery(() => getImageCacheSizeV6(), []) ?? 0;
  const [busy, setBusy] = useState(false);
  const [assetCount, setAssetCount] = useState<number | undefined>();

  async function refreshStats() {
    try {
      const facade = await import("@/lib/github-sync") as unknown as { getImageCacheStats?: () => Promise<unknown> };
      const stats = await facade.getImageCacheStats?.();
      if (stats && typeof stats === "object" && "cached" in stats) {
        const count = Number((stats as { cached?: unknown }).cached);
        if (Number.isFinite(count)) setAssetCount(count);
      }
    } catch { /* image facade is optional on older builds */ }
  }

  async function cacheAll() {
    if (busy) return;
    const settings = loadGitHubSettings();
    const token = loadGitHubToken();
    if (!settings.repo || !token) { onNotice("请先在同步页面配置 GitHub，才能缓存远程图片"); return; }
    setBusy(true);
    try {
      const facade = await import("@/lib/github-sync") as unknown as { downloadAllImageAssets?: (settings: GitHubSettings, token: string) => Promise<unknown> };
      if (!facade.downloadAllImageAssets) { onNotice("当前同步版本暂不支持批量图片缓存"); return; }
      await facade.downloadAllImageAssets(settings, token);
      await refreshStats();
      onNotice("图片缓存已更新");
    } catch (error) { onNotice(error instanceof Error ? error.message : "图片缓存失败"); }
    finally { setBusy(false); }
  }

  async function clearCache() {
    if (busy) return;
    setBusy(true);
    try {
      const facade = await import("@/lib/github-sync") as unknown as { clearImageCache?: () => Promise<unknown> };
      if (facade.clearImageCache) await facade.clearImageCache();
      else await clearImageCacheV6();
      setAssetCount(0);
      onNotice("本机图片缓存已清理");
    } catch (error) { onNotice(error instanceof Error ? error.message : "清理图片缓存失败"); }
    finally { setBusy(false); }
  }

  return <section className="preference-card image-cache-setting"><div className="settings-title"><span><Cloud /></span><div><h2>图片缓存</h2><p>图片只保存在本机缓存，不会在题目中写入 URL。离线时仍可查看已缓存图片。</p></div></div><div className="image-cache-actions"><span>已缓存 {assetCount === undefined ? "—" : assetCount.toLocaleString()} 个文件 · {(cachedBytes / 1024 / 1024).toFixed(1)} MB</span><div className="image-cache-buttons"><button type="button" className="primary" disabled={busy} onClick={() => void cacheAll()}>{busy ? "处理中…" : "缓存全部图片"}</button><button type="button" className="danger-button" disabled={busy} onClick={() => void clearCache()}>清空缓存</button></div></div></section>;
}

function SyncAutomationSetting({ preferences, onChange }: { preferences: PracticePreferences; onChange: (value: PracticePreferences) => void }) {
  return <section className="preference-card"><div className="settings-title"><span><Cloud /></span><div><h2>后台同步</h2><p>两项功能默认关闭，开启后使用 v7 变更集和热窗口增量同步。</p></div></div><div className="preference-list">
    <label className="preference-row"><div><strong>累计事件后自动同步</strong><p>本地待同步事件达到设定数量时，在后台完成拉取、合并和上传。</p></div><input aria-label="累计事件后自动同步" type="checkbox" checked={preferences.autoSyncEnabled} onChange={(event) => onChange({ ...preferences, autoSyncEnabled: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>
    {preferences.autoSyncEnabled && <NumberPreference title="自动同步阈值" detail="本地累计多少条待同步事件后开始同步，可填写 1–1000。" value={preferences.autoSyncEventThreshold} min={1} max={1000} unit="条" onChange={(autoSyncEventThreshold) => onChange({ ...preferences, autoSyncEventThreshold })} />}
    <label className="preference-row"><div><strong>定期拉取远程数据</strong><p>只下载并合并其他设备的新数据，不会主动上传当前设备的数据。</p></div><input aria-label="定期拉取远程数据" type="checkbox" checked={preferences.periodicPullEnabled} onChange={(event) => onChange({ ...preferences, periodicPullEnabled: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>
    {preferences.periodicPullEnabled && <NumberPreference title="远程拉取间隔" detail="最短 30 秒；页面保持打开时生效。" value={preferences.periodicPullSeconds} min={30} max={86400} unit="秒" onChange={(periodicPullSeconds) => onChange({ ...preferences, periodicPullSeconds })} />}
  </div></section>;
}

function NumberPreference({ title, detail, value, min, max, unit, onChange }: { title: string; detail: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const next = Math.min(max, Math.max(min, Math.floor(Number(draft) || value)));
    setDraft(String(next));
    onChange(next);
  };
  return <label className="preference-row number-preference"><div><strong>{title}</strong><p>{detail}</p></div><span className="number-setting"><input aria-label={title} type="number" min={min} max={max} inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>{unit}</em></span></label>;
}

function ThemeSetting({ value, onChange }: { value: PracticePreferences["themeMode"]; onChange: (value: PracticePreferences["themeMode"]) => void }) {
  const choices: Array<{ value: PracticePreferences["themeMode"]; label: string; detail: string; icon: React.ReactNode }> = [
    { value: "system", label: "跟随系统", detail: "随系统自动切换", icon: <Monitor size={19} /> },
    { value: "light", label: "浅色", detail: "始终使用浅色", icon: <Sun size={19} /> },
    { value: "dark", label: "深色", detail: "始终使用夜间模式", icon: <Moon size={19} /> },
  ];
  return <div className="theme-setting" role="radiogroup" aria-label="外观主题">{choices.map((choice) => <button type="button" role="radio" aria-checked={value === choice.value} className={value === choice.value ? "active" : ""} key={choice.value} onClick={() => onChange(choice.value)}><span>{choice.icon}</span><strong>{choice.label}</strong><small>{choice.detail}</small>{value === choice.value && <Check size={15} />}</button>)}</div>;
}

function PreferenceSelect({ title, detail, value, options, onChange }: { title: string; detail: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  const selectId = `preference-select-${title}`;
  return <label htmlFor={selectId} className="preference-row select-preference"><div><strong>{title}</strong><p>{detail}</p></div><AppSelect id={selectId} ariaLabel={title} value={value} onValueChange={onChange} options={options.map(([optionValue, label]) => ({ value: optionValue, label }))} /></label>;
}

function GoalSetting({ count, accuracy, onChange }: { count: number; accuracy: number; onChange: (count: number, accuracy: number) => void }) {
  return <div className="preference-row goal-preference"><div><strong>每日练习目标</strong><p>首页按当天实际作答次数与正确率显示完成进度。</p></div><span><label>题数<input aria-label="每日目标题数" type="number" min="1" max="1000" value={count} onChange={(event) => onChange(Math.min(1000, Math.max(1, Number(event.target.value) || 1)), accuracy)} /></label><label>正确率<input aria-label="每日目标正确率" type="number" min="1" max="100" value={accuracy} onChange={(event) => onChange(count, Math.min(100, Math.max(1, Number(event.target.value) || 1)))} /><em>%</em></label></span></div>;
}

function GroupSizeSetting({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  function commit() {
    const next = Math.min(500, Math.max(1, Math.floor(Number(draft) || value || 30)));
    setDraft(String(next));
    onChange(next);
  }
  return <label className="preference-row number-preference"><div><strong>每组题目数量</strong><p>用于首页推荐和“随机一组”练习；可填写 1–500 题。</p></div><span className="number-setting"><input aria-label="每组题目数量" type="number" min="1" max="500" step="1" inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>题</em></span></label>;
}

function ToleranceSetting({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  function commit() {
    const parsed = Number(draft);
    const next = Math.min(100, Math.max(0, Number.isFinite(parsed) ? parsed : value));
    setDraft(String(next));
    onChange(next);
  }
  return <label className="preference-row number-preference"><div><strong>计算题允许误差</strong><p>按标准答案的相对误差比例判定；例如答案 100、误差 1% 时，99–101 都算正确。</p></div><span className="number-setting"><input aria-label="计算题允许误差" type="number" min="0" max="100" step="0.1" inputMode="decimal" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>%</em></span></label>;
}

function BuildVersionCard() {
  const builtAt = formatBuildTimestamp();
  return <section className="preference-card version-card"><div className="settings-title"><span><BadgeInfo /></span><div><h2>客户端版本</h2><p>用于确认当前设备是否已经加载最新发布版本。</p></div></div><dl><div><dt>提交哈希</dt><dd><code>{__APP_COMMIT_SHA__.slice(0, 12)}</code></dd></div><div><dt>提交时间</dt><dd>{builtAt}</dd></div></dl></section>;
}

function Practice({ runId, question, initialState, optionOrder, questionIds, questionTypes, answers, index, total, modeLabel, preferences, onStateChange, onJump, onFavorite, onPrevious, onNext, onFinish, onExit }: { runId: string; question: Question; initialState?: PracticeAnswerState; optionOrder?: number[]; questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; index: number; total: number; modeLabel: string; preferences: PracticePreferences; onStateChange: (state: PracticeAnswerState) => void; onJump: (index: number) => void; onFavorite: () => Promise<void>; onPrevious: () => void; onNext: () => void; onFinish: () => void; onExit: () => void }) {
  const [selected, setSelected] = useState<string[]>(initialState?.selected ?? []);
  const [submitted, setSubmitted] = useState(initialState?.submitted ?? false);
  const [calculationDraft, setCalculationDraft] = useState(question.type === "计算" ? initialState?.selected[0] ?? "" : "");
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [startedAt] = useState(() => Date.now());
  const note = useLiveQuery(() => dbV6.notes.get(question.id), [question.id]);
  const attemptSummary = useLiveQuery(async () => summarizeV6AttemptStats(await dbV6.attemptStats.get(question.id)), [question.id]) ?? summarizeV6AttemptStats();
  const [draft, setDraft] = useState<string | null>(null);
  const [noteEditing, setNoteEditing] = useState(false);
  // 换题时退出编辑态（React 官方「渲染期间调整状态」模式，替代 effect 内 setState）。
  const lastNoteQuestionId = useRef(question.id);
  if (lastNoteQuestionId.current !== question.id) {
    lastNoteQuestionId.current = question.id;
    if (noteEditing) setNoteEditing(false);
  }
  const [noteSaveStatus, setNoteSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const autoNextTimer = useRef<number | undefined>(undefined);
  const copyStatusTimer = useRef<number | undefined>(undefined);
  const noteSaveTimer = useRef<number | undefined>(undefined);
  const draftRef = useRef("");
  const noteDirty = useRef(false);
  const answering = useRef(false);
  const chooseShortcutRef = useRef<(letter: string) => void>(() => undefined);
  const submitShortcutRef = useRef<() => void>(() => undefined);
  const questionCardRef = useRef<HTMLElement>(null);
  const swipeGesture = useRef<{ startX: number; startY: number; lastX: number; lastY: number; startScrollTop: number; axis: "pending" | "horizontal" | "vertical" } | null>(null);
  const effectiveDraft = draft ?? note?.content ?? "";
  const displayOrder = optionOrder?.length === question.options.length ? optionOrder : question.options.map((_, optionIndex) => optionIndex);
  const displayAnswer = displayedAnswer(question, displayOrder);
  const selectedCanonical = question.type === "计算" ? selected[0] ?? "" : [...selected].sort().join("");
  const selectedAnswer = question.type === "计算" ? selectedCanonical : selected
    .map((letter) => displayOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((displayIndex) => displayIndex >= 0)
    .map((displayIndex) => String.fromCharCode(65 + displayIndex))
    .sort()
    .join("");
  const correct = submitted && (question.type === "计算"
    ? isCalculationAnswerCorrect(selectedCanonical, question.answer, preferences.calculationTolerancePercent)
    : selectedCanonical === [...question.answer].sort().join(""));
  const gaveUp = submitted && selected.length === 0;
  const revealAnswer = submitted && (correct || preferences.showAnswerOnWrong);
  const isLast = index === total - 1;

  useEffect(() => {
    if (draft === null && note?.content !== undefined) draftRef.current = note.content;
  }, [draft, note?.content]);

  useEffect(() => () => {
    window.clearTimeout(autoNextTimer.current);
    window.clearTimeout(copyStatusTimer.current);
    window.clearTimeout(noteSaveTimer.current);
    if (noteDirty.current) void saveNote(question.id, draftRef.current);
  }, [question.id]);

  async function persistNoteDraft() {
    const content = draftRef.current;
    setNoteSaveStatus("saving");
    await saveNote(question.id, content);
    if (draftRef.current === content) {
      noteDirty.current = false;
      setNoteSaveStatus("saved");
    }
  }

  function changeNoteDraft(value: string) {
    setDraft(value);
    draftRef.current = value;
    noteDirty.current = true;
    setNoteSaveStatus("idle");
    window.clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = window.setTimeout(() => void persistNoteDraft(), 650);
  }

  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditingText = target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (editing || overviewOpen || isEditingText) return;
      const shortcut = resolveKeyboardShortcut(preferences.keyboardShortcuts, event);
      if (shortcut?.type === "option" && !event.repeat && !submitted && shortcut.optionIndex < displayOrder.length) {
        event.preventDefault();
        const originalIndex = displayOrder[shortcut.optionIndex];
        chooseShortcutRef.current(String.fromCharCode(65 + originalIndex));
      } else if (shortcut?.type === "confirm" && !event.repeat && !submitted) {
        event.preventDefault();
        submitShortcutRef.current();
      } else if (shortcut?.type === "previous" && index > 0) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onPrevious();
      } else if (shortcut?.type === "next" && !isLast) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onNext();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayOrder, editing, overviewOpen, index, isLast, onNext, onPrevious, preferences.keyboardShortcuts, submitted]);

  useEffect(() => {
    const card = questionCardRef.current;
    if (!card || !preferences.swipeNavigation) return;
    const interactiveSelector = "input, textarea, select, a, [contenteditable='true'], .practice-head button, .question-meta button, .practice-actions button";
    const resetGesture = () => { swipeGesture.current = null; };
    const onTouchStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.touches.length !== 1 || target?.closest(interactiveSelector)) {
        resetGesture();
        return;
      }
      const touch = event.touches[0];
      const workspace = card.closest<HTMLElement>(".workspace");
      swipeGesture.current = { startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, startScrollTop: workspace?.scrollTop ?? 0, axis: "pending" };
    };
    const onTouchMove = (event: TouchEvent) => {
      const gesture = swipeGesture.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      const horizontalDistance = Math.abs(dx);
      const verticalDistance = Math.abs(dy);
      if (gesture.axis === "pending") {
        if (Math.hypot(dx, dy) < 12) return;
        gesture.axis = horizontalDistance >= verticalDistance * .8 ? "horizontal" : "vertical";
      }
      if (gesture.axis !== "horizontal") return;
      if (event.cancelable) event.preventDefault();
      const workspace = card.closest<HTMLElement>(".workspace");
      if (workspace && workspace.scrollTop !== gesture.startScrollTop) workspace.scrollTop = gesture.startScrollTop;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const gesture = swipeGesture.current;
      resetGesture();
      if (!gesture || gesture.axis !== "horizontal") return;
      const touch = event.changedTouches[0];
      const dx = (touch?.clientX ?? gesture.lastX) - gesture.startX;
      const dy = (touch?.clientY ?? gesture.lastY) - gesture.startY;
      const workspace = card.closest<HTMLElement>(".workspace");
      if (workspace) workspace.scrollTop = gesture.startScrollTop;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * .8) return;
      window.clearTimeout(autoNextTimer.current);
      if (dx < 0 && !isLast) onNext();
      else if (dx > 0 && index > 0) onPrevious();
      else return;
      window.requestAnimationFrame(() => workspace?.scrollTo({ top: 0, behavior: "auto" }));
    };
    card.addEventListener("touchstart", onTouchStart, { passive: true });
    card.addEventListener("touchmove", onTouchMove, { passive: false });
    card.addEventListener("touchend", onTouchEnd, { passive: true });
    card.addEventListener("touchcancel", resetGesture, { passive: true });
    return () => {
      card.removeEventListener("touchstart", onTouchStart);
      card.removeEventListener("touchmove", onTouchMove);
      card.removeEventListener("touchend", onTouchEnd);
      card.removeEventListener("touchcancel", resetGesture);
    };
  }, [index, isLast, onNext, onPrevious, preferences.swipeNavigation]);

  async function choose(letter: string) {
    if (submitted) return;
    if (question.type === "多选") {
      const next = selected.includes(letter) ? selected.filter((item) => item !== letter) : [...selected, letter];
      setSelected(next);
      onStateChange({ selected: next, submitted: false });
      return;
    }
    const value = [letter];
    setSelected(value);
    onStateChange({ selected: value, submitted: false });
    if (shouldSubmitOnChoice(question.type, preferences.submitOnSelect)) await submit(value);
  }

  chooseShortcutRef.current = (letter) => { void choose(letter); };

  async function selectAllOptions() {
    if (submitted || question.type !== "多选") return;
    const all = question.options.map((_, optionIndex) => String.fromCharCode(65 + optionIndex));
    setSelected(all);
    onStateChange({ selected: all, submitted: false });
    if (preferences.multiSelectAllAutoSubmit) await submit(all);
  }

  async function submit(valueList = selected) {
    const value = question.type === "计算" ? calculationDraft.trim() : [...valueList].sort().join("");
    if (!value || (question.type === "计算" && !Number.isFinite(Number(value))) || submitted || answering.current) return;
    answering.current = true;
    const finalSelection = question.type === "计算" ? [value] : valueList;
    const isCorrect = question.type === "计算"
      ? isCalculationAnswerCorrect(value, question.answer, preferences.calculationTolerancePercent)
      : value === [...question.answer].sort().join("");
    try {
      const result = await recordPracticeAnswer({ runId, questionId: question.id, bankId: question.bankId, selected: finalSelection, correct: isCorrect, elapsedMs: Date.now() - startedAt });
      setSelected(finalSelection);
      setSubmitted(true);
      onStateChange(result.answer);
    } catch {
      answering.current = false;
      return;
    }
    playAnswerFeedback(isCorrect, preferences);
    if (isCorrect && preferences.autoNextCorrect && !isLast) {
      setAutoAdvancing(true);
      autoNextTimer.current = window.setTimeout(onNext, preferences.autoNextDelayMs);
    }
  }

  submitShortcutRef.current = () => { void submit(); };

  async function giveUp() {
    if (submitted || answering.current) return;
    answering.current = true;
    try {
      const result = await recordPracticeAnswer({ runId, questionId: question.id, bankId: question.bankId, selected: [], correct: false, elapsedMs: Date.now() - startedAt });
      setSelected([]);
      setCalculationDraft("");
      setSubmitted(true);
      onStateChange(result.answer);
    } catch {
      answering.current = false;
      return;
    }
    playAnswerFeedback(false, preferences);
  }

  function retryQuestion() {
    window.clearTimeout(autoNextTimer.current);
    answering.current = false;
    setSelected([]);
    setCalculationDraft("");
    setSubmitted(false);
    setAutoAdvancing(false);
    onStateChange({ selected: [], submitted: false });
  }

  async function copyQuestion() {
    const optionLines = displayOrder.map((originalIndex, displayIndex) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`);
    const lines = [
      `题型：${question.type}`,
      `题目：${question.stem}`,
      "选项：",
      ...optionLines,
    ];
    if (submitted) {
      lines.push(`正确答案：${displayAnswer}`, `答案内容：${answerText(question, displayOrder)}`);
    }
    const text = lines.join("\n");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("Copy command failed");
        setCopyStatus("copied");
      } catch { setCopyStatus("error"); }
    }
    window.clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current = window.setTimeout(() => setCopyStatus("idle"), 1800);
  }

  return <><div className="practice-layout"><section ref={questionCardRef} className="question-card" data-no-pull-refresh><div className="practice-head"><button className="icon-button" aria-label="暂停并返回首页" onClick={onExit}><X size={19} /></button><div className="practice-progress"><span>{index + 1} / {total} · {modeLabel}</span><i><b style={{ width: `${(index + 1) / total * 100}%` }} /></i></div><div className="practice-head-actions"><button className="icon-button overview-trigger" aria-label="打开题目总览" onClick={() => setOverviewOpen(true)}><Grid3X3 size={18} /></button></div></div>
    <div className="question-body"><div className="question-meta"><span>{question.bankName}</span><em className="question-type-chip">{question.type}</em><em className={`difficulty-chip difficulty-${difficultyTone(attemptSummary.difficulty)}`}>难度 {attemptSummary.difficulty} · {difficultyLabel(attemptSummary.difficulty)}</em>{question.tags.map((tag) => <em key={tag}>{tag}</em>)}<button className={`copy-question ${copyStatus}`} aria-label={submitted ? "复制题目、选项和答案" : "复制题目和选项"} onClick={() => void copyQuestion()}>{copyStatus === "copied" ? <ClipboardCheck size={14} /> : <Copy size={14} />}{copyStatus === "copied" ? "已复制" : copyStatus === "error" ? "复制失败" : submitted ? "复制题目和答案" : "复制题目"}</button><button className={`favorite-question ${question.favorite ? "active" : ""}`} aria-label={question.favorite ? "取消收藏" : "收藏题目"} aria-pressed={Boolean(question.favorite)} onClick={() => void onFavorite()}><Star size={14} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button className="edit-question-link" onClick={() => setEditing(true)}><Pencil size={13} />编辑题目</button></div><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV6} className="practice-stem" />{question.type === "多选" && !submitted && <div className="multi-select-toolbar"><span>多选题</span><small>{preferences.multiSelectAllAutoSubmit ? "全选后自动确认" : "全选后可继续调整"}</small><button type="button" onClick={() => void selectAllOptions()}><CheckCheck size={15} />全选</button></div>}{question.type === "计算" ? <div className={`calculation-answer ${submitted ? correct ? "correct" : "wrong" : ""}`}><label htmlFor={`calculation-answer-${question.id}`}>输入计算结果</label><input id={`calculation-answer-${question.id}`} aria-label="计算题答案" type="number" inputMode="decimal" value={submitted ? selectedCanonical : calculationDraft} disabled={submitted} onChange={(event) => setCalculationDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} placeholder={`允许误差 ${preferences.calculationTolerancePercent}%`} /><small>按标准答案的相对误差 ±{preferences.calculationTolerancePercent}% 判定</small></div> : <div className="options">{displayOrder.map((originalIndex, displayIndex) => { const option = question.canonical.options[originalIndex] ?? []; const originalLetter = String.fromCharCode(65 + originalIndex); const displayLetter = String.fromCharCode(65 + displayIndex); const isAnswer = revealAnswer && question.answer.includes(originalLetter); const isWrong = submitted && selected.includes(originalLetter) && !question.answer.includes(originalLetter); return <button key={originalLetter} className={`${selected.includes(originalLetter) ? "selected" : ""} ${isAnswer ? "right" : ""} ${isWrong ? "wrong" : ""}`} onClick={() => { if (!window.getSelection()?.toString()) void choose(originalLetter); }}><span>{displayLetter}</span><ContentBlockRenderer blocks={option} loadAsset={loadImageAssetV6} className="practice-option-content" />{isAnswer && <i className="option-status option-status-right" aria-hidden="true"><Check size={18} /></i>}{isWrong && <i className="option-status option-status-wrong" aria-hidden="true"><X size={18} /></i>}</button>; })}</div>}
      {submitted && <><div className={`result-box ${correct ? "success" : "error"}`}><strong>{correct ? (autoAdvancing ? "回答正确，即将进入下一题" : "回答正确") : gaveUp ? "已标记为不会，并计入错题" : "这次没有答对"}</strong>{correct ? <p>正确答案：{displayAnswer}</p> : preferences.showAnswerOnWrong ? <p>正确答案：{displayAnswer}｜你的选择：{selectedAnswer || "不会"}</p> : <p>正确答案已按配置隐藏｜你的选择：{selectedAnswer || "不会"}</p>}</div><div className="attempt-summary"><span><strong>{attemptSummary.total}</strong>总作答</span><span className="correct"><strong>{attemptSummary.correct}</strong>正确</span><span className="wrong"><strong>{attemptSummary.wrong}</strong>错误</span><span className={`difficulty difficulty-${difficultyTone(attemptSummary.difficulty)}`}><strong>{attemptSummary.difficulty}</strong>难度 · {difficultyLabel(attemptSummary.difficulty)}</span></div></>}
      {preferences.keyboardShortcuts.enabled && <div className="keyboard-hint">快捷键：确认 <kbd>{preferences.keyboardShortcuts.bindings.confirm.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd> · 上一题 <kbd>{preferences.keyboardShortcuts.bindings.previous.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd> · 下一题 <kbd>{preferences.keyboardShortcuts.bindings.next.map(formatKeyboardShortcut).join(" / ") || "未设置"}</kbd></div>}
      {preferences.swipeNavigation && <div className="swipe-hint"><ChevronLeft size={15} />右滑上一题 · 左滑下一题<ChevronRight size={15} /></div>}
    </div><div className={`practice-actions ${submitted ? "submitted" : ""} ${submitted && !correct && preferences.wrongReappearance === "immediate" ? "with-retry" : ""}`}><button className="secondary-action practice-previous" onClick={onPrevious} disabled={index === 0}><ChevronLeft size={18} />上一题</button><div>{!submitted && <button className="dont-know-action" onClick={() => void giveUp()}><CircleHelp size={17} />不会</button>}{!submitted && question.type !== "多选" && question.type !== "计算" && preferences.submitOnSelect && <span className="answer-action-hint">选择答案后立即判定</span>}{!submitted && (question.type === "计算" || question.type === "多选" || !preferences.submitOnSelect) && <button className="primary practice-submit" disabled={question.type === "计算" ? !calculationDraft.trim() || !Number.isFinite(Number(calculationDraft)) : !selected.length} onClick={() => void submit()}>确认答案</button>}{submitted && !correct && preferences.wrongReappearance === "immediate" && <button className="secondary-action retry-question" onClick={retryQuestion}><RefreshCw size={16} />立即重答</button>}{autoAdvancing ? <span className="answer-action-hint practice-auto-status">正在自动前进…</span> : <button className="practice-next" onClick={isLast ? onFinish : onNext}>{isLast ? "查看本次结果" : "下一题"}<ChevronRight size={18} /></button>}</div></div></section>
    {submitted && <aside className="note-panel"><div><NotebookPen size={18} /><strong>我的解析</strong></div>{!noteEditing && effectiveDraft.trim() ? <div className="note-panel-view" role="button" tabIndex={0} aria-label="编辑解析，支持 Markdown 与 LaTeX" onClick={() => setNoteEditing(true)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setNoteEditing(true); } }}><NoteMarkdown text={effectiveDraft} /></div> : <textarea value={effectiveDraft} onChange={(event) => changeNoteDraft(event.target.value)} onFocus={() => setNoteEditing(true)} onBlur={() => { if (effectiveDraft.trim()) setNoteEditing(false); }} placeholder="写下错因、口诀或区分条件…（支持 Markdown 与 LaTeX）" />}<span className={`note-save-status ${noteSaveStatus}`}>{noteSaveStatus === "saving" ? "正在自动保存…" : noteSaveStatus === "saved" ? "已自动保存" : "输入后自动保存"}</span><button className="edit-question-button" onClick={() => setEditing(true)}><Pencil size={15} />编辑题目与标签</button><small>切换题目或离开页面前会自动保存解析。</small></aside>}</div>{overviewOpen && <QuestionOverview questionIds={questionIds} questionTypes={questionTypes} answers={answers} currentIndex={index} onClose={() => setOverviewOpen(false)} onJump={(target) => { window.clearTimeout(autoNextTimer.current); onJump(target); setOverviewOpen(false); }} />}{editing && <SharedQuestionEditor question={question.canonical} preferredBankId={question.bankId} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} />}</>;
}

function QuestionOverview({ questionIds, questionTypes, answers, currentIndex, onClose, onJump }: { questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; currentIndex: number; onClose: () => void; onJump: (index: number) => void }) {
  const groupsRef = useRef<HTMLDivElement>(null);
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const answered = questionIds.filter((id) => answers[id]?.submitted).length;
  const correct = questionIds.filter((id) => answers[id]?.submitted && answers[id]?.correct).length;
  const wrong = answered - correct;
  const accuracy = answered ? Math.round(correct / answered * 100) : 0;
  const progress = questionOverviewProgress(answered, questionIds.length);

  // Bring the current question into the middle of the grid. The scroll formula
  // centres the focused button; when the current question is near either end it
  // cannot be centred, so the browser clamps scrollTop to the top/bottom limit
  // and the row rests against that edge instead.
  useLayoutEffect(() => {
    const groups = groupsRef.current;
    const button = focusButtonRef.current;
    if (!groups || !button) return;
    const groupsBox = groups.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    groups.scrollTop += buttonBox.top + buttonBox.height / 2 - groupsBox.top - groupsBox.height / 2;
  }, [currentIndex]);

  return <ModalPortal><div className="overview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="question-overview" role="dialog" aria-modal="true" aria-label="题目总览"><header><div><span className="section-kicker">练习导航</span><h2>题目总览</h2><p>已作答 {answered} / {questionIds.length}，点击题号快速切换。</p></div><button className="icon-button" aria-label="关闭题目总览" onClick={onClose}><X size={19} /></button></header><div className="overview-score"><span><strong>{correct}</strong>正确</span><span><strong>{wrong}</strong>错误</span><span><strong>{accuracy}%</strong>正确率</span><span><strong>{progress}</strong>进度</span></div><div className="overview-legend"><span><i className="correct" />正确</span><span><i className="wrong" />错误</span><span><i className="pending" />已选择</span><span><i />未作答</span></div><div className="overview-groups" ref={groupsRef}>{TYPE_ORDER.map((type) => { const group = questionIds.map((id, questionIndex) => ({ id, questionIndex })).filter(({ id }) => questionTypes[id] === type); return <section className="overview-group" key={type}><div><h3>{type}</h3><span>{group.length} 题</span></div>{group.length ? <div className="overview-number-grid">{group.map(({ id, questionIndex }) => { const answer = answers[id]; const state = answer?.submitted ? answer.correct ? "correct" : "wrong" : answer?.selected.length ? "pending" : "blank"; return <button ref={questionIndex === currentIndex ? focusButtonRef : undefined} data-overview-focus={questionIndex === currentIndex ? "true" : undefined} key={`${id}-${questionIndex}`} className={`${state} ${questionIndex === currentIndex ? "current" : ""}`} aria-label={`第 ${questionIndex + 1} 题，${type}`} aria-current={questionIndex === currentIndex ? "true" : undefined} onClick={() => onJump(questionIndex)}>{questionIndex + 1}</button>; })}</div> : <p className="overview-empty">本次练习没有{type}题</p>}</section>; })}</div></section></div></ModalPortal>;
}
