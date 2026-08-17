/**
 * 复制题目的共享纯函数：练习页与题目详情页共用一套文本构造与剪贴板兜底。
 *
 * 文本基于 QuestionViewModel 的纯文本投影（stem/options，图片块被丢弃）；
 * 选项字母由 displayOrder（练习页选项打乱）映射为用户实际看到的显示字母，
 * 不传则按原始字母输出（题目详情页与正文渲染顺序一致）。
 */

export interface QuestionCopySource {
  type: string;
  stem: string;
  options: string[];
  answer: string;
}

export interface QuestionCopyOptions {
  /** 选项显示顺序（练习页打乱后）；缺省或长度不符 = 原始顺序。 */
  displayOrder?: number[];
  /** 追加一行「正确答案：字母. 选项文本」（计算题为数值）。 */
  includeAnswer?: boolean;
  /** 原始选项字母（计算题为 [输入值]）；空数组 = 不会。 */
  wrongSelection?: string[];
}

/** displayOrder 缺省/长度不符时回退原始顺序（与 Practice 组件同款防御）。 */
function resolveOrder(question: QuestionCopySource, displayOrder?: number[]): number[] {
  if (displayOrder?.length === question.options.length) return displayOrder;
  return question.options.map((_, index) => index);
}

export function displayedAnswer(question: QuestionCopySource, optionOrder: number[]): string {
  if (question.type === "计算") return question.answer;
  return question.answer
    .split("")
    .map((letter) => optionOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((index) => index >= 0)
    .map((index) => String.fromCharCode(65 + index))
    .sort()
    .join("");
}

export function answerText(question: QuestionCopySource, optionOrder: number[]): string {
  if (question.type === "计算") return question.answer;
  return question.answer
    .split("")
    .map((letter) => letter.charCodeAt(0) - 65)
    .map((originalIndex) => ({ originalIndex, displayIndex: optionOrder.indexOf(originalIndex) }))
    .sort((a, b) => a.displayIndex - b.displayIndex)
    .map(({ originalIndex, displayIndex }) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`)
    .join("；");
}

/** 我的选择（做错时附上）：与「答案内容」同款「X. 文本；Y. 文本」格式。 */
function wrongSelectionText(question: QuestionCopySource, order: number[], wrongSelection: string[]): string {
  if (!wrongSelection.length) return "我的选择：不会";
  if (question.type === "计算") return `我的选择：${wrongSelection[0]}`;
  return `我的选择：${wrongSelection
    .map((letter) => letter.charCodeAt(0) - 65)
    .map((originalIndex) => ({ originalIndex, displayIndex: order.indexOf(originalIndex) }))
    .filter(({ displayIndex }) => displayIndex >= 0)
    .sort((a, b) => a.displayIndex - b.displayIndex)
    .map(({ originalIndex, displayIndex }) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`)
    .join("；")}`;
}

export function buildQuestionCopyText(question: QuestionCopySource, options?: QuestionCopyOptions): string {
  const order = resolveOrder(question, options?.displayOrder);
  const lines = [
    `题型：${question.type}`,
    `题目：${question.stem}`,
  ];
  // 计算题没有选项，整段省略（旧行为会输出空「选项：」行）。
  if (question.options.length) {
    lines.push("选项：");
    lines.push(...order.map((originalIndex, displayIndex) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`));
  }
  if (options?.includeAnswer) {
    // 只输出一行「正确答案：字母. 选项文本」（与「我的选择」同款格式），
    // 不再单独列「答案内容」行（用户确认口径）。
    lines.push(`正确答案：${answerText(question, order)}`);
  }
  if (options?.wrongSelection) {
    lines.push(wrongSelectionText(question, order, options.wrongSelection));
  }
  return lines.join("\n");
}

/** clipboard API 优先，execCommand 兜底；返回是否成功（失败由调用方展示 error 态）。 */
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
