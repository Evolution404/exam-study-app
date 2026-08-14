import assert from "node:assert/strict";
import { buildQuestionBankXlsx, questionExportJson, questionExportRows, sanitizeFileName, type ExportQuestionInput } from "../lib/question-bank-export";
import { parseQuestionBankWorkbook } from "../lib/xlsx-import";

const questions: ExportQuestionInput[] = [
  { id: "q1", type: "单选", stem: "单选题", options: ["选项一", "选项二", "选项三", "选项四"], answer: "B", tags: ["基础", "示例"] },
  { id: "q2", type: "多选", stem: "多选题", options: ["甲", "乙", "丙", "丁"], answer: "AC", tags: [] },
  { id: "q3", type: "判断", stem: "判断题", options: ["正确", "错误"], answer: "A", tags: ["判断"] },
  { id: "q4", type: "计算", stem: "计算题", options: [], answer: "12.5", tags: ["计算"] },
];
const notes = new Map<string, string>([
  ["q1", "单选题解析"],
  ["q3", "判断题解析"],
  ["q4", "计算题解析"],
]);

// 行构建：表头固定为 题干/题型/答案/标签/解析/选项A…
const rows = questionExportRows(questions, notes);
assert.deepEqual(rows[0], ["题干", "题型", "答案", "标签", "解析", "A", "B", "C", "D"]);
assert.deepEqual(rows[1], ["单选题", "单选", "B", "基础、示例", "单选题解析", "选项一", "选项二", "选项三", "选项四"]);
assert.deepEqual(rows[4], ["计算题", "计算", "12.5", "计算", "计算题解析", "", "", "", ""]);

// xlsx 往返：写出 → 读回 → 解析，逐项一致（含解析与计算题无选项）
const bytes = buildQuestionBankXlsx(questions, notes);
const buffer = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const parsed = await parseQuestionBankWorkbook(buffer);
assert.equal(parsed.length, 4);
assert.deepEqual(parsed[0], { q: "单选题", ans: "B", a: ["选项一", "选项二", "选项三", "选项四"], type: "单选", tags: ["基础", "示例"], note: "单选题解析" });
assert.deepEqual(parsed[1], { q: "多选题", ans: "AC", a: ["甲", "乙", "丙", "丁"], type: "多选", tags: [] });
assert.deepEqual(parsed[2], { q: "判断题", ans: "A", a: ["正确", "错误"], type: "判断", tags: ["判断"], note: "判断题解析" });
assert.deepEqual(parsed[3], { q: "计算题", ans: "12.5", a: [], type: "计算", tags: ["计算"], note: "计算题解析" });

// JSON 导出结构：无解析的题不带 note 字段
const json = JSON.parse(questionExportJson("测试题库", questions, notes));
assert.equal(json.name, "测试题库");
assert.equal(json.questions.length, 4);
assert.equal(json.questions[0].note, "单选题解析");
assert.equal(json.questions[0].stem, "单选题");
assert.equal(json.questions[1].note, undefined);
assert.equal(json.questions[3].answer, "12.5");

// 文件名清理
assert.equal(sanitizeFileName("送电线路工/技师:题库"), "送电线路工_技师_题库");
assert.equal(sanitizeFileName("   "), "题库");

// 全计算题题库也要能导出：至少保留 A、B 两个空选项列以满足导入
const calcOnly = questionExportRows([{ id: "c1", type: "计算", stem: "计算", options: [], answer: "1", tags: [] }], new Map());
assert.deepEqual(calcOnly[0], ["题干", "题型", "答案", "标签", "解析", "A", "B"]);

console.log("题库导出专项测试通过");
