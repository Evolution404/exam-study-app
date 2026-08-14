import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  XlsxImportError,
  importFileName,
  parseQuestionBankTable,
  parseQuestionBankWorkbook,
  readQuestionWorkbook,
} from "../lib/xlsx-import";

const template = await readFile(new URL("../public/题库模板.xlsx", import.meta.url));
const templateBuffer = template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength) as ArrayBuffer;
const workbook = await readQuestionWorkbook(templateBuffer);
const rows = workbook.rows;
assert.deepEqual(rows[0].slice(0, 9), ["题干", "题型", "答案", "标签", "解析", "A", "B", "C", "D"]);
assert.match(rows[1][0], /^示例·单选/);
assert.match(rows[3][0], /^示例·判断/);
assert.match(rows[4][0], /^示例·计算/);
await assert.rejects(() => parseQuestionBankWorkbook(templateBuffer), (error: unknown) => error instanceof XlsxImportError && /删除模板自带的示例题/.test(error.message));

const questions = parseQuestionBankTable([
  ["题干", "题型", "答案", "标签", "解析", "A", "B", "C", "D"],
  ["单选题", "单选", "B", "基础", "单选题解析", "选项一", "选项二", "选项三", "选项四"],
  ["多选题", "多选", "C、A", "", "", "甲", "乙", "丙", "丁"],
  ["判断题", "判断", "正确", "判断", "判断题解析", "正确", "错误"],
  ["计算题", "计算", "12.5", "计算", "计算题解析"],
]);
assert.deepEqual(questions, [
  { q: "单选题", ans: "B", a: ["选项一", "选项二", "选项三", "选项四"], type: "单选", tags: ["基础"], note: "单选题解析" },
  { q: "多选题", ans: "AC", a: ["甲", "乙", "丙", "丁"], type: "多选", tags: [] },
  { q: "判断题", ans: "A", a: ["正确", "错误"], type: "判断", tags: ["判断"], note: "判断题解析" },
  { q: "计算题", ans: "12.5", a: [], type: "计算", tags: ["计算"], note: "计算题解析" },
]);

const extendedOptions = parseQuestionBankTable([
  ["题干", "题型", "答案", "标签", "解析", "A", "B", "C", "D", "E", "F", "G", "H"],
  ["九选一", "单选", "I", "", "", "一", "二", "三", "四", "五", "六", "七", "八", "九"],
]);
assert.equal(extendedOptions[0].a.length, 9, "模板 H 列之后的选项无需补写表头也应可导入");
assert.equal(extendedOptions[0].ans, "I");

assert.throws(() => parseQuestionBankTable([
  ["题干", "题型", "答案", "标签", "解析", "A", "B", "C"],
  ["选项断列", "单选", "C", "", "", "甲", "", "丙"],
]), (error: unknown) => error instanceof XlsxImportError && error.issues.some((issue) => /不能断列/.test(issue.message)));

assert.throws(() => parseQuestionBankTable([
  ["题干", "题型", "答案", "标签", "解析", "A", "B"],
  ["重复题", "单选", "A", "", "", "甲", "乙"],
  ["重复题", "单选", "B", "", "", "甲", "乙"],
]), (error: unknown) => error instanceof XlsxImportError && error.issues.some((issue) => /题目重复/.test(issue.message)));

assert.equal(importFileName("送电线路工-技师.xlsx"), "送电线路工-技师.json");
assert.equal(importFileName("自建专业题库.xlsx"), "自建专业题库.json");
assert.throws(() => importFileName(".xlsx"), /文件名不能为空/);

console.log("Excel 导入专项测试通过");
