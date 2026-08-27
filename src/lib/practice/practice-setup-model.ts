import type { QuestionTypeV7 } from "../db/v7-types";
import { normalizeProgressScope, type ProgressScope } from "./progress-scope";
import { QUESTION_TYPE_ORDER } from "../../types/types";

export type V7PracticeMode = "random30" | "randomCustom" | "sequential" | "randomAll" | "wrong" | "favorite" | "difficult" | "tag" | "advanced";
export type PracticeAmountChoice = "default" | "custom" | "all";

export interface V7PracticeFilter {
  bankIds: string[];
  mode: V7PracticeMode;
  types: QuestionTypeV7[];
  tags: string[];
  tagMatch: "any" | "all";
  status: "all" | "unanswered" | "wrong" | "favorite";
  order: "sequential" | "random" | "difficulty";
  limit: number | null;
  keyword: string;
  keywordMode: "plain" | "regex";
  totalAttemptsMin: number | null;
  totalAttemptsMax: number | null;
  wrongAttemptsMin: number | null;
  wrongAttemptsMax: number | null;
  difficultyMin: number | null;
  difficultyMax: number | null;
  lastAttemptFrom: string;
  lastAttemptTo: string;
  progressScope: ProgressScope;
  reviewRoundId?: string;
  modeLabel?: string;
}

export interface PracticeCombo {
  status: V7PracticeFilter["status"];
  order: V7PracticeFilter["order"];
  amount: PracticeAmountChoice;
}

export interface PracticeSetupFormState {
  bankIds: readonly string[];
  types: readonly QuestionTypeV7[];
  selectedTags: readonly string[];
  tagMatch: V7PracticeFilter["tagMatch"];
  status: V7PracticeFilter["status"];
  order: V7PracticeFilter["order"];
  amountChoice: PracticeAmountChoice;
  requestedRandomCount: number;
  keyword: string;
  keywordMode: V7PracticeFilter["keywordMode"];
  totalAttemptsMin: string;
  totalAttemptsMax: string;
  wrongAttemptsMin: string;
  wrongAttemptsMax: string;
  difficultyMin: string;
  difficultyMax: string;
  lastAttemptFrom: string;
  lastAttemptTo: string;
  reviewRoundId: string;
  effectiveScope: ProgressScope;
  normalizedScope: ProgressScope;
  scopeOverridden: boolean;
}

export interface PracticeSetupValidation {
  regexError: string;
  metricError: string;
  dateError: string;
  typeError: string;
  customRandomError: string;
  disabled: boolean;
}

export const PRACTICE_QUESTION_TYPES: QuestionTypeV7[] = [...QUESTION_TYPE_ORDER];

function metricValue(value: string): number | null {
  return value === "" ? null : Math.max(0, Math.floor(Number(value)));
}

export function countAdvancedPracticeFilters(state: Pick<PracticeSetupFormState,
  "keyword" | "totalAttemptsMin" | "totalAttemptsMax" | "wrongAttemptsMin" | "wrongAttemptsMax" | "difficultyMin" | "difficultyMax" | "lastAttemptFrom" | "lastAttemptTo" | "scopeOverridden"
>): number {
  return [
    Boolean(state.keyword.trim()),
    Boolean(state.totalAttemptsMin || state.totalAttemptsMax),
    Boolean(state.wrongAttemptsMin || state.wrongAttemptsMax),
    Boolean(state.difficultyMin || state.difficultyMax),
    Boolean(state.lastAttemptFrom || state.lastAttemptTo),
    state.scopeOverridden,
  ].filter(Boolean).length;
}

function advancedFieldsActive(filter: V7PracticeFilter, scopeOverridden: boolean): boolean {
  return filter.types.length < PRACTICE_QUESTION_TYPES.length
    || Boolean(filter.keyword.trim())
    || filter.totalAttemptsMin !== null || filter.totalAttemptsMax !== null
    || filter.wrongAttemptsMin !== null || filter.wrongAttemptsMax !== null
    || filter.difficultyMin !== null || filter.difficultyMax !== null
    || Boolean(filter.lastAttemptFrom) || Boolean(filter.lastAttemptTo)
    || scopeOverridden;
}

export function derivePracticeMode(filter: V7PracticeFilter, groupSize: number, advancedActive: boolean): V7PracticeMode {
  if (advancedActive || filter.status === "unanswered") return "advanced";
  if (filter.tags.length) return "tag";
  if (filter.status === "wrong") return "wrong";
  if (filter.status === "favorite") return "favorite";
  if (filter.order === "difficulty") return "difficult";
  if (filter.order === "random" && filter.limit !== null) return filter.limit === groupSize ? "random30" : "randomCustom";
  if (filter.order === "random") return "randomAll";
  return "sequential";
}

export function composePracticeModeLabel(filter: V7PracticeFilter, amount: PracticeAmountChoice, requestedRandomCount: number, groupSize: number): string {
  const parts: string[] = [];
  if (filter.tags.length) parts.push(`标签 ${filter.tags.length} 个`);
  if (filter.status === "wrong") parts.push("错题");
  else if (filter.status === "unanswered") parts.push("未做过");
  else if (filter.status === "favorite") parts.push("收藏");
  parts.push(filter.order === "random" ? "随机" : filter.order === "difficulty" ? "复习优先" : "题库顺序");
  if (amount === "custom") parts.push(`${requestedRandomCount} 题`);
  else if (amount === "default") parts.push(`${groupSize} 题`);
  else parts.push("不限题量");
  return parts.join(" · ");
}

export function assemblePracticeFilter(
  state: PracticeSetupFormState,
  options: { combo?: PracticeCombo | null; quick?: boolean; groupSize: number },
): V7PracticeFilter {
  const quick = options.quick ?? false;
  const combo = options.combo ?? null;
  const amount = quick && combo ? combo.amount : state.amountChoice;
  const quickLimit = combo?.amount === "default" ? options.groupSize : null;
  const comboLimit = state.amountChoice === "custom" ? state.requestedRandomCount : state.amountChoice === "default" ? options.groupSize : null;
  const filter: V7PracticeFilter = {
    bankIds: [...state.bankIds],
    mode: "sequential",
    types: quick ? [...PRACTICE_QUESTION_TYPES] : [...state.types],
    tags: quick ? [] : [...state.selectedTags],
    tagMatch: state.tagMatch,
    status: quick && combo ? combo.status : state.status,
    order: quick && combo ? combo.order : state.order,
    limit: quick ? quickLimit : comboLimit,
    keyword: quick ? "" : state.keyword,
    keywordMode: state.keywordMode,
    totalAttemptsMin: quick ? null : metricValue(state.totalAttemptsMin),
    totalAttemptsMax: quick ? null : metricValue(state.totalAttemptsMax),
    wrongAttemptsMin: quick ? null : metricValue(state.wrongAttemptsMin),
    wrongAttemptsMax: quick ? null : metricValue(state.wrongAttemptsMax),
    difficultyMin: quick ? null : metricValue(state.difficultyMin),
    difficultyMax: quick ? null : metricValue(state.difficultyMax),
    lastAttemptFrom: quick ? "" : state.lastAttemptFrom,
    lastAttemptTo: quick ? "" : state.lastAttemptTo,
    progressScope: quick ? normalizeProgressScope(state.normalizedScope) : normalizeProgressScope(state.effectiveScope),
    ...(state.reviewRoundId ? { reviewRoundId: state.reviewRoundId } : {}),
  };
  filter.mode = derivePracticeMode(filter, options.groupSize, quick ? false : advancedFieldsActive(filter, state.scopeOverridden));
  filter.modeLabel = composePracticeModeLabel(filter, amount, state.requestedRandomCount, options.groupSize);
  return filter;
}

export function validatePracticeSetup(state: PracticeSetupFormState, questionCount: number): PracticeSetupValidation {
  let regexError = "";
  if (state.keywordMode === "regex" && state.keyword.trim()) {
    try { new RegExp(state.keyword); } catch { regexError = "正则表达式格式不正确"; }
  }
  const totalMin = metricValue(state.totalAttemptsMin);
  const totalMax = metricValue(state.totalAttemptsMax);
  const wrongMin = metricValue(state.wrongAttemptsMin);
  const wrongMax = metricValue(state.wrongAttemptsMax);
  const difficultyLow = metricValue(state.difficultyMin);
  const difficultyHigh = metricValue(state.difficultyMax);
  const metricError = totalMin !== null && totalMax !== null && totalMin > totalMax ? "总作答次数的最少值不能大于最多值"
    : wrongMin !== null && wrongMax !== null && wrongMin > wrongMax ? "错误次数的最少值不能大于最多值"
      : (difficultyLow !== null && difficultyLow > 100) || (difficultyHigh !== null && difficultyHigh > 100) ? "难度值范围必须在 0–100 之间"
        : difficultyLow !== null && difficultyHigh !== null && difficultyLow > difficultyHigh ? "最低难度不能大于最高难度" : "";
  const dateError = state.lastAttemptFrom && state.lastAttemptTo && state.lastAttemptFrom > state.lastAttemptTo ? "开始日期不能晚于结束日期" : "";
  const typeError = state.types.length ? "" : "题型：至少选择一种题型";
  const customRandomError = state.amountChoice === "custom" && (!Number.isFinite(state.requestedRandomCount) || state.requestedRandomCount < 1 || state.requestedRandomCount > questionCount)
    ? `请输入 1–${Math.max(1, questionCount)} 之间的题数` : "";
  return {
    regexError,
    metricError,
    dateError,
    typeError,
    customRandomError,
    disabled: !state.bankIds.length || Boolean(customRandomError || typeError || regexError || metricError || dateError),
  };
}
