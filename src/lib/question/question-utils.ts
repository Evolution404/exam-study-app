/** Legacy v5-only URL normalizer retained for the read-only migration source. */
export function normalizeQuestionImageUrl(value: string | undefined) {
  const input = value?.trim();
  if (!input) return undefined;
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("图片地址必须是完整的 http 或 https URL。"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("图片地址只支持 http 或 https URL。");
  return url.toString();
}

export const MAX_CALCULATION_BLANKS = 12;
export const CALCULATION_BLANK_PATTERN = /【空([1-9][0-9]*)】/g;

/** Internal storage stays a string so the v7 question/sync schema remains
 * stable. One answer per line is unambiguous and round-trips to Excel's
 * 答案1、答案2… columns without guessing punctuation. */
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

/** New calculation questions must declare every answer position explicitly.
 * Repeated, skipped or out-of-order placeholders would make the UI ambiguous. */
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
