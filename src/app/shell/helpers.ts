"use client";
import { lazy } from "react";
import { dbV7, deletePracticeRunV7, recordPracticeAnswerV7, saveNoteV7, savePracticeProgressV7, setPracticeRunStatusV7, toggleQuestionFavoriteV7 } from "@/lib/db/db-v7";
import { resumeIndexAfterLastAnswer } from "@/lib/practice/practice-resume";
import { summarizeAttemptStats } from "@/lib/practice/practice-metrics";
import { type QuestionViewModel } from "@/app/bank/question-editor";
import type { BankQuickMode } from "@/app/bank/bank-library-view";
import { DEFAULT_KEYBOARD_SHORTCUTS, normalizeKeyboardShortcuts, type KeyboardShortcuts } from "@/lib/practice/keyboard-shortcuts";
import { QUESTION_TYPE_ORDER, type ActivePractice } from "@/types/types";
import type { AttemptOutcome, AttemptStatsV7, PracticeResponse, PracticeRunV7, QuestionTypeV7 } from "@/lib/db/v7-types";
import type { V7PracticeFilter } from "@/app/practice/practice-setup";
import type { ProgressScope } from "@/lib/practice/progress-scope";
import { normalizeProgressScope } from "@/lib/practice/progress-scope";
import { isNativeApp } from "@/platform/environment";
import { platformHaptics } from "@/platform/haptics";

export type Question = QuestionViewModel;
export type QuestionType = QuestionTypeV7;
export type PracticeFilter = V7PracticeFilter;
export type PracticeRun = PracticeRunV7;
export type PracticeAnswerState = PracticeRunV7["answers"][string];
export type AttemptStats = AttemptStatsV7 & { bankId: string };

export function toLegacyAttemptStats(stats?: AttemptStatsV7, bankId = ""): AttemptStats | undefined {
  return stats ? { ...stats, bankId } : undefined;
}

export function summarizeV7AttemptStats(stats?: AttemptStatsV7) {
  return summarizeAttemptStats(toLegacyAttemptStats(stats));
}

export async function saveNote(questionId: string, content: string) { return saveNoteV7(questionId, content); }
export async function toggleQuestionFavorite(questionId: string) { return toggleQuestionFavoriteV7(questionId); }
export async function recordPracticeAnswer(input: { runId: string; questionId: string; bankId?: string; selected: string | string[]; correct: boolean; elapsedMs?: number; reviewRoundId?: string; response?: PracticeResponse; outcome?: AttemptOutcome }) { return recordPracticeAnswerV7({ ...input, sourceBankId: input.bankId }); }
export async function savePracticeProgress(session: ActivePractice) { const current = await dbV7.practiceRuns.get(session.runId); if (!current) return; return savePracticeProgressV7({ ...current, answers: session.answers, lastAnsweredIndex: session.lastAnsweredIndex, updatedAt: session.updatedAt, revision: session.revision }); }
export async function setPracticeRunStatus(runId: string, status: PracticeRunV7["status"], answers?: PracticeRun["answers"]) { return setPracticeRunStatusV7(runId, status, answers); }
export async function deletePracticeRun(runId: string) { return deletePracticeRunV7(runId); }

export const PracticeSetupView = lazy(() => import("@/app/practice/practice-setup").then((module) => ({ default: module.PracticeSetupView })));
export const SearchView = lazy(() => import("@/app/search/search-view").then((module) => ({ default: module.SearchView })));
export const BankLibraryView = lazy(() => import("@/app/bank/bank-library-view").then((module) => ({ default: module.BankLibraryView })));
export const KnowledgeView = lazy(() => import("@/app/bank/knowledge-view").then((module) => ({ default: module.KnowledgeView })));
export const SyncView = lazy(() => import("@/app/sync/sync-view").then((module) => ({ default: module.SyncView })));
export const LatestPracticeBanner = lazy(() => import("@/app/practice/practice-history").then((module) => ({ default: module.LatestPracticeBanner })));
export const PracticeHistory = lazy(() => import("@/app/practice/practice-history").then((module) => ({ default: module.PracticeHistory })));
export const PracticeRunResult = lazy(() => import("@/app/practice/practice-history").then((module) => ({ default: module.PracticeRunResult })));

export type View = "home" | "banks" | "relations" | "practiceSetup" | "preferences" | "settings" | "search" | "practice" | "practiceResult";

export const SCROLL_RESTORABLE_VIEWS: View[] = ["home", "banks", "relations", "practiceSetup", "preferences", "settings", "search"];

export interface PracticePreferences {
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

export const DEFAULT_PREFERENCES: PracticePreferences = {
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

export function loadPreferences(): PracticePreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const saved = { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem("study-v7-preferences") ?? localStorage.getItem("study-v6-preferences") ?? "{}") } as PracticePreferences;
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

// 字母映射的唯一实现收敛在 lib/question/question-copy（复制题目功能共用），
// 这里按原签名委托 re-export，消费方 import 不变。
export { displayedAnswer, answerText } from "@/lib/question/question-copy";

export function formatDate(value?: string) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

export function shuffle<T>(values: T[]) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function balancedRandomSample(questions: Question[], limit: number) {
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

export function playAnswerFeedback(correct: boolean, preferences: PracticePreferences) {
  if (preferences.feedbackHaptics) void platformHaptics.answer(correct);
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

export const modeLabels = {
  random30: "随机一组",
  randomCustom: "随机指定题数",
  sequential: "全量顺序练习",
  randomAll: "全量随机练习",
  wrong: "错题模式",
  favorite: "收藏题模式",
  difficult: "优先复习",
  tag: "标签模式",
  advanced: "高级筛选",
};

export const TYPE_ORDER: QuestionType[] = [...QUESTION_TYPE_ORDER];

export function randomOptionOrder(question: Question, avoid?: number[]) {
  const original = question.options.map((_, index) => index);
  if (question.type === "判断" || question.type === "计算" || original.length < 2) return original;
  const randomized = shuffle(original);
  if (avoid?.length === randomized.length && randomized.every((value, index) => value === avoid[index])) {
    return [...randomized.slice(1), randomized[0]];
  }
  return randomized;
}

export function loadSelectedBankIds() {
  if (typeof window === "undefined") return [];
  try {
    const saved = JSON.parse(localStorage.getItem("study-current-banks") ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

export function quickFilter(bankIds: string[], mode: BankQuickMode = "random30", groupSize = 30, progressScope: ProgressScope = { type: "rolling", days: 90 }): PracticeFilter {
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

export function activePracticeFromRun(run: PracticeRun, preferredIndex?: number): ActivePractice {
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

export const formatBuildTimestamp = () =>
  new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(__APP_COMMIT_TIME__));
export const formatBuildTimestampShort = () =>
  new Intl.DateTimeFormat("zh-CN", { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(__APP_COMMIT_TIME__));

export function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number) {
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

export async function updateServiceWorkerWithinTimeout() {
  if (isNativeApp()) return;
  if (!("serviceWorker" in navigator)) return;
  const registration = await settleWithTimeout(navigator.serviceWorker.getRegistration(), 300);
  if (!registration) return;
  await settleWithTimeout(registration.update(), 700);
}
