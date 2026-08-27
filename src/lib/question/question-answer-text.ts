import type { QuestionV7 } from "../db/v7-types";
import { deriveContentText } from "./question-content";
import { formatCalculationAnswers, stableQuestionOptionIds } from "./question-utils";

/**
 * Current-schema canonical answer text for presentation/search consumers.
 * This module is intentionally free of Dexie and UI dependencies.
 */
export function questionAnswerTextV7(question: QuestionV7): string {
  const solution = question.solution;
  if (solution.kind === "choice") {
    const optionIds = stableQuestionOptionIds(question);
    return solution.correctOptionIds
      .map((id) => optionIds.indexOf(id))
      .filter((index) => index >= 0)
      .map((index) => deriveContentText(question.options[index] ?? []))
      .filter(Boolean)
      .join("、");
  }
  if (solution.kind === "calculation") {
    return formatCalculationAnswers(solution.blanks.map((blank) => String(blank.expected)));
  }
  if (solution.kind === "fill") {
    return solution.blanks
      .map((blank, index) => `第${index + 1}空：${blank.acceptedAnswers.join(" / ")}`)
      .join("；");
  }
  return solution.referenceText;
}
