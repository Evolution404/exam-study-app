import assert from "node:assert/strict";
import { buildQuestionBankXlsx, questionExportJson, questionExportRows, sanitizeFileName, type ExportQuestionInput } from "../../src/lib/question/question-bank-export";
import { parseQuestionBankWorkbook } from "../../src/lib/io/xlsx-import";

const questions: ExportQuestionInput[] = [
  { id: "q1", type: "单选", stem: "单选题", options: ["选项一", "选项二", "选项三", "选项四"], answer: "B", tags: ["基础", "示例"] },
  { id: "q2", type: "多选", stem: "多选题", options: ["甲", "乙", "丙", "丁"], answer: "AC", tags: [] },
  { id: "q3", type: "判断", stem: "判断题", options: ["正确", "错误"], answer: "A", tags: ["判断"] },
  { id: "q4", type: "计算", stem: "电流为【空1】A，功率为【空2】W", options: [], answer: "11\n968", tags: ["计算"] },
];
const notes = new Map<string, string>([
  ["q1", "单选题解析"],
  ["q3", "判断题解析"],
  ["q4", "计算题解析"],
]);

// 行构建：基础列后是连续的答案N列，再接选项A…
const rows = questionExportRows(questions, notes);
assert.deepEqual(rows[0], ["题干", "题型", "标签", "解析", "答案1", "答案2", "A", "B", "C", "D"]);
assert.deepEqual(rows[1], ["单选题", "单选", "基础、示例", "单选题解析", "B", "", "选项一", "选项二", "选项三", "选项四"]);
assert.deepEqual(rows[4], ["电流为【空1】A，功率为【空2】W", "计算", "计算", "计算题解析", "11", "968", "", "", "", ""]);

// xlsx 往返：写出 → 读回 → 解析，逐项一致（含解析与计算题无选项）
const bytes = buildQuestionBankXlsx(questions, notes);
const buffer = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const parsed = await parseQuestionBankWorkbook(buffer);
assert.equal(parsed.images.size, 0, "无图题库不应嵌入任何单元格图片");
assert.equal(parsed.rows.length, 4);
assert.deepEqual(parsed.rows[0], { q: "单选题", ans: "B", a: ["选项一", "选项二", "选项三", "选项四"], type: "单选", tags: ["基础", "示例"], note: "单选题解析" });
assert.deepEqual(parsed.rows[1], { q: "多选题", ans: "AC", a: ["甲", "乙", "丙", "丁"], type: "多选", tags: [] });
assert.deepEqual(parsed.rows[2], { q: "判断题", ans: "A", a: ["正确", "错误"], type: "判断", tags: ["判断"], note: "判断题解析" });
assert.deepEqual(parsed.rows[3], { q: "电流为【空1】A，功率为【空2】W", ans: "11\n968", a: [], type: "计算", tags: ["计算"], note: "计算题解析" });

const structuredQuestions: ExportQuestionInput[] = [
  { id: "q5", type: "填空", stem: "填空题【空1】、【空2】", options: [], answer: "", solution: { kind: "fill", blanks: [{ id: "blank-1", acceptedAnswers: ["电流", "电流强度"] }, { id: "blank-2", acceptedAnswers: ["功率"] }] }, tags: ["结构化"] },
  { id: "q6", type: "简答", stem: "简答题", options: [], answer: "", solution: { kind: "short", referenceText: "参考答案" }, tags: ["结构化"] },
];
const structuredRows = questionExportRows(structuredQuestions, new Map());
assert.deepEqual(structuredRows[1], ["填空题【空1】、【空2】", "填空", "结构化", "", "电流||电流强度", "功率", "", ""]);
assert.deepEqual(structuredRows[2], ["简答题", "简答", "结构化", "", "参考答案", "", "", ""]);
const structuredJson = JSON.parse(questionExportJson("结构化题库", structuredQuestions, new Map()));
assert.deepEqual(structuredJson.questions[0].answer, ["电流||电流强度", "功率"]);
assert.deepEqual(structuredJson.questions[0].solution, structuredQuestions[0].solution);
assert.equal(structuredJson.questions[1].answer, "参考答案");

// JSON 导出结构：无解析的题不带 note 字段
const json = JSON.parse(questionExportJson("测试题库", questions, notes));
assert.equal(json.name, "测试题库");
assert.equal(json.questions.length, 4);
assert.equal(json.questions[0].note, "单选题解析");
assert.equal(json.questions[0].stem, "单选题");
assert.equal(json.questions[1].note, undefined);
assert.deepEqual(json.questions[3].answer, ["11", "968"]);

// 文件名清理
assert.equal(sanitizeFileName("送电线路工/技师:题库"), "送电线路工_技师_题库");
assert.equal(sanitizeFileName("   "), "题库");

// 全计算题题库也要能导出：至少保留 A、B 两个空选项列以满足导入
const calcOnly = questionExportRows([{ id: "c1", type: "计算", stem: "计算结果为【空1】", options: [], answer: "1", tags: [] }], new Map());
assert.deepEqual(calcOnly[0], ["题干", "题型", "标签", "解析", "答案1", "A", "B"]);

console.log("题库导出专项测试通过");
