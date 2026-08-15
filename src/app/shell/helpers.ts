"use client";
import { lazy } from "react";
import { dbV6, deletePracticeRunV6, recordPracticeAnswerV6, saveNoteV6, savePracticeProgressV6, setPracticeRunStatusV6, toggleQuestionFavoriteV6 } from "@/lib/db/db-v6";
import { resumeIndexAfterLastAnswer } from "@/lib/practice/practice-resume";
import { summarizeAttemptStats } from "@/lib/practice/practice-metrics";
import { type QuestionViewModel } from "@/app/bank/question-editor";
import type { BankQuickMode } from "@/app/bank/bank-library-view";
import { DEFAULT_KEYBOARD_SHORTCUTS, normalizeKeyboardShortcuts, type KeyboardShortcuts } from "@/lib/practice/keyboard-shortcuts";
import type { ActivePractice } from "@/types/types";
import type { AttemptStatsV6, PracticeRunV6, QuestionTypeV6 } from "@/lib/db/v6-types";
import type { V6PracticeFilter } from "@/app/practice/practice-setup";
import type { ProgressScope } from "@/lib/practice/progress-scope";
import { normalizeProgressScope } from "@/lib/practice/progress-scope";

export type Question = QuestionViewModel;
export type QuestionType = QuestionTypeV6;
export type PracticeFilter = V6PracticeFilter;
export type PracticeRun = PracticeRunV6;
export type PracticeAnswerState = PracticeRunV6["answers"][string];
export type AttemptStats = AttemptStatsV6 & { bankId: string };

export function toLegacyAttemptStats(stats?: AttemptStatsV6, bankId = ""): AttemptStats | undefined {
  return stats ? { ...stats, bankId } : undefined;
}

export function summarizeV6AttemptStats(stats?: AttemptStatsV6) {
  return summarizeAttemptStats(toLegacyAttemptStats(stats));
}

export async function saveNote(questionId: string, content: string) { return saveNoteV6(questionId, content); }
export async function toggleQuestionFavorite(questionId: string) { return toggleQuestionFavoriteV6(questionId); }
export async function recordPracticeAnswer(input: { runId: string; questionId: string; bankId?: string; selected: string | string[]; correct: boolean; elapsedMs?: number; reviewRoundId?: string }) { return recordPracticeAnswerV6({ ...input, sourceBankId: input.bankId }); }
export async function savePracticeProgress(session: ActivePractice) { const current = await dbV6.practiceRuns.get(session.runId); if (!current) return; return savePracticeProgressV6({ ...current, answers: session.answers, lastAnsweredIndex: session.lastAnsweredIndex, updatedAt: session.updatedAt, revision: session.revision }); }
export async function setPracticeRunStatus(runId: string, status: PracticeRunV6["status"], answers?: PracticeRun["answers"]) { return setPracticeRunStatusV6(runId, status, answers); }
export async function deletePracticeRun(runId: string) { return deletePracticeRunV6(runId); }

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

export function displayedAnswer(question: Question, optionOrder: number[]) {
  if (question.type === "计算") return question.answer;
  return question.answer
    .split("")
    .map((letter) => optionOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((index) => index >= 0)
    .map((index) => String.fromCharCode(65 + index))
    .sort()
    .join("");
}

export function answerText(question: Question, optionOrder: number[]) {
  if (question.type === "计算") return question.answer;
  return question.answer
    .split("")
    .map((letter) => letter.charCodeAt(0) - 65)
    .map((originalIndex) => ({ originalIndex, displayIndex: optionOrder.indexOf(originalIndex) }))
    .sort((a, b) => a.displayIndex - b.displayIndex)
    .map(({ originalIndex, displayIndex }) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`)
    .join("；");
}

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

export const modeLabels = {
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

export const TYPE_ORDER: QuestionType[] = ["单选", "多选", "判断", "计算"];

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
  if (!("serviceWorker" in navigator)) return;
  const registration = await settleWithTimeout(navigator.serviceWorker.getRegistration(), 300);
  if (!registration) return;
  await settleWithTimeout(registration.update(), 700);
}
