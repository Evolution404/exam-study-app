import type { QuestionType } from "./types";

export function shouldSubmitOnChoice(type: QuestionType, submitOnSelect: boolean) {
  return type !== "多选" && submitOnSelect;
}
