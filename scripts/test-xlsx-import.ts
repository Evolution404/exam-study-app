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
const rows = await readQuestionWorkbook(templateBuffer);
assert.deepEqual(rows[0].slice(0, 10), ["题干", "答案", "A", "B", "C", "D", "E", "F", "G", "H"]);
assert.match(rows[1][0], /^示例·单选/);
assert.match(rows[2][0], /^示例·判断/);
await assert.rejects(() => parseQuestionBankWorkbook(templateBuffer), (error: unknown) => error instanceof XlsxImportError && /删除模板自带的示例题/.test(error.message));

const questions = parseQuestionBankTable([
  ["题干", "答案", "A", "B", "C", "D"],
  ["单选题", "B", "选项一", "选项二", "选项三", "选项四"],
  ["多选题", "C、A", "甲", "乙", "丙", "丁"],
  ["判断题", "正确", "正确", "错误"],
]);
assert.deepEqual(questions, [
  { q: "单选题", ans: "B", a: ["选项一", "选项二", "选项三", "选项四"] },
  { q: "多选题", ans: "AC", a: ["甲", "乙", "丙", "丁"] },
  { q: "判断题", ans: "A", a: ["正确", "错误"] },
]);

const extendedOptions = parseQuestionBankTable([
  ["题干", "答案", "A", "B", "C", "D", "E", "F", "G", "H"],
  ["九选一", "I", "一", "二", "三", "四", "五", "六", "七", "八", "九"],
]);
assert.equal(extendedOptions[0].a.length, 9, "模板 H 列之后的选项无需补写表头也应可导入");
assert.equal(extendedOptions[0].ans, "I");

assert.throws(() => parseQuestionBankTable([
  ["题干", "答案", "A", "B", "C"],
  ["选项断列", "C", "甲", "", "丙"],
]), (error: unknown) => error instanceof XlsxImportError && error.issues.some((issue) => /不能断列/.test(issue.message)));

assert.throws(() => parseQuestionBankTable([
  ["题干", "答案", "A", "B"],
  ["重复题", "A", "甲", "乙"],
  ["重复题", "B", "甲", "乙"],
]), (error: unknown) => error instanceof XlsxImportError && error.issues.some((issue) => /题目重复/.test(issue.message)));

assert.equal(importFileName("送电线路工-技师.xlsx"), "送电线路工-技师.json");
assert.throws(() => importFileName("随便命名.xlsx"), /请将 Excel 文件重命名/);

console.log("Excel 导入专项测试通过");
