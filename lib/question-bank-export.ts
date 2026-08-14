/**
 * Export a question bank as an Excel workbook or a JSON file.
 *
 * Both formats round-trip through the v6 import path: Excel uses the app's own
 * template columns (题干 / 题型 / 答案 / 标签 / 解析 / 选项A…), and JSON uses the
 * `{ name, questions: [{ type, stem, options, answer, tags, note }] }` shape that
 * `rawQuestionRows` / `importDraft` already accept.
 */
import { buildXlsx, type XlsxSheet } from "./xlsx-export";

export interface ExportQuestionInput {
  id: string;
  type: string;
  stem: string;
  options: string[];
  answer: string;
  tags: string[];
}

const HEADER = ["题干", "题型", "答案", "标签", "解析"];

function optionColumns(questions: readonly ExportQuestionInput[]): number {
  // The importer requires at least A、B two option columns, so an all-计算题
  // bank must still export those two empty columns to remain re-importable.
  return Math.max(2, questions.reduce((max, question) => Math.max(max, question.options.length), 0));
}

/** Build the 题库 sheet: header row plus one row per question. */
export function questionExportRows(questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>): string[][] {
  const columns = optionColumns(questions);
  const header = [...HEADER, ...Array.from({ length: columns }, (_, index) => String.fromCharCode(65 + index))];
  const rows = questions.map((question) => {
    const base = [question.stem, question.type, question.answer, question.tags.join("、"), notes.get(question.id) ?? ""];
    const options = Array.from({ length: columns }, (_, index) => question.options[index] ?? "");
    return [...base, ...options];
  });
  return [header, ...rows];
}

/** Build the JSON export body for a bank. */
export function questionExportJson(name: string, questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>): string {
  const body = {
    name,
    questions: questions.map((question) => {
      const note = notes.get(question.id)?.trim();
      return {
        type: question.type,
        stem: question.stem,
        options: question.options,
        answer: question.answer,
        tags: question.tags,
        ...(note ? { note } : {}),
      };
    }),
  };
  return JSON.stringify(body, null, 2);
}

/** Strip characters that are invalid in a file name across platforms. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 ? "" : `/\\:*?"<>|`.includes(char) ? "_" : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "题库";
}

const INSTRUCTIONS: string[][] = [
  ["拾卷 · 题库 Excel 导出说明"],
  ["适用项目", "拾卷（exam-study-app）本地优先刷题 PWA"],
  ["本文件由题库导出生成，可直接改回本 App 重新导入。"],
  ["题干", "必填。支持普通文字，以及 $...$ 行内公式和 $$...$$ 独立公式。"],
  ["题型", "必填，只能填写：单选、多选、判断、计算。"],
  ["答案", "单选填一个字母；多选填多个字母（如 AC）；判断填 A/正确 或 B/错误；计算题填标准数值（如 12.5、-3、1e6）。"],
  ["标签", "可选。多个标签使用中文逗号、英文逗号或顿号分隔。"],
  ["解析", "可选。该题的个人解析，导入时会写回为本机笔记。"],
  ["选项", "单选、多选、判断题从 A 列开始连续填写，不得断列；判断题必须依次为“正确、错误”。计算题不要填写选项。"],
  ["图片题", "Excel 只导出纯文字题。题目中的图片不会导出，导入后需重新插入。"],
];

/** Assemble the full .xlsx bytes for a bank. */
export function buildQuestionBankXlsx(questions: readonly ExportQuestionInput[], notes: ReadonlyMap<string, string>): Uint8Array {
  const sheets: XlsxSheet[] = [
    { name: "题库", rows: questionExportRows(questions, notes) },
    { name: "使用说明", rows: INSTRUCTIONS },
  ];
  return buildXlsx(sheets);
}

/** Trigger a client-side download, preferring the Web Share API on mobile. */
export async function downloadExport(filename: string, blob: Blob): Promise<void> {
  const file = new File([blob], filename, { type: blob.type });
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  if (mobile && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share({ title: filename, files: [file] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!(error instanceof DOMException) || !["NotAllowedError", "SecurityError"].includes(error.name)) throw error;
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
