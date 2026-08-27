import type { AttemptOutcome, QuestionV7 } from "../db/v7-types";
import {
  areCalculationAnswersCorrect,
  calculationBlankIndexes,
  fillAnswersAreCorrect,
  formatCalculationAnswers,
  stableQuestionOptionIds,
} from "../question/question-utils";

export interface PracticeAnswerStateInput {
  question: QuestionV7;
  stem: string;
  selected: readonly string[];
  calculationDrafts: readonly string[];
  fillDrafts: readonly string[];
  shortOutcome?: AttemptOutcome;
  submitted: boolean;
  displayOrder: readonly number[];
  calculationTolerancePercent: number;
  showAnswerOnWrong: boolean;
}

export interface PracticeAnswerDerivedState {
  optionIds: string[];
  correctOptionIds: Set<string>;
  expectedCalculationAnswers: string[];
  expectedFillSolution?: Extract<QuestionV7["solution"], { kind: "fill" }>;
  shortSolution?: Extract<QuestionV7["solution"], { kind: "short" }>;
  selectedAnswer: string;
  correct: boolean;
  hasInlineCalculationBlanks: boolean;
  hasInlineFillBlanks: boolean;
  calculationInputValid: boolean;
  fillInputValid: boolean;
  gaveUp: boolean;
  revealAnswer: boolean;
}

export function isPracticeAnswerCorrect(
  question: QuestionV7,
  selected: readonly string[],
  calculationTolerancePercent: number,
  shortOutcome?: AttemptOutcome,
): boolean {
  const solution = question.solution;
  if (question.type === "计算") {
    return solution.kind === "calculation"
      && areCalculationAnswersCorrect(selected, solution.blanks.map((blank) => String(blank.expected)), calculationTolerancePercent);
  }
  if (question.type === "填空") return solution.kind === "fill" && fillAnswersAreCorrect(selected, solution);
  if (question.type === "简答") return solution.kind === "short" && shortOutcome === "correct";
  if (solution.kind !== "choice") return false;
  const optionIds = stableQuestionOptionIds(question);
  const correctOptionIds = new Set(solution.correctOptionIds);
  const selectedOptionIds = selected
    .map((letter) => optionIds[letter.charCodeAt(0) - 65])
    .filter((id): id is string => Boolean(id));
  return selectedOptionIds.length === correctOptionIds.size && selectedOptionIds.every((id) => correctOptionIds.has(id));
}

export function derivePracticeAnswerState(input: PracticeAnswerStateInput): PracticeAnswerDerivedState {
  const { question, selected, calculationDrafts, fillDrafts, shortOutcome, submitted, displayOrder, calculationTolerancePercent, showAnswerOnWrong } = input;
  const solution = question.solution;
  const optionIds = solution.kind === "choice" ? stableQuestionOptionIds(question) : [];
  const correctOptionIds = solution.kind === "choice" ? new Set(solution.correctOptionIds) : new Set<string>();
  const expectedCalculationAnswers = solution.kind === "calculation" ? solution.blanks.map((blank) => String(blank.expected)) : [];
  const expectedFillSolution = solution.kind === "fill" ? solution : undefined;
  const shortSolution = solution.kind === "short" ? solution : undefined;
  const selectedAnswer = question.type === "计算" ? formatCalculationAnswers(selected)
    : question.type === "填空" ? selected.join("；")
      : question.type === "简答" ? selected.join("\n")
        : selected
          .map((letter) => displayOrder.indexOf(letter.charCodeAt(0) - 65))
          .filter((displayIndex) => displayIndex >= 0)
          .map((displayIndex) => String.fromCharCode(65 + displayIndex))
          .sort()
          .join("");
  const correct = submitted && isPracticeAnswerCorrect(question, selected, calculationTolerancePercent, shortOutcome);
  const hasInlineCalculationBlanks = question.type === "计算"
    && calculationBlankIndexes(input.stem).length === expectedCalculationAnswers.length;
  const hasInlineFillBlanks = question.type === "填空"
    && calculationBlankIndexes(input.stem).length === (expectedFillSolution?.blanks.length ?? 0);
  const calculationInputValid = question.type === "计算"
    && calculationDrafts.length === expectedCalculationAnswers.length
    && calculationDrafts.every((value) => value.trim() && Number.isFinite(Number(value)));
  const fillInputValid = question.type === "填空"
    && fillDrafts.length === (expectedFillSolution?.blanks.length ?? 0)
    && fillDrafts.every((value) => value.trim());
  const gaveUp = submitted && selected.length === 0;
  return {
    optionIds,
    correctOptionIds,
    expectedCalculationAnswers,
    expectedFillSolution,
    shortSolution,
    selectedAnswer,
    correct,
    hasInlineCalculationBlanks,
    hasInlineFillBlanks,
    calculationInputValid,
    fillInputValid,
    gaveUp,
    revealAnswer: submitted && (correct || showAnswerOnWrong),
  };
}
