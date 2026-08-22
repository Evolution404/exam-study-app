import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import {
  XlsxImportError,
  importFileName,
  parseQuestionBankTable,
  parseQuestionBankWorkbook,
  readQuestionWorkbook,
} from "../../src/lib/io/xlsx-import";

const template = await readFile(new URL("../../public/题库模板.xlsx", import.meta.url));
const templateBuffer = template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength) as ArrayBuffer;
const workbook = await readQuestionWorkbook(templateBuffer);
const rows = workbook.rows;
assert.deepEqual(rows[0].slice(0, 10), ["题干", "题型", "标签", "解析", "答案1", "答案2", "答案3", "答案4", "A", "B"]);
assert.match(rows[1][0], /^示例·单选/);
assert.match(rows[3][0], /^示例·判断/);
assert.match(rows[4][0], /^示例·单空计算/);
assert.match(rows[5][0], /^示例·多空计算/);
assert.equal(rows[5][4], "11.0");
assert.equal(rows[5][5], "968.0");
assert.deepEqual(rows[0].slice(-2), ["H", "图片1"], "最新模板必须包含连续的图片列");
assert.match(rows[6][0], /^示例·图片单选/);
assert.match(rows[6][0], /【图1】/, "图片示例题干必须标出图片位置");
assert.equal(workbook.images.size, 1, "图片示例必须携带一张真实嵌入图片");
const imageExample = [...rows[6]];
imageExample[0] = "图中图标对应哪个应用？【图1】";
const parsedImageExample = parseQuestionBankTable([rows[0], imageExample], workbook.images);
assert.deepEqual(parsedImageExample[0].images, ["ID_TEMPLATE_SHIJUAN_APP_ICON"], "删除示例标记后的图片题必须可直接导入");
const sheetJsWorkbook = XLSX.read(template, { type: "buffer" });
const instructionText = XLSX.utils.sheet_to_json<string[]>(sheetJsWorkbook.Sheets["使用说明"], { header: 1 }).flat().join("\n");
assert.doesNotMatch(instructionText, /Excel 只导入纯文字题/, "模板不得保留过时的纯文字限制");
assert.match(instructionText, /支持题干图片和选项图片/);
assert.match(instructionText, /每题最多 12 个填空、24 个选项、12 张图片/);
assert.match(instructionText, /答案1对应空1、答案2对应空2/);
await assert.rejects(() => parseQuestionBankWorkbook(templateBuffer), (error: unknown) => error instanceof XlsxImportError && /删除模板自带的示例题/.test(error.message));

const questions = parseQuestionBankTable([
  ["题干", "题型", "标签", "解析", "答案1", "答案2", "A", "B", "C", "D"],
  ["单选题", "单选", "基础", "单选题解析", "B", "", "选项一", "选项二", "选项三", "选项四"],
  ["多选题", "多选", "", "", "C、A", "", "甲", "乙", "丙", "丁"],
  ["判断题", "判断", "判断", "判断题解析", "正确", "", "正确", "错误"],
  ["电流【空1】A，功率【空2】W", "计算", "计算", "计算题解析", "11", "968"],
]);
assert.deepEqual(questions, [
  { q: "单选题", ans: "B", a: ["选项一", "选项二", "选项三", "选项四"], type: "单选", tags: ["基础"], note: "单选题解析" },
  { q: "多选题", ans: "AC", a: ["甲", "乙", "丙", "丁"], type: "多选", tags: [] },
  { q: "判断题", ans: "A", a: ["正确", "错误"], type: "判断", tags: ["判断"], note: "判断题解析" },
  { q: "电流【空1】A，功率【空2】W", ans: "11\n968", a: [], type: "计算", tags: ["计算"], note: "计算题解析" },
]);

const extendedOptions = parseQuestionBankTable([
  ["题干", "题型", "标签", "解析", "答案1", "A", "B", "C", "D", "E", "F", "G", "H", "I"],
  ["九选一", "单选", "", "", "I", "一", "二", "三", "四", "五", "六", "七", "八", "九"],
]);
assert.equal(extendedOptions[0].a.length, 9, "连续声明到 I 的选项列应可导入");
assert.equal(extendedOptions[0].ans, "I");

assert.throws(() => parseQuestionBankTable([
  ["题干", "题型", "标签", "解析", "答案1", "A", "B", "C"],
  ["选项断列", "单选", "", "", "C", "甲", "", "丙"],
]), (error: unknown) => error instanceof XlsxImportError && error.issues.some((issue) => /不能断列/.test(issue.message)));

assert.throws(() => parseQuestionBankTable([
  ["题干", "题型", "标签", "解析", "答案1", "A", "B"],
  ["重复题", "单选", "", "", "A", "甲", "乙"],
  ["重复题", "单选", "", "", "B", "甲", "乙"],
]), (error: unknown) => error instanceof XlsxImportError && error.issues.some((issue) => /题目重复/.test(issue.message)));

assert.throws(() => parseQuestionBankTable([
  ["题干", "题型", "答案", "标签", "解析", "A", "B"],
  ["旧格式", "单选", "A", "", "", "甲", "乙"],
]), (error: unknown) => error instanceof XlsxImportError && /最新模板/.test(error.message), "旧版 Excel 表头不再兼容");

assert.equal(importFileName("送电线路工-技师.xlsx"), "送电线路工-技师.json");
assert.equal(importFileName("自建专业题库.xlsx"), "自建专业题库.json");
assert.throws(() => importFileName(".xlsx"), /文件名不能为空/);

console.log("Excel 导入专项测试通过");
