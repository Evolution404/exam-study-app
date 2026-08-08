"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen, Brain, Check, ChevronLeft, ChevronRight, ClipboardCheck, Cloud, CloudDownload, Copy,
  CircleHelp, FileUp, GitBranch, Grid3X3, Home, Library, Link2, ListFilter,
  LoaderCircle, Menu, Monitor, Moon, NotebookPen, Pencil, Play, RefreshCw, Search,
  Settings2, Sparkles, Star, Sun, Target, X,
} from "lucide-react";
import { clearLegacyGeneratedTags, clearPracticeSession, db, deletePracticeRun, importQuestionBank, recordAttempt, resetLocalDatabase, saveNote, savePracticeSession, setPracticeRunStatus, toggleQuestionFavorite, updateQuestion } from "@/lib/db";
import { getGitHubLogin, syncWithGitHub, verifyGitHubVault } from "@/lib/github-sync";
import { difficultyLabel, needsWrongReview, summarizeAttempts } from "@/lib/practice-metrics";
import { PracticeSetupView } from "@/app/practice-setup";
import { QuestionEditor, type QuestionChanges } from "@/app/question-editor";
import { SearchView, type SearchPracticeOptions } from "@/app/search-view";
import { BankLibraryView, type BankQuickMode } from "@/app/bank-library-view";
import { KnowledgeView } from "@/app/knowledge-view";
import { PracticeHistory, PracticeRunResult } from "@/app/practice-history";
import { MathText } from "@/app/math-text";
import type { GitHubSettings, PracticeAnswerState, PracticeFilter, PracticeSession, Question, QuestionType, SyncEvent } from "@/lib/types";

type View = "home" | "banks" | "relations" | "practiceSetup" | "preferences" | "settings" | "search" | "practice" | "practiceResult";

const SCROLL_RESTORABLE_VIEWS: View[] = ["home", "banks", "relations", "practiceSetup", "preferences", "settings", "search"];

interface PracticePreferences {
  autoNextCorrect: boolean;
  autoNextDelayMs: 0 | 500 | 1000 | 2000;
  showAnswerOnWrong: boolean;
  swipeNavigation: boolean;
  shuffleOptions: boolean;
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
}

const DEFAULT_PREFERENCES: PracticePreferences = {
  autoNextCorrect: true,
  autoNextDelayMs: 500,
  showAnswerOnWrong: true,
  swipeNavigation: true,
  shuffleOptions: true,
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
};

function loadPreferences() {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const saved = { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem("practice-preferences") ?? "{}") } as PracticePreferences;
    return {
      ...saved,
      groupSize: Math.min(500, Math.max(1, Math.floor(Number(saved.groupSize) || 30))),
      dailyGoalCount: Math.min(1000, Math.max(1, Math.floor(Number(saved.dailyGoalCount) || 30))),
      dailyGoalAccuracy: Math.min(100, Math.max(1, Math.floor(Number(saved.dailyGoalAccuracy) || 80))),
      themeMode: ["system", "light", "dark"].includes(saved.themeMode) ? saved.themeMode : "system",
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function displayedAnswer(question: Question, optionOrder: number[]) {
  return question.answer
    .split("")
    .map((letter) => optionOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((index) => index >= 0)
    .map((index) => String.fromCharCode(65 + index))
    .sort()
    .join("");
}

function answerText(question: Question, optionOrder: number[]) {
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
  sequential: "全量顺序练习",
  randomAll: "全量随机练习",
  wrong: "错题模式",
  favorite: "收藏题模式",
  difficult: "难题优先",
  tag: "标签模式",
  advanced: "高级筛选",
};

const TYPE_ORDER: QuestionType[] = ["单选", "多选", "判断"];

function loadSelectedBankIds() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem("study-current-banks");
    if (raw !== null) {
      const saved = JSON.parse(raw) as string[];
      if (Array.isArray(saved)) return saved;
    }
  } catch { /* use legacy selection */ }
  const legacy = localStorage.getItem("study-current-bank");
  return legacy ? [legacy] : [];
}

async function questionsInOriginalOrder(bankId: string) {
  const questions = await db.questions.where("bankId").equals(bankId).toArray();
  const events = await db.events.orderBy("createdAt").reverse().toArray();
  const imported = events.find((event) => {
    if (event.type !== "bank.imported") return false;
    const payload = event.payload as { bank?: { id?: string } };
    return payload.bank?.id === bankId;
  }) as SyncEvent | undefined;
  const payload = imported?.payload as { questions?: Question[] } | undefined;
  const order = new Map((payload?.questions ?? []).map((question, index) => [question.id, index]));
  return questions.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.normalizedStem.localeCompare(b.normalizedStem, "zh-CN"));
}

function quickFilter(bankIds: string[], mode: BankQuickMode = "random30", groupSize = 30): PracticeFilter {
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
  };
}

export function StudyApp() {
  const [view, setView] = useState<View>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [searchQuestionId, setSearchQuestionId] = useState<string>();
  const [searchRevision, setSearchRevision] = useState(0);
  const [groupQuestionIds, setGroupQuestionIds] = useState<string[]>([]);
  const [practiceSession, setPracticeSession] = useState<PracticeSession | null>(null);
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>(loadSelectedBankIds);
  const [preferences, setPreferences] = useState<PracticePreferences>(loadPreferences);
  const [discardedSession, setDiscardedSession] = useState<PracticeSession | null>(null);
  const [practiceHubTab, setPracticeHubTab] = useState<"start" | "history">("start");
  const [resultRunId, setResultRunId] = useState<string>();
  const [quickSyncing, setQuickSyncing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const viewScrollPositions = useRef<Partial<Record<View, number>>>({});

  useEffect(() => {
    const root = document.documentElement;
    const standalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const safeAreaProbe = document.createElement("div");
    safeAreaProbe.style.cssText = "position:fixed;left:-9999px;bottom:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none";
    document.body.appendChild(safeAreaProbe);
    const updateViewportHeight = () => {
      const visualBottom = window.visualViewport ? window.visualViewport.height + window.visualViewport.offsetTop : 0;
      const regularHeight = Math.max(window.innerHeight, root.clientHeight, visualBottom);
      const screenHeight = window.screen.height;
      const standaloneHeight = standalone && screenHeight >= regularHeight && screenHeight - regularHeight < 180 ? screenHeight : regularHeight;
      const reportedSafeBottom = Number.parseFloat(getComputedStyle(safeAreaProbe).paddingBottom) || 0;
      const missingStandaloneArea = standalone ? Math.max(0, standaloneHeight - regularHeight) : 0;
      root.style.setProperty("--app-viewport-height", `${Math.round(Math.max(regularHeight, standaloneHeight))}px`);
      root.style.setProperty("--app-safe-bottom", `${Math.round(Math.max(reportedSafeBottom, Math.min(40, missingStandaloneArea)))}px`);
    };
    const timers = [0, 250, 800].map((delay) => window.setTimeout(updateViewportHeight, delay));
    window.addEventListener("resize", updateViewportHeight);
    window.addEventListener("orientationchange", updateViewportHeight);
    window.addEventListener("pageshow", updateViewportHeight);
    window.visualViewport?.addEventListener("resize", updateViewportHeight);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") updateViewportHeight(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", updateViewportHeight);
      window.removeEventListener("orientationchange", updateViewportHeight);
      window.removeEventListener("pageshow", updateViewportHeight);
      window.visualViewport?.removeEventListener("resize", updateViewportHeight);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      safeAreaProbe.remove();
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const dark = preferences.themeMode === "dark" || (preferences.themeMode === "system" && media.matches);
      const resolved = dark ? "dark" : "light";
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111813" : "#203a2e");
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [preferences.themeMode]);

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

  useEffect(() => { void clearLegacyGeneratedTags(); }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), notice === "已放弃上次练习" ? 6000 : 3000);
    return () => window.clearTimeout(timeout);
  }, [notice]);


  const banks = useLiveQuery(async () => (await db.banks.toArray()).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)), []) ?? [];
  const validSelectedBankIds = selectedBankIds.filter((id) => banks.some((bank) => bank.id === id));
  const activeBankIds = validSelectedBankIds;
  const savedSession = useLiveQuery(() => db.sessions.get("active"), []);
  const activeQuestionId = practiceSession?.questionIds[practiceSession.currentIndex];
  const activeQuestion = useLiveQuery(() => activeQuestionId ? db.questions.get(activeQuestionId) : undefined, [activeQuestionId]);
  const stats = useLiveQuery(async () => {
    const [questions, attemptRows, pending, notes] = await Promise.all([
      db.questions.count(), db.attempts.toArray(),
      db.events.where("synced").equals(0).count(), db.notes.count(),
    ]);
    const last = await db.attempts.orderBy("createdAt").last();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayRows = attemptRows.filter((row) => new Date(row.createdAt).getTime() >= todayStart.getTime());
    return {
      questions,
      attempts: attemptRows.length,
      correct: attemptRows.filter((row) => row.correct).length,
      todayAttempts: todayRows.length,
      todayCorrect: todayRows.filter((row) => row.correct).length,
      pending,
      notes,
      last: last?.createdAt,
    };
  }, []) ?? { questions: 0, attempts: 0, correct: 0, todayAttempts: 0, todayCorrect: 0, pending: 0, notes: 0, last: undefined };

  async function onImport(file?: File) {
    if (!file) return;
    try {
      setNotice("正在整理题库…");
      const raw = JSON.parse(await file.text());
      const bank = await importQuestionBank(file.name, raw);
      setNotice(`已导入「${bank.name}」的 ${bank.questionCount} 道题`);
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
    localStorage.removeItem("study-current-bank");
  }

  function toggleBank(bankId: string) {
    const next = activeBankIds.includes(bankId) ? activeBankIds.filter((id) => id !== bankId) : [...activeBankIds, bankId];
    selectBanks(next);
  }

  async function discardSavedPractice() {
    if (!savedSession) return;
    setDiscardedSession(savedSession);
    await clearPracticeSession();
    await setPracticeRunStatus(savedSession.runId, "abandoned", savedSession.answers);
    setPracticeSession(null);
    setNotice("已放弃上次练习");
  }

  async function undoDiscardPractice() {
    if (!discardedSession) return;
    await savePracticeSession(discardedSession);
    setDiscardedSession(null);
    setNotice("已恢复上次练习");
  }

  function updatePreferences(value: PracticePreferences) {
    setPreferences(value);
    localStorage.setItem("practice-preferences", JSON.stringify(value));
  }

  async function quickSync() {
    if (quickSyncing) return;
    const token = sessionStorage.getItem("github-token") ?? "";
    let settings: GitHubSettings;
    try {
      settings = JSON.parse(localStorage.getItem("github-settings") ?? "") as GitHubSettings;
    } catch {
      settings = { owner: "", repo: "exam-study-vault", branch: "main" };
    }
    if (!settings.repo || !token) {
      setNotice("请先在同步页面填写 GitHub 令牌");
      setView("settings");
      return;
    }
    try {
      setQuickSyncing(true);
      const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
      localStorage.setItem("github-settings", JSON.stringify(resolved));
      const result = await syncWithGitHub(resolved, token);
      setNotice(`同步完成：上传 ${result.pushed} 条，接收 ${result.pulled} 条`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "同步失败，请检查令牌和网络");
    } finally {
      setQuickSyncing(false);
    }
  }

  async function startPractice(filter: PracticeFilter) {
    const practiceBanks = banks.filter((item) => filter.bankIds.includes(item.id));
    if (!practiceBanks.length) {
      setNotice("请先选择一个题库");
      return;
    }
    let questions = (await Promise.all(filter.bankIds.map((bankId) => questionsInOriginalOrder(bankId)))).flat();
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
    const attempts = (await Promise.all(filter.bankIds.map((bankId) => db.attempts.where("bankId").equals(bankId).toArray()))).flat();
    const attemptsByQuestion = new Map<string, typeof attempts>();
    attempts.forEach((attempt) => {
      const rows = attemptsByQuestion.get(attempt.questionId) ?? [];
      rows.push(attempt);
      attemptsByQuestion.set(attempt.questionId, rows);
    });
    const attemptStats = new Map([...attemptsByQuestion].map(([questionId, rows]) => [questionId, summarizeAttempts(rows)]));
    const lastAttemptFrom = filter.lastAttemptFrom ? new Date(`${filter.lastAttemptFrom}T00:00:00`).getTime() : null;
    const lastAttemptTo = filter.lastAttemptTo ? new Date(`${filter.lastAttemptTo}T23:59:59.999`).getTime() : null;
    questions = questions.filter((question) => {
      const rows = attemptsByQuestion.get(question.id) ?? [];
      const metric = attemptStats.get(question.id) ?? summarizeAttempts([]);
      if (filter.status === "unanswered" && metric.total !== 0) return false;
      if (filter.status === "wrong" && !needsWrongReview(rows, preferences.wrongRemovalStreak)) return false;
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
      if (filter.order === "difficulty") return group.sort((a, b) => (attemptStats.get(b.id)?.difficulty ?? 50) - (attemptStats.get(a.id)?.difficulty ?? 50));
      return group;
    });
    if (filter.limit && !limitApplied) questions = questions.slice(0, filter.limit);
    if (!questions.length) {
      setNotice("没有符合当前条件的题目，请调整筛选条件");
      return;
    }
    const now = new Date().toISOString();
    const session: PracticeSession = {
      id: "active",
      runId: crypto.randomUUID(),
      bankId: practiceBanks[0].id,
      bankIds: practiceBanks.map((bank) => bank.id),
      bankName: practiceBanks.length === 1 ? (practiceBanks[0].displayName || practiceBanks[0].name) : `${practiceBanks.length} 个题库组合`,
      mode: filter.mode,
      modeLabel: filter.mode === "random30" ? `随机 ${filter.limit ?? preferences.groupSize} 题` : modeLabels[filter.mode],
      questionIds: questions.map((question) => question.id),
      questionTypes: Object.fromEntries(questions.map((question) => [question.id, question.type])),
      currentIndex: 0,
      answers: {},
      shuffleOptions: preferences.shuffleOptions,
      optionOrders: preferences.shuffleOptions ? Object.fromEntries(questions.map((question) => [
        question.id,
        question.type === "判断"
          ? question.options.map((_, index) => index)
          : shuffle(question.options.map((_, index) => index)),
      ])) : {},
      startedAt: now,
      updatedAt: now,
      revision: 1,
    };
    if (savedSession && savedSession.runId !== session.runId) await setPracticeRunStatus(savedSession.runId, "abandoned", savedSession.answers);
    await savePracticeSession(session);
    setPracticeSession(session);
    setView("practice");
  }

  async function startSearchPractice({ questions, label, shuffleOptions }: SearchPracticeOptions, questionId?: string) {
    const orderedQuestions = TYPE_ORDER.flatMap((type) => questions.filter((question) => question.type === type));
    const practiceBanks = banks.filter((bank) => orderedQuestions.some((question) => question.bankId === bank.id));
    if (!orderedQuestions.length || !practiceBanks.length) return;
    const now = new Date().toISOString();
    const session: PracticeSession = {
      id: "active",
      runId: crypto.randomUUID(),
      bankId: practiceBanks[0].id,
      bankIds: practiceBanks.map((bank) => bank.id),
      bankName: practiceBanks.length === 1 ? (practiceBanks[0].displayName || practiceBanks[0].name) : `${practiceBanks.length} 个题库组合`,
      mode: "advanced",
      modeLabel: label,
      questionIds: orderedQuestions.map((question) => question.id),
      questionTypes: Object.fromEntries(orderedQuestions.map((question) => [question.id, question.type])),
      currentIndex: Math.max(0, orderedQuestions.findIndex((question) => question.id === questionId)),
      answers: {},
      shuffleOptions,
      optionOrders: shuffleOptions ? Object.fromEntries(orderedQuestions.map((question) => [
        question.id,
        question.type === "判断"
          ? question.options.map((_, index) => index)
          : shuffle(question.options.map((_, index) => index)),
      ])) : {},
      startedAt: now,
      updatedAt: now,
      revision: 1,
    };
    if (savedSession && savedSession.runId !== session.runId) await setPracticeRunStatus(savedSession.runId, "abandoned", savedSession.answers);
    await savePracticeSession(session);
    setPracticeSession(session);
    setView("practice");
  }

  function openSearch(questionId?: string) {
    const keyword = query.trim();
    if (keyword) {
      try {
        const previous = JSON.parse(localStorage.getItem("study-search-history") ?? "[]") as unknown;
        const history = Array.isArray(previous) ? previous.filter((item): item is string => typeof item === "string") : [];
        localStorage.setItem("study-search-history", JSON.stringify([keyword, ...history.filter((item) => item !== keyword)].slice(0, 10)));
      } catch { localStorage.setItem("study-search-history", JSON.stringify([keyword])); }
    }
    setSearchQuestionId(questionId);
    setSearchRevision((revision) => revision + 1);
    setView("search");
  }

  function changeSession(mutator: (session: PracticeSession) => PracticeSession) {
    setPracticeSession((current) => {
      if (!current) return current;
      const changed = mutator(current);
      const next = { ...changed, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
      void savePracticeSession(next);
      return next;
    });
  }

  async function resumePractice(runId?: string, preferredIndex?: number) {
    let session = savedSession;
    if (runId) {
      const run = await db.practiceRuns.get(runId);
      if (!run || run.status !== "in_progress" || !run.questionIds.length) {
        setNotice("这次练习已经结束或记录不存在");
        return;
      }
      const firstUnanswered = run.questionIds.findIndex((questionId) => !run.answers[questionId]?.submitted);
      const currentIndex = preferredIndex ?? (firstUnanswered >= 0 ? firstUnanswered : Math.max(0, run.questionIds.length - 1));
      session = {
        id: "active",
        runId: run.id,
        bankId: run.bankId,
        bankIds: run.bankIds,
        bankName: run.bankName,
        mode: run.mode,
        modeLabel: run.modeLabel,
        questionIds: run.questionIds,
        questionTypes: run.questionTypes,
        currentIndex: Math.min(Math.max(0, currentIndex), run.questionIds.length - 1),
        answers: run.answers,
        shuffleOptions: run.shuffleOptions,
        optionOrders: run.optionOrders,
        startedAt: run.startedAt,
        updatedAt: new Date().toISOString(),
        revision: run.revision + 1,
      };
      await savePracticeSession(session);
    }
    if (!session?.questionIds.length) {
      setNotice("没有可以继续的练习记录");
      return;
    }
    if (!session.questionTypes || Object.keys(session.questionTypes).length !== session.questionIds.length) {
      const questions = await db.questions.bulkGet(session.questionIds);
      session = {
        ...session,
        questionTypes: Object.fromEntries(questions.filter(Boolean).map((question) => [question!.id, question!.type])),
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
      };
      await savePracticeSession(session);
    }
    setPracticeSession(session);
    selectBanks(session.bankIds?.length ? session.bankIds : [session.bankId]);
    setView("practice");
  }

  async function abandonHistoryRun(runId: string) {
    const run = await db.practiceRuns.get(runId);
    if (!run || run.status !== "in_progress") return;
    await setPracticeRunStatus(runId, "abandoned", run.answers);
    const active = await db.sessions.get("active");
    if (active?.runId === runId) {
      await clearPracticeSession();
      if (practiceSession?.runId === runId) setPracticeSession(null);
    }
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
    if (!practiceSession) return;
    const nextIndex = practiceSession.currentIndex + offset;
    if (nextIndex >= practiceSession.questionIds.length) {
      setNotice("已到最后一题，可以回顾或查看本次结果");
      return;
    }
    if (nextIndex < 0) return;
    changeSession((session) => ({ ...session, currentIndex: nextIndex }));
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
    if (answered < practiceSession.questionIds.length && !window.confirm(`还有 ${practiceSession.questionIds.length - answered} 道题未作答，仍然结束并查看结果吗？`)) return;
    await setPracticeRunStatus(practiceSession.runId, "completed", practiceSession.answers);
    await clearPracticeSession();
    setResultRunId(practiceSession.runId);
    setView("practiceResult");
  }

  function saveAnswerState(questionId: string, answerState: PracticeAnswerState) {
    changeSession((session) => ({ ...session, answers: { ...session.answers, [questionId]: answerState } }));
  }

  function jumpPractice(index: number) {
    if (!practiceSession || index < 0 || index >= practiceSession.questionIds.length) return;
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
    if (nextView === view) workspaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else {
      if (SCROLL_RESTORABLE_VIEWS.includes(view) && workspaceRef.current) viewScrollPositions.current[view] = workspaceRef.current.scrollTop;
      setView(nextView);
    }
    setSidebarOpen(false);
  }

  return (
    <main className={`app-shell font-${preferences.fontSize}`}>
      <PullToRefresh />
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand"><span className="brand-mark">拾</span><span>拾卷</span></div>
        <nav>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? "nav-active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => openMainView(id)}>
              <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="local-dot" />本地数据已保存
          <small>{stats.pending ? `${stats.pending} 条等待同步` : "没有待同步更改"}</small>
        </div>
      </aside>
      <button className={`sidebar-backdrop ${sidebarOpen ? "visible" : ""}`} aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />

      <section ref={workspaceRef} className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={20} /></button>
          <div className="searchbox"><button className="search-page-trigger" aria-label="进入搜索主页" title="搜索主页与高级筛选" onClick={() => openSearch()}><Search size={17} /></button><input aria-label="快速正则搜索题目、选项、标签或解析" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); else if (event.key === "Enter") { event.currentTarget.blur(); openSearch(); } }} placeholder="快速正则搜索；点击图标进入搜索主页" />{query && <button className="search-clear" aria-label="清除搜索" onClick={() => setQuery("")}><X size={15} /></button>}<SearchResults query={query} bankIds={activeBankIds.length ? activeBankIds : banks.map((bank) => bank.id)} onChoose={(questionId) => openSearch(questionId)} onViewAll={() => openSearch()} /></div>
          <button className={`sync-pill quick-sync ${quickSyncing ? "syncing" : ""}`} disabled={quickSyncing} aria-label="立即与 GitHub 同步" onClick={() => void quickSync()}>{quickSyncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{quickSyncing ? "同步中…" : stats.pending ? `同步 ${stats.pending}` : "立即同步"}</button>
        </header>

        {notice && <div className="toast"><Sparkles size={16} /><span>{notice}</span>{notice === "已放弃上次练习" && discardedSession && <button className="toast-action" onClick={() => void undoDiscardPractice()}>撤销</button>}<button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(event) => onImport(event.target.files?.[0])} />

        <div className={`content ${view === "practice" ? "practice-content" : ""}`}>
          {view === "home" && <Dashboard groupSize={preferences.groupSize} dailyGoalCount={preferences.dailyGoalCount} dailyGoalAccuracy={preferences.dailyGoalAccuracy} stats={stats} banks={banks} savedSession={savedSession} selectedBankIds={activeBankIds} onBankToggle={toggleBank} onImport={() => fileRef.current?.click()} onStart={() => activeBankIds.length && void startPractice(quickFilter(activeBankIds, "random30", preferences.groupSize))} onResume={() => void resumePractice()} onDiscardResume={() => void discardSavedPractice()} onMoreModes={() => setView("practiceSetup")} />}
          {view === "banks" && <BankLibraryView banks={banks} wrongRemovalStreak={preferences.wrongRemovalStreak} onImport={() => fileRef.current?.click()} onOpenRun={(runId) => { setResultRunId(runId); setView("practiceResult"); }} onNotice={setNotice} />}
          {view === "practiceSetup" && <><div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>练习中心</h1><p>开始新的练习，或回看每一次练习的题目和成绩。</p></div></div><div className="practice-hub-tabs"><button className={practiceHubTab === "start" ? "active" : ""} onClick={() => setPracticeHubTab("start")}><Play size={16} />开始练习</button><button className={practiceHubTab === "history" ? "active" : ""} onClick={() => setPracticeHubTab("history")}><ClipboardCheck size={16} />练习记录</button></div>{practiceHubTab === "start" ? <PracticeSetupView hideHeading groupSize={preferences.groupSize} defaultOrder={preferences.defaultOrder} banks={banks} currentBankIds={activeBankIds} onBankChange={selectBanks} onStart={(filter) => void startPractice(filter)} /> : <PracticeHistory onOpen={(runId) => { setResultRunId(runId); setView("practiceResult"); }} onContinue={(runId) => void resumePractice(runId)} onAbandon={(runId) => void abandonHistoryRun(runId)} onDelete={(runId) => void removeHistoryRun(runId)} />}</>}
          {view === "relations" && <KnowledgeView initialQuestionIds={groupQuestionIds} onStartTag={(tag) => { const bankIds = banks.map((bank) => bank.id); const filter = { ...quickFilter(bankIds, "sequential", preferences.groupSize), mode: "tag" as const, tags: [tag] }; void startPractice(filter); }} onStartQuestions={(questions, label) => void startSearchPractice({ questions, label, shuffleOptions: preferences.shuffleOptions })} onNotice={setNotice} />}
          {view === "preferences" && <PreferencesView preferences={preferences} onChange={updatePreferences} />}
          {view === "settings" && <SyncView pending={stats.pending} onNotice={setNotice} />}
          {view === "search" && <SearchView key={`search-${searchRevision}`} query={query} onQueryChange={setQuery} banks={banks} currentBankIds={activeBankIds} focusQuestionId={searchQuestionId} onFocusHandled={() => setSearchQuestionId(undefined)} wrongRemovalStreak={preferences.wrongRemovalStreak} defaultShuffleOptions={preferences.shuffleOptions} hasActiveSession={Boolean(savedSession)} onStart={(options) => startSearchPractice(options)} onGroup={(questionIds) => { setGroupQuestionIds(questionIds); setView("relations"); }} onNotice={setNotice} />}
          {view === "practiceResult" && resultRunId && <PracticeRunResult runId={resultRunId} onBack={() => { setPracticeHubTab("history"); setView("practiceSetup"); }} onContinue={(runId, index) => void resumePractice(runId, index)} onRepeat={(questions, label) => void startSearchPractice({ questions, label, shuffleOptions: preferences.shuffleOptions })} />}
          {view === "practice" && practiceSession && activeQuestion && (
            <Practice key={activeQuestion.id} runId={practiceSession.runId} question={activeQuestion} initialState={practiceSession.answers[activeQuestion.id]} optionOrder={practiceSession.optionOrders?.[activeQuestion.id]} questionIds={practiceSession.questionIds} questionTypes={practiceSession.questionTypes ?? {}} answers={practiceSession.answers} index={practiceSession.currentIndex} total={practiceSession.questionIds.length} modeLabel={practiceSession.modeLabel} preferences={preferences} onStateChange={(state) => saveAnswerState(activeQuestion.id, state)} onJump={jumpPractice} onFavorite={async () => { const updated = await toggleQuestionFavorite(activeQuestion.id); setNotice(updated.favorite ? "已收藏这道题" : "已取消收藏"); }} onEdit={async (changes) => { await updateQuestion(activeQuestion.id, changes); setNotice("题目和标签已保存，并加入同步队列"); }} onExit={() => { setPracticeSession(null); setView("home"); }} onPrevious={() => movePractice(-1)} onNext={() => movePractice(1)} onFinish={() => void finishPractice()} />
          )}
        </div>
      </section>
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

function SearchResults({ query, bankIds, onChoose, onViewAll }: { query: string; bankIds: string[]; onChoose: (questionId: string) => void; onViewAll: () => void }) {
  const normalizedQuery = query.trim();
  const bankKey = bankIds.join("|");
  const results = useLiveQuery(async () => {
    if (!normalizedQuery || !bankIds.length) return { items: [] as Question[], total: 0, error: "" };
    let pattern: RegExp;
    try { pattern = new RegExp(normalizedQuery, "i"); } catch { return { items: [] as Question[], total: 0, error: "正则表达式格式不完整" }; }
    const [questions, notes] = await Promise.all([
      Promise.all(bankIds.map((bankId) => db.questions.where("bankId").equals(bankId).toArray())).then((rows) => rows.flat()),
      db.notes.toArray(),
    ]);
    const notesByQuestion = new Map(notes.map((note) => [note.questionId, note.content]));
    const matched = questions.filter((question) => [
      question.stem,
      ...question.options,
      ...question.tags,
      notesByQuestion.get(question.id) ?? "",
    ].join("\n").match(pattern));
    const grouped = TYPE_ORDER.flatMap((type) => matched.filter((question) => question.type === type));
    return { items: grouped.slice(0, 8), total: grouped.length, error: "" };
  }, [normalizedQuery, bankKey]);

  if (!normalizedQuery) return null;
  if (results === undefined) return <section className="search-results"><div className="search-state"><LoaderCircle className="spin" size={17} />正在搜索…</div></section>;
  return <section className="search-results" aria-label="搜索结果">
    <header><strong>快速正则结果</strong><span>{results.error || (results.total ? `共 ${results.total} 道匹配题目` : "没有匹配题目")}</span></header>
    {results.items.length ? <><div>{results.items.map((question) => <button key={question.id} onClick={() => onChoose(question.id)}><span className="search-type">{question.type}</span><span><strong><MathText text={question.stem} /></strong><small>{question.bankName}{question.tags.length ? ` · ${question.tags.join("、")}` : ""}</small></span><ChevronRight size={16} /></button>)}</div><button className="search-view-all" onClick={onViewAll}>查看全部 {results.total} 道结果<ChevronRight size={16} /></button></> : <div className="search-state">{results.error || "试试“弧垂|导线”这类表达式，搜索范围为首页已选题库。"}</div>}
  </section>;
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
        const registration = await navigator.serviceWorker?.getRegistration();
        await registration?.update();
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.filter((key) => key.startsWith("shijuan-")).map((key) => caches.delete(key)));
        }
      } finally {
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

function Dashboard({ groupSize, dailyGoalCount, dailyGoalAccuracy, stats, banks, savedSession, selectedBankIds, onBankToggle, onImport, onStart, onResume, onDiscardResume, onMoreModes }: {
  groupSize: number;
  dailyGoalCount: number;
  dailyGoalAccuracy: number;
  stats: { questions: number; attempts: number; correct: number; todayAttempts: number; todayCorrect: number; pending: number; notes: number; last?: string };
  banks: Array<{ id: string; name: string; displayName?: string; questionCount: number }>;
  savedSession?: PracticeSession;
  selectedBankIds: string[];
  onBankToggle: (bankId: string) => void;
  onImport: () => void; onStart: () => void; onResume: () => void; onDiscardResume: () => void; onMoreModes: () => void;
}) {
  const accuracy = stats.attempts ? Math.round(stats.correct / stats.attempts * 100) : 0;
  const todayAccuracy = stats.todayAttempts ? Math.round(stats.todayCorrect / stats.todayAttempts * 100) : 0;
  const countProgress = Math.min(100, Math.round(stats.todayAttempts / dailyGoalCount * 100));
  const selectedBanks = banks.filter((bank) => selectedBankIds.includes(bank.id));
  const selectedQuestions = selectedBanks.reduce((total, bank) => total + bank.questionCount, 0);
  const answeredInSession = savedSession ? Object.values(savedSession.answers).filter((answer) => answer.submitted).length : 0;
  return <>
    <div className="home-heading"><p className="eyebrow">今天也向前一点</p><h1>把知识，练成下意识。</h1><p>自由组合题库，记录每一次选择，随时从中断处继续。</p></div>
    {banks.length ? <section className="home-bank-scope"><div className="scope-heading"><div><span className="section-kicker">当前题库范围</span><h2>选择一个或多个题库</h2></div><small>可以暂不选择</small></div><div className="home-bank-grid">{banks.map((bank) => { const selected = selectedBankIds.includes(bank.id); return <button key={bank.id} aria-pressed={selected} className={selected ? "selected" : ""} onClick={() => onBankToggle(bank.id)}><span className="scope-check">{selected && <Check size={14} />}</span><div><strong>{bank.displayName || bank.name}</strong><small>{bank.questionCount.toLocaleString()} 题</small></div></button>; })}</div><div className="scope-footer"><p>{selectedBanks.length ? <>已选择 <strong>{selectedBanks.length}</strong> 个题库，共 <strong>{selectedQuestions.toLocaleString()}</strong> 题</> : "尚未选择练习题库，可以先查看题库或练习配置。"}</p><button className="primary" disabled={!selectedBankIds.length} onClick={onStart}><Brain size={18} />开始随机 {groupSize} 题</button></div></section> : <EmptyImport onImport={onImport} />}
    {savedSession && <section className="resume-card"><span><Play size={20} /></span><div><small>上次练习 · {savedSession.modeLabel}</small><strong>{savedSession.bankName}</strong><p>停在第 {savedSession.currentIndex + 1} / {savedSession.questionIds.length} 题，已作答 {answeredInSession} 题</p></div><button className="resume-discard" aria-label="放弃上次练习" title="放弃上次练习" onClick={onDiscardResume}><X size={16} /></button><button className="resume-continue" onClick={onResume}>继续练习<ChevronRight size={17} /></button></section>}
    <section className="home-feature-grid">
      <article className="daily-practice"><div><span className="section-kicker">今日推荐</span><h2>来一组 {groupSize} 题</h2><p>{selectedBankIds.length ? "从已选题库随机抽题，再按单选、多选、判断分组。" : "请先选择题库，或进入更多练习模式选择题库。"}</p><div><button disabled={!selectedBankIds.length} onClick={onStart}>开始这一组<ChevronRight size={17} /></button><button className="feature-secondary" onClick={onMoreModes}><ListFilter size={16} />更多练习模式</button></div></div><span className="daily-number"><strong>{groupSize}</strong><small>题</small></span></article>
      <article className="memory-card daily-goal-card"><span>今日目标</span><blockquote>{stats.todayAttempts} / {dailyGoalCount} 题</blockquote><div className="daily-goal-progress"><i style={{ width: `${countProgress}%` }} /></div><small>今日正确率 {todayAccuracy}% · 目标 {dailyGoalAccuracy}%</small>
        <p className={stats.todayAttempts >= dailyGoalCount && todayAccuracy >= dailyGoalAccuracy ? "achieved" : ""}>{stats.todayAttempts >= dailyGoalCount && todayAccuracy >= dailyGoalAccuracy ? "今日目标已达成" : stats.todayAttempts < dailyGoalCount ? `还差 ${dailyGoalCount - stats.todayAttempts} 题` : `正确率还差 ${Math.max(0, dailyGoalAccuracy - todayAccuracy)}%`}</p>
      </article>
    </section>
    <section className="stat-grid">
      <Stat icon={<BookOpen />} label="题目总数" value={stats.questions.toLocaleString()} foot={`${banks.length} 个题库`} />
      <Stat icon={<Target />} label="累计作答" value={stats.attempts.toLocaleString()} foot={`最近：${formatDate(stats.last)}`} />
      <Stat icon={<Check />} label="正确率" value={`${accuracy}%`} foot={stats.attempts ? `${stats.correct} 次答对` : "等待第一次作答"} />
      <Stat icon={<NotebookPen />} label="个人解析" value={stats.notes.toLocaleString()} foot="沉淀自己的记忆钩子" />
    </section>
    <section className="section-block"><div className="section-title"><div><span className="section-kicker">题库管理</span><h2>继续扩充你的练习范围</h2></div><button className="text-button" onClick={onImport}><FileUp size={16} />导入题库</button></div></section>
  </>;
}

function Stat({ icon, label, value, foot }: { icon: React.ReactNode; label: string; value: string; foot: string }) {
  return <article className="stat-card"><span className="stat-icon">{icon}</span><span>{label}</span><strong>{value}</strong><small>{foot}</small></article>;
}

function EmptyImport({ onImport }: { onImport: () => void }) {
  return <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入 JSON 题库</strong><small>数据直接写入本机，不经过第三方服务器</small></div><ChevronRight size={18} /></button>;
}

function PreferencesView({ preferences, onChange }: { preferences: PracticePreferences; onChange: (value: PracticePreferences) => void }) {
  const interactionItems: Array<{ key: "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions"; title: string; detail: string }> = [
    { key: "autoNextCorrect", title: "答对后自动下一题", detail: "单选题和判断题选对后自动前进；多选题确认答案正确后自动前进。" },
    { key: "showAnswerOnWrong", title: "答错显示正确答案", detail: "立即标出错误选项和正确选项，方便当场纠正记忆。" },
    { key: "swipeNavigation", title: "左右滑动切换题目", detail: "向左滑进入下一题，向右滑返回上一题。" },
    { key: "shuffleOptions", title: "随机排列选项", detail: "仅随机单选题和多选题；判断题始终保持“正确、错误”。" },
  ];
  const feedbackItems: Array<{ key: "feedbackSound" | "feedbackHaptics"; title: string; detail: string }> = [
    { key: "feedbackSound", title: "答题提示音", detail: "用轻提示音区分答对和答错；系统静音时可能不播放。" },
    { key: "feedbackHaptics", title: "答题振动反馈", detail: "支持振动的手机会在判题后给出轻触反馈。" },
  ];
  const toggleRow = (item: { key: keyof Pick<PracticePreferences, "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions" | "feedbackSound" | "feedbackHaptics" | "requireAllAnswered">; title: string; detail: string }) => <label aria-label={item.title} className="preference-row" key={item.key}><div><strong>{item.title}</strong><p>{item.detail}</p></div><input aria-label={item.title} type="checkbox" checked={Boolean(preferences[item.key])} onChange={(event) => onChange({ ...preferences, [item.key]: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>;
  return <><div className="page-heading compact"><div><p className="eyebrow">练习偏好</p><h1>答题配置</h1><p>设置只保存在当前浏览器，不会修改题库内容。</p></div></div>
    <section className="preference-card"><div className="settings-title"><span><Moon /></span><div><h2>外观主题</h2><p>可以跟随手机或电脑的系统外观，也可以固定使用浅色或深色。</p></div></div>
      <ThemeSetting value={preferences.themeMode} onChange={(themeMode) => onChange({ ...preferences, themeMode })} />
    </section>
    <section className="preference-card"><div className="settings-title"><span><Settings2 /></span><div><h2>答题交互</h2><p>根据自己的背题节奏随时调整。</p></div></div>
      <div className="preference-list">
        <GroupSizeSetting value={preferences.groupSize} onChange={(groupSize) => onChange({ ...preferences, groupSize })} />
        {interactionItems.map(toggleRow)}
        <PreferenceSelect title="自动下一题等待时间" detail="答对后留出查看反馈的时间；选择立即可最快连续刷题。" value={String(preferences.autoNextDelayMs)} onChange={(value) => onChange({ ...preferences, autoNextDelayMs: Number(value) as PracticePreferences["autoNextDelayMs"] })} options={[['0','立即'],['500','0.5 秒'],['1000','1 秒'],['2000','2 秒']]} />
      </div>
    </section>
    <section className="preference-card"><div className="settings-title"><span><ListFilter /></span><div><h2>出题与复习</h2><p>控制抽题分布、默认顺序和错题复习节奏。</p></div></div><div className="preference-list">
      <PreferenceSelect title="随机组题型分布" detail="均衡抽取会尽量平均包含单选、多选、判断；不足的题型由其他题型补足。" value={preferences.randomTypeBalance} onChange={(value) => onChange({ ...preferences, randomTypeBalance: value as PracticePreferences["randomTypeBalance"] })} options={[['balanced','尽量均衡'],['natural','按题库自然比例']]} />
      <PreferenceSelect title="默认题目顺序" detail="进入练习中心和高级筛选时默认使用的题目顺序。" value={preferences.defaultOrder} onChange={(value) => onChange({ ...preferences, defaultOrder: value as PracticePreferences["defaultOrder"] })} options={[['sequential','题库顺序'],['random','随机打乱'],['difficulty','难题优先']]} />
      <PreferenceSelect title="答错后的复习方式" detail="立即重答会在当前题显示按钮；本组结束可在成绩页集中重练；留到下次进入错题练习。" value={preferences.wrongReappearance} onChange={(value) => onChange({ ...preferences, wrongReappearance: value as PracticePreferences["wrongReappearance"] })} options={[['immediate','立即重答'],['end','本组结束集中重练'],['next','留到下次错题练习']]} />
      <PreferenceSelect title="连续答对后移出错题" detail="题目答错或选择“不会”后进入错题；达到连续正确次数后自动移除。" value={String(preferences.wrongRemovalStreak)} onChange={(value) => onChange({ ...preferences, wrongRemovalStreak: Number(value) })} options={[['1','1 次'],['2','2 次'],['3','3 次'],['5','5 次']]} />
      {toggleRow({ key: "requireAllAnswered", title: "必须答完才能结束", detail: "打开后点击查看结果会自动定位到第一道未答题，不允许带着空题结束。" })}
    </div></section>
    <section className="preference-card"><div className="settings-title"><span><Target /></span><div><h2>阅读、反馈与目标</h2><p>调整显示密度，设置每天的练习目标。</p></div></div><div className="preference-list">
      <PreferenceSelect title="答题字号" detail="只调整题干与选项的阅读字号，不影响题目内容。" value={preferences.fontSize} onChange={(value) => onChange({ ...preferences, fontSize: value as PracticePreferences["fontSize"] })} options={[['small','较小'],['standard','标准'],['large','较大'],['xlarge','特大']]} />
      <GoalSetting count={preferences.dailyGoalCount} accuracy={preferences.dailyGoalAccuracy} onChange={(dailyGoalCount, dailyGoalAccuracy) => onChange({ ...preferences, dailyGoalCount, dailyGoalAccuracy })} />
      {feedbackItems.map(toggleRow)}
    </div></section>
  </>;
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
  return <label className="preference-row select-preference"><div><strong>{title}</strong><p>{detail}</p></div><select aria-label={title} value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, label]) => <option value={optionValue} key={optionValue}>{label}</option>)}</select></label>;
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

function Practice({ runId, question, initialState, optionOrder, questionIds, questionTypes, answers, index, total, modeLabel, preferences, onStateChange, onJump, onFavorite, onEdit, onPrevious, onNext, onFinish, onExit }: { runId: string; question: Question; initialState?: PracticeAnswerState; optionOrder?: number[]; questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; index: number; total: number; modeLabel: string; preferences: PracticePreferences; onStateChange: (state: PracticeAnswerState) => void; onJump: (index: number) => void; onFavorite: () => Promise<void>; onEdit: (changes: QuestionChanges) => Promise<void>; onPrevious: () => void; onNext: () => void; onFinish: () => void; onExit: () => void }) {
  const [selected, setSelected] = useState<string[]>(initialState?.selected ?? []);
  const [submitted, setSubmitted] = useState(initialState?.submitted ?? false);
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [startedAt] = useState(() => Date.now());
  const note = useLiveQuery(() => db.notes.get(question.id), [question.id]);
  const attemptSummary = useLiveQuery(async () => summarizeAttempts(await db.attempts.where("questionId").equals(question.id).toArray()), [question.id]) ?? summarizeAttempts([]);
  const [draft, setDraft] = useState<string | null>(null);
  const autoNextTimer = useRef<number | undefined>(undefined);
  const copyStatusTimer = useRef<number | undefined>(undefined);
  const answering = useRef(false);
  const questionCardRef = useRef<HTMLElement>(null);
  const swipeGesture = useRef<{ startX: number; startY: number; lastX: number; lastY: number; startScrollTop: number; axis: "pending" | "horizontal" | "vertical" } | null>(null);
  const effectiveDraft = draft ?? note?.content ?? "";
  const displayOrder = optionOrder?.length === question.options.length ? optionOrder : question.options.map((_, optionIndex) => optionIndex);
  const displayAnswer = displayedAnswer(question, displayOrder);
  const selectedAnswer = [...selected].sort().join("");
  const correct = submitted && selectedAnswer === [...question.answer].sort().join("");
  const gaveUp = submitted && selected.length === 0;
  const revealAnswer = submitted && (correct || preferences.showAnswerOnWrong);
  const isLast = index === total - 1;

  useEffect(() => () => {
    window.clearTimeout(autoNextTimer.current);
    window.clearTimeout(copyStatusTimer.current);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditingText = target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (editing || overviewOpen || isEditingText) return;
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onPrevious();
      } else if (event.key === "ArrowRight" && !isLast) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onNext();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, overviewOpen, index, isLast, onNext, onPrevious]);

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
    await submit(value);
  }

  async function submit(valueList = selected) {
    if (!valueList.length || submitted || answering.current) return;
    answering.current = true;
    const value = [...valueList].sort().join("");
    const isCorrect = value === [...question.answer].sort().join("");
    try {
      await recordAttempt({ runId, questionId: question.id, bankId: question.bankId, selected: value, correct: isCorrect, elapsedMs: Date.now() - startedAt });
    } catch {
      answering.current = false;
      return;
    }
    setSubmitted(true);
    onStateChange({ selected: valueList, submitted: true, correct: isCorrect });
    playAnswerFeedback(isCorrect, preferences);
    if (isCorrect && preferences.autoNextCorrect && !isLast) {
      setAutoAdvancing(true);
      autoNextTimer.current = window.setTimeout(onNext, preferences.autoNextDelayMs);
    }
  }

  async function giveUp() {
    if (submitted || answering.current) return;
    answering.current = true;
    try {
      await recordAttempt({ runId, questionId: question.id, bankId: question.bankId, selected: "", correct: false, elapsedMs: Date.now() - startedAt });
    } catch {
      answering.current = false;
      return;
    }
    setSelected([]);
    setSubmitted(true);
    onStateChange({ selected: [], submitted: true, correct: false });
    playAnswerFeedback(false, preferences);
  }

  function retryQuestion() {
    window.clearTimeout(autoNextTimer.current);
    answering.current = false;
    setSelected([]);
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
    <div className="question-body"><div className="question-meta"><span>{question.bankName}</span><em className="question-type-chip">{question.type}</em><em className="difficulty-chip">难度 {attemptSummary.difficulty} · {difficultyLabel(attemptSummary.difficulty)}</em>{question.tags.map((tag) => <em key={tag}>{tag}</em>)}<button className={`copy-question ${copyStatus}`} aria-label={submitted ? "复制题目、选项和答案" : "复制题目和选项"} onClick={() => void copyQuestion()}>{copyStatus === "copied" ? <ClipboardCheck size={14} /> : <Copy size={14} />}{copyStatus === "copied" ? "已复制" : copyStatus === "error" ? "复制失败" : submitted ? "复制题目和答案" : "复制题目"}</button><button className={`favorite-question ${question.favorite ? "active" : ""}`} aria-label={question.favorite ? "取消收藏" : "收藏题目"} aria-pressed={Boolean(question.favorite)} onClick={() => void onFavorite()}><Star size={14} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button className="edit-question-link" onClick={() => setEditing(true)}><Pencil size={13} />编辑题目</button></div><h1><MathText text={question.stem} /></h1><div className="options">{displayOrder.map((originalIndex, displayIndex) => { const option = question.options[originalIndex]; const originalLetter = String.fromCharCode(65 + originalIndex); const displayLetter = String.fromCharCode(65 + displayIndex); const isAnswer = revealAnswer && question.answer.includes(originalLetter); const isWrong = submitted && selected.includes(originalLetter) && !question.answer.includes(originalLetter); return <button key={originalLetter} className={`${selected.includes(originalLetter) ? "selected" : ""} ${isAnswer ? "right" : ""} ${isWrong ? "wrong" : ""}`} onClick={() => void choose(originalLetter)}><span>{displayLetter}</span><p><MathText text={option} /></p>{isAnswer && <Check size={18} />}{isWrong && <X size={18} />}</button>; })}</div>
      {submitted && <><div className={`result-box ${correct ? "success" : "error"}`}><strong>{correct ? (autoAdvancing ? "回答正确，即将进入下一题" : "回答正确") : gaveUp ? "已标记为不会，并计入错题" : "这次没有答对"}</strong>{(correct || preferences.showAnswerOnWrong) ? <p>正确答案：{displayAnswer}｜<MathText text={answerText(question, displayOrder)} /></p> : <p>正确答案已按配置隐藏。</p>}</div><div className="attempt-summary"><span><strong>{attemptSummary.total}</strong>总作答</span><span className="correct"><strong>{attemptSummary.correct}</strong>正确</span><span className="wrong"><strong>{attemptSummary.wrong}</strong>错误</span><span className={`difficulty difficulty-${difficultyLabel(attemptSummary.difficulty)}`}><strong>{attemptSummary.difficulty}</strong>难度 · {difficultyLabel(attemptSummary.difficulty)}</span></div></>}
      {preferences.swipeNavigation && <div className="swipe-hint"><ChevronLeft size={15} />右滑上一题 · 左滑下一题<ChevronRight size={15} /></div>}
    </div><div className={`practice-actions ${submitted ? "submitted" : ""}`}><button className="secondary-action practice-previous" onClick={onPrevious} disabled={index === 0}><ChevronLeft size={18} />上一题</button><div>{!submitted && <button className="dont-know-action" onClick={() => void giveUp()}><CircleHelp size={17} />不会</button>}{!submitted && question.type !== "多选" && <span className="answer-action-hint">选择答案后立即判定</span>}{question.type === "多选" && !submitted && <button className="primary practice-submit" disabled={!selected.length} onClick={() => void submit()}>确认答案</button>}{submitted && !correct && preferences.wrongReappearance === "immediate" && <button className="secondary-action retry-question" onClick={retryQuestion}><RefreshCw size={16} />立即重答</button>}{autoAdvancing ? <span className="answer-action-hint practice-auto-status">正在自动前进…</span> : <button className={`${submitted ? "primary" : "secondary-action"} practice-next`} onClick={isLast ? onFinish : onNext}>{isLast ? "查看本次结果" : submitted ? "下一题" : "跳过 / 下一题"}<ChevronRight size={18} /></button>}</div></div></section>
    <aside className="note-panel"><div><NotebookPen size={18} /><strong>我的解析</strong></div><textarea value={effectiveDraft} onChange={(event) => setDraft(event.target.value)} placeholder="写下错因、口诀或区分条件…" /><button onClick={async () => { await saveNote(question.id, effectiveDraft); setDraft(effectiveDraft); }}>保存解析</button><button className="edit-question-button" onClick={() => setEditing(true)}><Pencil size={15} />编辑题目与标签</button><small>关闭练习后可从首页继续，选项和当前进度都会保留。</small></aside></div>{overviewOpen && <QuestionOverview questionIds={questionIds} questionTypes={questionTypes} answers={answers} currentIndex={index} onClose={() => setOverviewOpen(false)} onJump={(target) => { window.clearTimeout(autoNextTimer.current); onJump(target); setOverviewOpen(false); }} />}{editing && <QuestionEditor question={question} onCancel={() => setEditing(false)} onSave={async (changes) => { await onEdit(changes); setEditing(false); }} />}</>;
}

function QuestionOverview({ questionIds, questionTypes, answers, currentIndex, onClose, onJump }: { questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; currentIndex: number; onClose: () => void; onJump: (index: number) => void }) {
  const answered = Object.values(answers).filter((answer) => answer.submitted).length;
  const correct = Object.values(answers).filter((answer) => answer.submitted && answer.correct).length;
  const wrong = answered - correct;
  const accuracy = answered ? Math.round(correct / answered * 100) : 0;
  return <div className="overview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="question-overview" role="dialog" aria-modal="true" aria-label="题目总览"><header><div><span className="section-kicker">练习导航</span><h2>题目总览</h2><p>已作答 {answered} / {questionIds.length}，点击题号快速切换。</p></div><button className="icon-button" aria-label="关闭题目总览" onClick={onClose}><X size={19} /></button></header><div className="overview-score"><span><strong>{correct}</strong>正确</span><span><strong>{wrong}</strong>错误</span><span><strong>{accuracy}%</strong>正确率</span></div><div className="overview-legend"><span><i className="correct" />正确</span><span><i className="wrong" />错误</span><span><i className="pending" />已选择</span><span><i />未作答</span></div><div className="overview-groups">{TYPE_ORDER.map((type) => { const group = questionIds.map((id, questionIndex) => ({ id, questionIndex })).filter(({ id }) => questionTypes[id] === type); return <section className="overview-group" key={type}><div><h3>{type}</h3><span>{group.length} 题</span></div>{group.length ? <div className="overview-number-grid">{group.map(({ id, questionIndex }) => { const answer = answers[id]; const state = answer?.submitted ? answer.correct ? "correct" : "wrong" : answer?.selected.length ? "pending" : "blank"; return <button key={`${id}-${questionIndex}`} className={`${state} ${questionIndex === currentIndex ? "current" : ""}`} aria-label={`第 ${questionIndex + 1} 题，${type}`} aria-current={questionIndex === currentIndex ? "true" : undefined} onClick={() => onJump(questionIndex)}>{questionIndex + 1}</button>; })}</div> : <p className="overview-empty">本次练习没有{type}题</p>}</section>; })}</div></section></div>;
}

function SyncView({ pending, onNotice }: { pending: number; onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<GitHubSettings>(() => {
    const defaults = { owner: "", repo: "exam-study-vault", branch: "main" };
    if (typeof window === "undefined") return defaults;
    try { return JSON.parse(localStorage.getItem("github-settings") ?? "") as GitHubSettings; } catch { return defaults; }
  });
  const [token, setToken] = useState(() => typeof window === "undefined" ? "" : sessionStorage.getItem("github-token") ?? "");
  const [syncing, setSyncing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const ready = settings.repo && token;
  async function sync() {
    if (!ready) return;
    try {
      setSyncing(true);
      const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
      setSettings(resolved);
      localStorage.setItem("github-settings", JSON.stringify(resolved));
      sessionStorage.setItem("github-token", token);
      const result = await syncWithGitHub(resolved, token);
      onNotice(`同步完成：上传 ${result.pushed} 条，接收 ${result.pulled} 条`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步失败");
    } finally { setSyncing(false); }
  }
  async function restoreFromRemote() {
    if (!ready || restoring) return;
    if (!window.confirm("这会永久丢弃当前浏览器中的题库、作答记录、解析、标签和未同步更改，然后仅用 GitHub 远程数据重建。确定继续吗？")) return;
    try {
      setRestoring(true);
      const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
      const remoteFiles = await verifyGitHubVault(resolved, token);
      if (!remoteFiles) throw new Error("远程仓库中没有可恢复的同步记录，已保留本地数据。");
      setSettings(resolved);
      localStorage.setItem("github-settings", JSON.stringify(resolved));
      sessionStorage.setItem("github-token", token);
      await resetLocalDatabase();
      const result = await syncWithGitHub(resolved, token);
      localStorage.removeItem("study-current-bank");
      localStorage.removeItem("study-current-banks");
      window.alert(`恢复完成：从远程应用 ${result.pulled} 条记录。页面将重新载入。`);
      window.location.reload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "远程恢复失败");
      setRestoring(false);
    }
  }
  return <><div className="page-heading compact"><div><p className="eyebrow">无需自建服务器</p><h1>GitHub 同步</h1><p>使用一个私有仓库保存增量记录，每台设备只写自己的目录。</p></div></div>
    <div className="settings-grid"><section className="settings-card"><div className="settings-title"><span><GitBranch /></span><div><h2>连接私有仓库</h2><p>令牌只保留在当前浏览器会话中。</p></div></div><label>仓库所有者<input value={settings.owner} onChange={(event) => setSettings({ ...settings, owner: event.target.value.trim() })} placeholder="github-username" /></label><label>仓库名称<input value={settings.repo} onChange={(event) => setSettings({ ...settings, repo: event.target.value.trim() })} placeholder="exam-study-vault" /></label><div className="field-row"><label>分支<input value={settings.branch} onChange={(event) => setSettings({ ...settings, branch: event.target.value.trim() || "main" })} /></label><label>细粒度令牌<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_…" /></label></div><button className="primary full" disabled={!ready || syncing} onClick={sync}>{syncing ? <LoaderCircle className="spin" size={18} /> : <Cloud size={18} />}{syncing ? "正在合并…" : `立即同步${pending ? `（${pending}）` : ""}`}</button></section>
      <section className="guide-card"><span className="section-kicker">首次设置</span><h2>三步建立同步资料库</h2><ol><li><span>1</span><div><strong>新建私有仓库</strong><p>建议命名 exam-study-vault，并创建 README。</p></div></li><li><span>2</span><div><strong>创建细粒度令牌</strong><p>只授权该仓库的 Contents 读写权限。</p></div></li><li><span>3</span><div><strong>在每台设备连接</strong><p>首次拉取后，题库和学习记录会自动合并。</p></div></li></ol></section></div>
    <section className="restore-card"><div className="restore-icon"><CloudDownload /></div><div><span className="section-kicker">远程数据优先</span><h2>丢弃本地，重新从 GitHub 恢复</h2><p>适合当前设备数据异常或希望完全回到远程状态时使用。系统会先确认仓库中存在同步记录；继续后，本地未同步内容将无法找回。</p></div><button className="danger-button" disabled={!ready || syncing || restoring} onClick={restoreFromRemote}>{restoring ? <LoaderCircle className="spin" size={18} /> : <CloudDownload size={18} />}{restoring ? "正在重建本地数据…" : "丢弃本地并恢复远程"}</button></section>
  </>;
}
