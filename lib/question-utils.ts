export function normalizeQuestionImageUrl(value: string | undefined) {
  const input = value?.trim();
  if (!input) return undefined;
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("图片地址必须是完整的 http 或 https URL。"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("图片地址只支持 http 或 https URL。");
  return url.toString();
}

export function normalizeCalculationAnswer(value: string) {
  const answer = value.trim();
  if (!answer || !Number.isFinite(Number(answer))) throw new Error("计算题答案必须是有效数字。");
  return answer;
}

export function isCalculationAnswerCorrect(input: string, expected: string, tolerancePercent: number) {
  const actualValue = Number(input.trim());
  const expectedValue = Number(expected.trim());
  if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) return false;
  const tolerance = Math.max(0, tolerancePercent) / 100;
  const scale = Math.abs(expectedValue) || 1;
  return Math.abs(actualValue - expectedValue) <= scale * tolerance + Number.EPSILON;
}
