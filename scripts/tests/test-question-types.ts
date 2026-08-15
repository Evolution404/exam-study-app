import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isCalculationAnswerCorrect, normalizeCalculationAnswer } from "../../lib/question/question-utils";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const studyApp = read("app/study-app.tsx");
const history = read("app/practice/practice-history.tsx");
const editor = read("app/bank/question-editor.tsx");
const contentEditor = read("app/bank/content-block-editor.tsx");
const xlsx = read("lib/io/xlsx-import.ts");
const vite = read("vite.config.ts");

assert.equal(normalizeCalculationAnswer(" 12.50 "), "12.50");
assert.throws(() => normalizeCalculationAnswer("十二"), /有效数字/);
assert.equal(isCalculationAnswerCorrect("100.9", "100", 1), true);
assert.equal(isCalculationAnswerCorrect("101.1", "100", 1), false);
assert.equal(isCalculationAnswerCorrect("0.005", "0", 1), true);
assert.equal(isCalculationAnswerCorrect("0.02", "0", 1), false);
assert.match(editor, /questionTypes[^\n]*"计算"/, "question editor must expose calculation questions");
assert.match(editor, /optimizeImageFile/, "question editor must optimize selected local images");
assert.match(editor, /putImageAssetV6/, "question editor must store content-addressed image assets");
assert.match(contentEditor, /accept="image\/\*"/, "rich content editor must select a local image file");
assert.match(contentEditor, /insertImageAtSelection/, "rich content editor must insert images at the current text selection");
assert.doesNotMatch(editor, /题目图片地址|imageUrl/, "question editor must not accept public image URLs");
assert.match(xlsx, /"题干", "题型", "答案", "标签"/, "Excel parser must use the current text-only project columns");
assert.doesNotMatch(xlsx, /图片地址/, "Excel imports must not accept public image URLs");
assert.match(studyApp, /aria-label="计算题答案"/, "practice must render a numeric calculation answer input");
assert.match(studyApp, /calculationTolerancePercent/, "calculation grading must consume the configured tolerance");
assert.match(studyApp, /window\.setTimeout\(\(\) => void persistNoteDraft\(\), 650\)/, "notes must auto-save after a short debounce");
assert.match(studyApp, /if \(noteDirty\.current\) void saveNote\(question\.id, draftRef\.current\)/, "leaving a question must flush a dirty note");
assert.match(studyApp, /randomOptionOrder\(question, avoidOptionOrders\?\.\[question\.id\]\)/, "repeating a run must avoid its previous option order");
assert.match(history, /onClick=\{\(\) => setDetailQuestion\(question\)\}/, "completed result rows must open question details");
assert.doesNotMatch(history, /disabled=\{!canContinue\}/, "completed result rows must remain interactive");
assert.match(vite, /__APP_COMMIT_SHA__/, "build must inject its commit hash");
assert.match(vite, /__APP_COMMIT_TIME__/, "build must inject its commit timestamp");

console.log("question feature tests passed: images, calculation tolerance, result details, reshuffle, note autosave and build version");
