/** Shared pure helpers for copying question text from the current view model. */
import { formatCalculationAnswers, solutionAnswerText, stableQuestionOptionIds } from "./question-utils";
import type { QuestionSolution } from "../db/v7-types";
import type { QuestionType } from "../../types/types";

export interface QuestionCopySource {
  type: QuestionType;
  stem: string;
  options: string[];
  optionIds?: string[];
  solution: QuestionSolution;
}

export interface QuestionCopyOptions {
  displayOrder?: number[];
  includeAnswer?: boolean;
  wrongSelection?: string[];
}

function resolveOrder(question: QuestionCopySource, displayOrder?: number[]): number[] {
  if (displayOrder?.length === question.options.length) return displayOrder;
  return question.options.map((_, index) => index);
}

export function displayedAnswer(question: QuestionCopySource, optionOrder: number[]): string {
  const solution = question.solution;
  if (solution.kind === "calculation") return formatCalculationAnswers(solution.blanks.map((blank) => String(blank.expected)));
  if (solution.kind === "fill") return solution.blanks.map((blank, index) => `第${index + 1}空：${blank.acceptedAnswers.join(" / ")}`).join("；");
  if (solution.kind === "short") return "参考答案：" + solution.referenceText;
  const optionIds = stableQuestionOptionIds({ options: question.options.map((text) => [{ id: "text", type: "text", text }]), optionIds: question.optionIds });
  const answer = solutionAnswerText(solution, optionIds);
  return answer
    .split("")
    .map((letter) => optionOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((index) => index >= 0)
    .map((index) => String.fromCharCode(65 + index))
    .sort()
    .join("");
}

export function answerText(question: QuestionCopySource, optionOrder: number[]): string {
  const solution = question.solution;
  if (solution.kind === "calculation") return formatCalculationAnswers(solution.blanks.map((blank) => String(blank.expected)));
  if (solution.kind === "fill") return solution.blanks.map((blank, index) => `第${index + 1}空：${blank.acceptedAnswers.join(" / ")}`).join("；");
  if (solution.kind === "short") return "参考答案：" + solution.referenceText;
  const optionIds = stableQuestionOptionIds({ options: question.options.map((text) => [{ id: "text", type: "text", text }]), optionIds: question.optionIds });
  const answer = solutionAnswerText(solution, optionIds);
  return answer
    .split("")
    .map((letter) => letter.charCodeAt(0) - 65)
    .map((originalIndex) => ({ originalIndex, displayIndex: optionOrder.indexOf(originalIndex) }))
    .sort((a, b) => a.displayIndex - b.displayIndex)
    .map(({ originalIndex, displayIndex }) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`)
    .join("；");
}

function wrongSelectionText(question: QuestionCopySource, order: number[], wrongSelection: string[]): string {
  if (!wrongSelection.length) return "我的选择：不会";
  if (question.type === "计算") return `我的选择：${formatCalculationAnswers(wrongSelection)}`;
  if (question.type === "填空") return `我的选择：${wrongSelection.join("；")}`;
  if (question.type === "简答") return `我的回答：${wrongSelection.join("\n")}`;
  return `我的选择：${wrongSelection
    .map((letter) => letter.charCodeAt(0) - 65)
    .map((originalIndex) => order.indexOf(originalIndex))
    .filter((displayIndex) => displayIndex >= 0)
    .sort((a, b) => a - b)
    .map((displayIndex) => String.fromCharCode(65 + displayIndex))
    .join("")}`;
}

export function buildQuestionCopyText(question: QuestionCopySource, options?: QuestionCopyOptions): string {
  const order = resolveOrder(question, options?.displayOrder);
  const lines = [
    `题型：${question.type}`,
    `题目：${question.stem}`,
  ];
  if (question.options.length) {
    lines.push("选项：");
    lines.push(...order.map((originalIndex, displayIndex) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`));
  }
  if (options?.includeAnswer) lines.push(`正确答案：${displayedAnswer(question, order)}`);
  if (options?.wrongSelection) lines.push(wrongSelectionText(question, order, options.wrongSelection));
  return lines.join("\n");
}

/** Clipboard API first, then the synchronous browser copy path. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    return true;
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
      return true;
    } catch {
      return false;
    }
  }
}
