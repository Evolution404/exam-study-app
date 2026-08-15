import type { QuestionType } from "../db/types";

export function shouldSubmitOnChoice(type: QuestionType, submitOnSelect: boolean) {
  return type !== "多选" && type !== "计算" && submitOnSelect;
}
