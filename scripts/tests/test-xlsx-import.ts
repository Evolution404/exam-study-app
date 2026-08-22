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
import { buildStoredZip } from "../../src/lib/io/xlsx-export";
import { collapseExtractedVisualLineBreaks, isVisualWrapExtractionSource } from "../../src/lib/question/imported-text-cleanup";
import { IMPORT_LIMITS } from "../../src/lib/io/import-limits";

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

// Open XML producers may legally prefix spreadsheet tags (for example
// DocumentFormat.OpenXml emits <x:sheet>, <x:row>, <x:c> and <x:v>). Large
// image workbooks also contain one archive entry per embedded image, so a few
// hundred entries are normal rather than evidence of a zip bomb.
const encoder = new TextEncoder();
const prefixedHeader = ["题干", "题型", "标签", "解析", "答案1", "A", "B"];
const prefixedRows = [prefixedHeader, ["命名空间兼容题", "单选", "兼容", "", "A", "正确项", "错误项"]]
  .map((row, rowIndex) => `<x:row r="${rowIndex + 1}">${row.map((value, columnIndex) => `<x:c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="str"><x:v>${value}</x:v></x:c>`).join("")}</x:row>`)
  .join("");
const prefixedWorkbook = buildStoredZip([
  { name: "[Content_Types].xml", data: encoder.encode("<Types/>") },
  { name: "xl/workbook.xml", data: encoder.encode('<?xml version="1.0"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="题库" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>') },
  { name: "xl/_rels/workbook.xml.rels", data: encoder.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>') },
  { name: "xl/worksheets/sheet1.xml", data: encoder.encode(`<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>${prefixedRows}</x:sheetData></x:worksheet>`) },
  // WPS workbooks routinely contain hundreds of media entries.  Keep a fixed
  // synthetic 331-entry / 320-image namespace-prefixed fixture so raising the
  // archive limit does not regress while still exercising the central-dir
  // bounds and XML prefix handling.
  ...Array.from({ length: 320 }, (_, index) => ({ name: `xl/media/unused-${index}.png`, data: new Uint8Array([index & 0xff]) })),
  ...Array.from({ length: 7 }, (_, index) => ({ name: `xl/extra/unused-${index}.xml`, data: new Uint8Array([index & 0xff]) })),
]);
const prefixedParsed = await parseQuestionBankWorkbook(prefixedWorkbook.buffer.slice(prefixedWorkbook.byteOffset, prefixedWorkbook.byteOffset + prefixedWorkbook.byteLength));
assert.deepEqual(prefixedParsed.rows, [{ q: "命名空间兼容题", ans: "A", a: ["正确项", "错误项"], type: "单选", tags: ["兼容"] }], "应兼容带 XML 命名空间前缀且包含数百个内部条目的工作簿");

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

const optionColumnLabel = (index: number): string => {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
};
const thirtyTwoOptionHeaders = Array.from({ length: IMPORT_LIMITS.xlsx.maxOptionsPerQuestion }, (_, index) => optionColumnLabel(index));
const thirtyTwoOptionQuestion = parseQuestionBankTable([
  ["题干", "题型", "标签", "解析", "答案1", ...thirtyTwoOptionHeaders],
  ["三十二项", "单选", "", "", "A", ...thirtyTwoOptionHeaders.map((label) => `选项${label}`)],
]);
assert.equal(thirtyTwoOptionQuestion[0].a.length, IMPORT_LIMITS.xlsx.maxOptionsPerQuestion, "最多 32 个选项且支持 AA、AG 列名");

const wrappedRows = [
  ["题干", "题型", "标签", "解析", "答案1", "A", "B"],
  ["保留真实\n换行", "单选", "", "", "A", "电\n流", "电压"],
];
const preservedWraps = parseQuestionBankTable(wrappedRows);
assert.equal(preservedWraps[0].q, "保留真实\n换行", "普通 Excel 导入必须保留作者换行");
assert.equal(preservedWraps[0].a[0], "电\n流", "普通 Excel 选项也必须保留作者换行");
const cleanedWraps = parseQuestionBankTable(wrappedRows, new Map(), { collapseVisualLineBreaks: true });
assert.equal(cleanedWraps[0].q, "保留真实换行", "原图提取版应清理题干视觉硬折行");
assert.equal(cleanedWraps[0].a[0], "电流", "原图提取版应清理选项视觉硬折行");
assert.equal(collapseExtractedVisualLineBreaks("a、b点间\n\n的电压"), "a、b点间的电压");
assert.equal(isVisualWrapExtractionSource("输电题库_最新模板_考点标签_原图提取版.xlsx"), true);
assert.equal(isVisualWrapExtractionSource("用户自建换行题库.xlsx"), false, "清理范围不得扩展到普通工作簿");

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

assert.equal(IMPORT_LIMITS.xlsx.maxBytes, 128 * 1024 * 1024);
assert.equal(IMPORT_LIMITS.xlsx.maxArchiveEntries, 16_384);
assert.equal(IMPORT_LIMITS.xlsx.maxEntryBytes, 32 * 1024 * 1024);
assert.equal(IMPORT_LIMITS.xlsx.maxTotalUncompressedBytes, 256 * 1024 * 1024);
assert.equal(IMPORT_LIMITS.xlsx.maxQuestions, 50_000);
assert.equal(IMPORT_LIMITS.xlsx.maxOptionsPerQuestion, 32);
assert.equal(IMPORT_LIMITS.xlsx.maxImagesPerQuestion, 32);
await assert.rejects(() => readQuestionWorkbook(buildStoredZip([
  { name: "xl/workbook.xml", data: new Uint8Array([1]) },
  { name: "xl/workbook.xml", data: new Uint8Array([2]) },
]).buffer.slice(0)), /重复路径/, "Excel 压缩包重复路径必须拒绝");

console.log("Excel 导入专项测试通过");
