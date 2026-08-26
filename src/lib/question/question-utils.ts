import type { ContentBlock, QuestionSolution, QuestionTypeV7, QuestionV7 } from "../db/v7-types";

export const MAX_CALCULATION_BLANKS = 12;
export const CALCULATION_BLANK_PATTERN = /【空([1-9][0-9]*)】/g;

/** Parse current human/file input: one calculation answer per line. */
export function calculationAnswers(value: string | readonly string[]): string[] {
  const source = Array.isArray(value) ? [...value] : String(value).split(/\r?\n/);
  return source.map((answer) => String(answer).trim());
}

export function normalizeCalculationAnswer(value: string | readonly string[]) {
  const answers = calculationAnswers(value);
  if (!answers.length || answers.some((answer) => !answer || !Number.isFinite(Number(answer)))) {
    throw new Error("计算题的每个答案都必须是有效数字。");
  }
  if (answers.length > MAX_CALCULATION_BLANKS) throw new Error(`计算题最多支持 ${MAX_CALCULATION_BLANKS} 个填空。`);
  return answers.join("\n");
}

export function calculationBlankIndexes(text: string): number[] {
  return [...text.matchAll(CALCULATION_BLANK_PATTERN)].map((match) => Number(match[1]));
}

export function validateCalculationBlankLayout(text: string, answer: string | readonly string[]) {
  const answers = calculationAnswers(answer);
  const indexes = calculationBlankIndexes(text);
  if (!indexes.length) throw new Error("计算题题干必须使用【空1】标出填空位置。");
  if (indexes.length !== answers.length) throw new Error(`题干包含 ${indexes.length} 个填空，但填写了 ${answers.length} 个标准答案。`);
  const invalidIndex = indexes.findIndex((value, index) => value !== index + 1);
  if (invalidIndex >= 0) throw new Error("计算题填空必须从【空1】开始连续编号，且每个编号只能出现一次。");
}

export function formatCalculationAnswers(value: string | readonly string[]) {
  const answers = calculationAnswers(value);
  if (answers.length <= 1) return answers[0] ?? "";
  return answers.map((answer, index) => `第${index + 1}空：${answer}`).join("；");
}

export function isCalculationAnswerCorrect(input: string, expected: string, tolerancePercent: number) {
  const actualValue = Number(input.trim());
  const expectedValue = Number(expected.trim());
  if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) return false;
  const tolerance = Math.max(0, tolerancePercent) / 100;
  const scale = Math.abs(expectedValue) || 1;
  return Math.abs(actualValue - expectedValue) <= scale * tolerance + Number.EPSILON;
}

export function areCalculationAnswersCorrect(input: readonly string[], expected: string | readonly string[], tolerancePercent: number) {
  const expectedAnswers = calculationAnswers(expected);
  return input.length === expectedAnswers.length
    && input.every((answer, index) => isCalculationAnswerCorrect(answer, expectedAnswers[index], tolerancePercent));
}

export const MAX_FILL_BLANKS = 12;
const FILL_ACCEPTED_ANSWER_SEPARATOR = "||";

function normalizeFillAnswer(value: string): string {
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

function splitAcceptedText(value: string): string[] {
  return [...new Set(String(value)
    .split(FILL_ACCEPTED_ANSWER_SEPARATOR)
    .map(normalizeFillAnswer)
    .filter(Boolean))];
}

/** Parse current text-import/editor syntax into positional fill answers. */
function fillBlankAnswers(value: string | readonly string[]): string[][] {
  const cells = Array.isArray(value) ? value.map(String) : String(value).split(/\r?\n/);
  return cells.map(splitAcceptedText).filter((answers) => answers.length > 0);
}

function serializeFillBlankAnswers(blanks: readonly (readonly string[])[]): string {
  return blanks.map((answers) => [...new Set(answers.map(normalizeFillAnswer).filter(Boolean))].join(FILL_ACCEPTED_ANSWER_SEPARATOR)).join("\n");
}

export function normalizeFillSolution(value: string | readonly string[][] | readonly string[]): Extract<QuestionSolution, { kind: "fill" }> {
  const blanks = typeof value !== "string"
    ? value.map((answers, index) => {
      const values = Array.isArray(answers) ? answers : [answers];
      return { id: `blank-${index + 1}`, acceptedAnswers: [...new Set(values.map((answer) => normalizeFillAnswer(String(answer))).filter(Boolean))] };
    })
    : fillBlankAnswers(value).map((answers, index) => ({ id: `blank-${index + 1}`, acceptedAnswers: answers }));
  if (!blanks.length || blanks.length > MAX_FILL_BLANKS || blanks.some((blank) => !blank.acceptedAnswers.length)) {
    throw new Error(`填空题必须包含 1-${MAX_FILL_BLANKS} 个有效标准答案。`);
  }
  return { kind: "fill", blanks };
}

export function fillAnswersAreCorrect(input: readonly string[], expected: Extract<QuestionSolution, { kind: "fill" }>): boolean {
  return input.length === expected.blanks.length && expected.blanks.every((blank, index) => {
    const value = normalizeFillAnswer(input[index] ?? "");
    return Boolean(value) && blank.acceptedAnswers.some((answer) => normalizeFillAnswer(answer) === value);
  });
}

function hashToken(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function contentIdentity(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => block.type === "text" ? `t:${normalizeFillAnswer(block.text)}` : `i:${block.assetId}`).join("|");
}

export function stableQuestionOptionIds(question: Pick<QuestionV7, "options" | "optionIds">): string[] {
  if (question.optionIds?.length === question.options.length && new Set(question.optionIds).size === question.optionIds.length && question.optionIds.every(Boolean)) {
    return [...question.optionIds];
  }
  return question.options.map((option) => `option-${hashToken(contentIdentity(option))}`);
}

export function stableOptionIdForBlocks(blocks: readonly ContentBlock[]): string {
  return `option-${hashToken(contentIdentity(blocks))}`;
}

function calculationSolutionFromInput(value: string | readonly string[]): Extract<QuestionSolution, { kind: "calculation" }> {
  const answers = calculationAnswers(value);
  if (!answers.length || answers.length > MAX_CALCULATION_BLANKS || answers.some((answer) => !Number.isFinite(Number(answer)))) {
    throw new Error(`计算题必须包含 1-${MAX_CALCULATION_BLANKS} 个有效数字答案。`);
  }
  return { kind: "calculation", blanks: answers.map((answer, index) => ({ id: `blank-${index + 1}`, expected: Number(answer) })) };
}

/** Convert current editor/import text input into the canonical solution shape. */
export function solutionFromInput(
  type: QuestionTypeV7,
  answer: string | readonly string[],
  options: readonly ContentBlock[][],
  optionIds?: readonly string[],
): QuestionSolution {
  if (type === "计算") return calculationSolutionFromInput(answer);
  if (type === "填空") return normalizeFillSolution(answer);
  if (type === "简答") return shortAnswerSolution(Array.isArray(answer) ? answer.join("\n") : String(answer));
  const ids = optionIds?.length === options.length ? [...optionIds] : options.map((option) => stableOptionIdForBlocks(option));
  const letters = (Array.isArray(answer) ? answer.join("") : String(answer)).toUpperCase().replace(/[^A-Z]/g, "");
  return {
    kind: "choice",
    correctOptionIds: [...new Set([...letters]
      .map((letter) => ids[letter.charCodeAt(0) - 65])
      .filter((id): id is string => Boolean(id)))],
  };
}

/** Strict accessor for the current canonical question format. */
export function questionSolution(question: Pick<QuestionV7, "solution">): QuestionSolution {
  return question.solution;
}

/** Format a canonical solution for UI/export text only; this value is never persisted. */
export function solutionAnswerText(solution: QuestionSolution, optionIds: readonly string[] = []): string {
  if (solution.kind === "choice") {
    return solution.correctOptionIds.map((id) => {
      const index = optionIds.indexOf(id);
      return index >= 0 ? String.fromCharCode(65 + index) : "";
    }).filter(Boolean).sort().join("");
  }
  if (solution.kind === "calculation") return solution.blanks.map((blank) => String(blank.expected)).join("\n");
  if (solution.kind === "fill") return serializeFillBlankAnswers(solution.blanks.map((blank) => blank.acceptedAnswers));
  return solution.referenceText;
}

export function shortAnswerSolution(referenceText: string): Extract<QuestionSolution, { kind: "short" }> {
  return { kind: "short", referenceText: referenceText.trim() };
}
