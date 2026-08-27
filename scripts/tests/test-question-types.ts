import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTION_TYPE_ORDER } from "../../src/types/types";
import { areCalculationAnswersCorrect, calculationBlankIndexes, fillAnswersAreCorrect, formatCalculationAnswers, isCalculationAnswerCorrect, normalizeCalculationAnswer, normalizeFillSolution, solutionFromInput, stableQuestionOptionIds, validateCalculationBlankLayout } from "../../src/lib/question/question-utils";
import { emptySearchFilterProjection, filterSearchIndex, searchIndexFingerprint, type SearchIndexQuestion } from "../../src/lib/question/search-matching";
import { buildSearchIndexQuestion } from "../../src/lib/question/search-read-model";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const practiceController = read("src/app/shell/use-practice-session-controller.ts");
const practiceView = read("src/app/shell/views/practice.tsx");
const practicePresentation = read("src/app/shell/views/practice-presentation.tsx");
const history = read("src/app/practice/practice-history.tsx");
const editor = read("src/app/bank/question-editor.tsx");
const contentEditor = read("src/app/bank/content-block-editor.tsx");
const xlsx = read("src/lib/io/xlsx-import.ts");
const vite = read("vite.config.ts");
const questionManager = read("src/app/bank/bank-library/question-manager.tsx");
const practiceSetup = read("src/app/practice/practice-setup.tsx");
const helpers = read("src/app/shell/helpers.ts");
const searchMatching = read("src/lib/question/search-matching.ts");
const searchView = read("src/app/search/search-view.tsx");
const quickSearch = read("src/app/search/quick-search.tsx");
const bankDetail = read("src/app/bank/bank-library/bank-detail.tsx");
const questionImport = read("src/lib/db/db-v7-question-import.ts");
const questionDraft = read("src/lib/db/db-v7-question-draft.ts");

assert.equal(normalizeCalculationAnswer(" 12.50 "), "12.50");
assert.equal(normalizeCalculationAnswer([" 11.0 ", "968.0"]), "11.0\n968.0");
assert.throws(() => normalizeCalculationAnswer("十二"), /有效数字/);
assert.deepEqual(calculationBlankIndexes("电流【空1】A，功率【空2】W"), [1, 2]);
assert.doesNotThrow(() => validateCalculationBlankLayout("电流【空1】A，功率【空2】W", "11\n968"));
assert.throws(() => validateCalculationBlankLayout("电流【空1】A", "11\n968"), /1 个填空.*2 个标准答案/);
assert.equal(formatCalculationAnswers("11\n968"), "第1空：11；第2空：968");
assert.equal(isCalculationAnswerCorrect("100.9", "100", 1), true);
assert.equal(isCalculationAnswerCorrect("101.1", "100", 1), false);
assert.equal(isCalculationAnswerCorrect("0.005", "0", 1), true);
assert.equal(isCalculationAnswerCorrect("0.02", "0", 1), false);
assert.equal(areCalculationAnswersCorrect(["11.05", "970"], "11\n968", 1), true);
assert.equal(areCalculationAnswersCorrect(["11.05", "980"], "11\n968", 1), false);
assert.equal(areCalculationAnswersCorrect(["11.05"], "11\n968", 1), false);
const fillSolution = normalizeFillSolution([["电流", "电流强度"], ["功率"]]);
assert.deepEqual(fillSolution.blanks.map((blank) => blank.acceptedAnswers), [["电流", "电流强度"], ["功率"]]);
assert.equal(fillAnswersAreCorrect([" 电流 ", "功率"], fillSolution), true);
assert.equal(fillAnswersAreCorrect(["电压", "功率"], fillSolution), false);
const choiceQuestion = {
  type: "单选" as const,
  options: [[{ type: "text" as const, text: "甲" }], [{ type: "text" as const, text: "乙" }]],
  optionIds: ["opt-0", "opt-1"],
  solution: { kind: "choice" as const, correctOptionIds: ["opt-1"] },
};
const choiceOptionIds = stableQuestionOptionIds(choiceQuestion);
assert.equal(choiceQuestion.solution.kind, "choice");
assert.deepEqual(choiceQuestion.solution.correctOptionIds, [choiceOptionIds[1]]);

const duplicateOptionBlocks = [
  [{ type: "text" as const, text: "完全相同" }],
  [{ type: "text" as const, text: "完全相同" }],
  [{ type: "text" as const, text: "完全相同" }],
  [{ type: "text" as const, text: "不同选项" }],
];
const duplicateOptionIds = stableQuestionOptionIds({ options: duplicateOptionBlocks });
assert.equal(new Set(duplicateOptionIds).size, duplicateOptionBlocks.length, "重复选项文本仍必须生成互不冲突的 optionId");
assert.equal(duplicateOptionIds[1], `${duplicateOptionIds[0]}-2`, "第二个相同选项使用稳定 occurrence 后缀");
assert.equal(duplicateOptionIds[2], `${duplicateOptionIds[0]}-3`, "第三个相同选项使用稳定 occurrence 后缀");
assert.deepEqual(stableQuestionOptionIds({ options: duplicateOptionBlocks }), duplicateOptionIds, "同一有序选项列表必须重复生成相同 optionIds");
assert.deepEqual(
  stableQuestionOptionIds({ options: duplicateOptionBlocks, optionIds: ["dup", "dup", "other", "last"] }),
  duplicateOptionIds,
  "冲突的既有 optionIds 不能绕过 canonical 生成器",
);
const duplicateChoiceSolution = solutionFromInput("单选", "B", duplicateOptionBlocks);
assert.deepEqual(
  duplicateChoiceSolution,
  { kind: "choice", correctOptionIds: [duplicateOptionIds[1]] },
  "答案 B 必须稳定指向第二个重复文本选项，而不是第一个",
);
assert.match(questionImport, /stableQuestionOptionIds\(\{ options: optionBlocks \}\)/, "JSON/Excel import fallback must allocate option ids through the canonical ordered helper");
assert.match(questionDraft, /stableQuestionOptionIds\(\{ options \}\)/, "question draft fallback must allocate option ids through the canonical ordered helper");
assert.doesNotMatch(questionImport, /optionBlocks\.map\(stableOptionIdForBlocks\)/, "import must not independently hash each option into a colliding id");
assert.doesNotMatch(questionDraft, /options\.map\([^\n]*stableOptionIdForBlocks/, "draft creation must not independently hash each option into a colliding id");

const shortAnswerSearchQuestion: SearchIndexQuestion = {
  id: "short-answer-search",
  type: "简答",
  stem: "说明提高输电线路耐雷水平的措施。",
  options: [],
  answer: "降低杆塔接地电阻，并提高线路耦合系数。",
  tags: ["防雷"],
  explanation: "",
  favorite: false,
  difficulty: 50,
  total: 0,
  wrong: 0,
  latest: null,
  done: false,
  needsWrongReview: false,
};
const shortAnswerAllResult = filterSearchIndex([shortAnswerSearchQuestion], {
  query: "降低杆塔接地电阻",
  filters: { ...emptySearchFilterProjection("all"), keywordMode: "plain" },
});
assert.deepEqual(shortAnswerAllResult.ids, [shortAnswerSearchQuestion.id], "全部范围必须能通过简答参考答案命中题目");
const shortAnswerStemResult = filterSearchIndex([shortAnswerSearchQuestion], {
  query: "降低杆塔接地电阻",
  filters: { ...emptySearchFilterProjection("stem"), keywordMode: "plain" },
});
assert.deepEqual(shortAnswerStemResult.ids, [], "简答参考答案不得泄漏进题干专用范围");
assert.notEqual(
  searchIndexFingerprint([shortAnswerSearchQuestion]),
  searchIndexFingerprint([{ ...shortAnswerSearchQuestion, answer: "提高绝缘水平。" }]),
  "修改简答参考答案必须让 Worker 索引 fingerprint 失效",
);
const canonicalSearchProjection = buildSearchIndexQuestion({
  id: "canonical-search",
  type: "简答",
  content: [{ id: "stem-0", type: "text", text: "canonical stem" }],
  options: [],
  solution: { kind: "short", referenceText: "canonical answer" },
  tags: ["tag-a"],
  favorite: true,
  contentFingerprint: "canonical-search-fingerprint",
  updatedAt: "2026-08-27T00:00:00.000Z",
  deviceId: "test-device",
}, { explanation: "personal note", difficulty: 73, total: 12, wrong: 3, latest: 42, done: true, needsWrongReview: true });
assert.deepEqual(canonicalSearchProjection, {
  id: "canonical-search",
  type: "简答",
  stem: "canonical stem",
  options: [],
  answer: "canonical answer",
  tags: ["tag-a"],
  explanation: "personal note",
  favorite: true,
  difficulty: 73,
  total: 12,
  wrong: 3,
  latest: 42,
  done: true,
  needsWrongReview: true,
}, "搜索 read-model builder 必须统一 canonical 字段并仅通过 context 注入运行时字段");
assert.match(searchView, /buildSearchIndexQuestion\(question\.canonical, \{/, "搜索主页必须复用 canonical search read-model builder");
assert.match(quickSearch, /buildSearchIndexQuestion\(question\.canonical, \{/, "顶栏快速搜索必须复用 canonical search read-model builder");
assert.doesNotMatch(searchView, /answer: question\.solution/, "搜索主页不得再自行投影 canonical answer");
assert.doesNotMatch(quickSearch, /answer: question\.solution/, "顶栏快速搜索不得再自行投影 canonical answer");

assert.deepEqual([...QUESTION_TYPE_ORDER], ["单选", "多选", "判断", "计算", "填空", "简答"], "all question type surfaces must share the canonical order");
assert.match(editor, /const questionTypes: QuestionTypeV7\[\] = \[\.\.\.QUESTION_TYPE_ORDER\]/, "question editor must use the canonical question type order");
assert.match(practiceSetup, /const questionTypes: QuestionTypeV7\[\] = \[\.\.\.QUESTION_TYPE_ORDER\]/, "practice setup must use the canonical question type order");
assert.match(helpers, /export const TYPE_ORDER: QuestionType\[\] = \[\.\.\.QUESTION_TYPE_ORDER\]/, "practice overview and balanced sampling must use the canonical order");
assert.match(history, /const TYPE_ORDER: QuestionTypeV7\[\] = \[\.\.\.QUESTION_TYPE_ORDER\]/, "practice history grouping must use the canonical order");
assert.match(searchMatching, /SEARCH_TYPE_ORDER: readonly SearchQuestionType\[\] = QUESTION_TYPE_ORDER/, "search tabs and result grouping must use the canonical order");
assert.match(questionManager, /options=\{\["全部", \.\.\.QUESTION_TYPE_ORDER\]\.map/, "question manager filter must put 全部 before the canonical type order");
assert.match(bankDetail, /QUESTION_TYPE_ORDER\.map\(\(type\) => <Distribution/, "bank type distribution must include every question type in canonical order");

const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
const literalTypeArray = /\[(?=[^\]]{0,320}"单选")(?=[^\]]{0,320}"多选")(?=[^\]]{0,320}"判断")(?=[^\]]{0,320}"计算")(?=[^\]]{0,320}"填空")(?=[^\]]{0,320}"简答")[^\]]{0,320}\]/gs;
const duplicateOrderFiles = readdirSync(srcRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .filter((file) => !file.endsWith(path.join("src", "types", "types.ts")) && literalTypeArray.test(readFileSync(file, "utf8")));
assert.deepEqual(duplicateOrderFiles, [], "full question-type lists must not duplicate or diverge from QUESTION_TYPE_ORDER");
assert.match(editor, /optimizeImageFile/, "question editor must optimize selected local images");
assert.match(editor, /putImageAssetV7/, "question editor must store content-addressed image assets");
assert.match(contentEditor, /accept="image\/\*"/, "rich content editor must select a local image file");
assert.match(contentEditor, /insertImageAtSelection/, "rich content editor must insert images at the current text selection");
assert.doesNotMatch(editor, /题目图片地址|imageUrl/, "question editor must not accept public image URLs");
assert.match(xlsx, /"题干", "题型", "标签", "解析"/, "Excel parser must use the redesigned base columns");
assert.match(xlsx, /ANSWER_HEADER_PATTERN/, "Excel parser must recognise positional 答案N columns");
assert.doesNotMatch(xlsx, /图片地址/, "Excel imports must not accept public image URLs");
assert.match(practiceView, /CalculationContentRenderer/, "practice must render positional calculation blank inputs");
assert.match(practiceView, /FillContentRenderer/, "practice must render positional fill blank inputs");
assert.match(practicePresentation, /short-grade-actions/, "practice presentation must expose self-grading actions for short answers");
assert.match(practiceView, /areCalculationAnswersCorrect/, "practice must grade every calculation blank");
assert.match(practiceView, /calculationTolerancePercent/, "calculation grading must consume the configured tolerance");
assert.doesNotMatch(practiceView, /依次填写题干中的/, "inline calculation blanks must not repeat guidance in a separate card");
assert.match(practiceView, /question\.type === "计算" \? \(!hasInlineCalculationBlanks && <div className=\{`calculation-answer manual-grid/, "calculations without inline blanks must render their dedicated answer card");
assert.match(practiceView, /window\.setTimeout\(\(\) => void persistNoteDraft\(\), 650\)/, "notes must auto-save after a short debounce");
assert.match(practiceView, /if \(noteDirty\.current\) void saveNote\(question\.id, draftRef\.current\)/, "leaving a question must flush a dirty note");
assert.match(practiceController, /randomOptionOrder\(question, avoidOptionOrders\?\.\[question\.id\]\)/, "repeating a run must avoid its previous option order");
assert.match(history, /setDetailQuestion\(question\)/, "completed result rows must open question details");
assert.doesNotMatch(history, /disabled=\{!canContinue\}/, "completed result rows must remain interactive");
assert.match(vite, /__APP_COMMIT_SHA__/, "build must inject its commit hash");
assert.match(vite, /__APP_COMMIT_TIME__/, "build must inject its commit timestamp");

console.log("question feature tests passed: duplicate option ids, images, calculation tolerance, result details, reshuffle, note autosave and build version");