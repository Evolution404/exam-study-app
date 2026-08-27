import assert from "node:assert/strict";
import fs from "node:fs";
import {
  assemblePracticeFilter,
  countAdvancedPracticeFilters,
  PRACTICE_QUESTION_TYPES,
  validatePracticeSetup,
  type PracticeSetupFormState,
} from "../../src/lib/practice/practice-setup-model";

const state = (overrides: Partial<PracticeSetupFormState> = {}): PracticeSetupFormState => ({
  bankIds: ["bank-a"],
  types: [...PRACTICE_QUESTION_TYPES],
  selectedTags: [],
  tagMatch: "any",
  status: "all",
  order: "sequential",
  amountChoice: "all",
  requestedRandomCount: 30,
  keyword: "",
  keywordMode: "plain",
  totalAttemptsMin: "",
  totalAttemptsMax: "",
  wrongAttemptsMin: "",
  wrongAttemptsMax: "",
  difficultyMin: "",
  difficultyMax: "",
  lastAttemptFrom: "",
  lastAttemptTo: "",
  reviewRoundId: "",
  effectiveScope: { type: "rolling", days: 90 },
  normalizedScope: { type: "rolling", days: 90 },
  scopeOverridden: false,
  ...overrides,
});

const quick = assemblePracticeFilter(state({
  types: ["简答"],
  selectedTags: ["不应泄漏"],
  keyword: "不应泄漏",
  totalAttemptsMin: "99",
  effectiveScope: { type: "lifetime" },
}), { combo: { status: "all", order: "random", amount: "default" }, quick: true, groupSize: 30 });
assert.equal(quick.mode, "random30");
assert.equal(quick.limit, 30);
assert.deepEqual(quick.types, PRACTICE_QUESTION_TYPES, "快捷预设必须恢复全题型");
assert.deepEqual(quick.tags, [], "快捷预设不得读取自定义标签");
assert.equal(quick.keyword, "", "快捷预设不得读取高级关键词");
assert.equal(quick.totalAttemptsMin, null, "快捷预设不得读取高级统计范围");
assert.deepEqual(quick.progressScope, { type: "rolling", days: 90 }, "快捷预设必须使用设置页 canonical scope");
assert.equal(quick.modeLabel, "随机 · 30 题");

const custom = assemblePracticeFilter(state({
  types: ["单选"],
  selectedTags: ["线路"],
  tagMatch: "all",
  status: "wrong",
  order: "difficulty",
  amountChoice: "custom",
  requestedRandomCount: 12,
  keyword: "弧垂",
  keywordMode: "regex",
  totalAttemptsMin: "2.9",
  wrongAttemptsMax: "5",
  difficultyMin: "10",
  difficultyMax: "80",
  lastAttemptFrom: "2026-01-01",
  lastAttemptTo: "2026-08-27",
  reviewRoundId: "round-a",
  effectiveScope: { type: "lifetime" },
  scopeOverridden: true,
}), { groupSize: 30 });
assert.equal(custom.mode, "advanced", "任一高级字段 active 时必须保持 advanced mode");
assert.equal(custom.limit, 12);
assert.equal(custom.totalAttemptsMin, 2, "统计输入仍按非负整数规范化");
assert.equal(custom.wrongAttemptsMax, 5);
assert.deepEqual(custom.progressScope, { type: "lifetime" });
assert.equal(custom.reviewRoundId, "round-a");
assert.equal(custom.modeLabel, "标签 1 个 · 错题 · 复习优先 · 12 题");
assert.equal(countAdvancedPracticeFilters(state({ keyword: "x", totalAttemptsMin: "1", scopeOverridden: true })), 3);

assert.equal(assemblePracticeFilter(state({ status: "wrong" }), { combo: { status: "wrong", order: "sequential", amount: "all" }, quick: true, groupSize: 30 }).mode, "wrong");
assert.equal(assemblePracticeFilter(state({ status: "favorite" }), { combo: { status: "favorite", order: "sequential", amount: "all" }, quick: true, groupSize: 30 }).mode, "favorite");
assert.equal(assemblePracticeFilter(state({ status: "unanswered" }), { groupSize: 30 }).mode, "advanced", "未做过筛选继续归入 advanced mode");

assert.equal(validatePracticeSetup(state(), 100).disabled, false);
assert.match(validatePracticeSetup(state({ keyword: "(", keywordMode: "regex" }), 100).regexError, /正则表达式/);
assert.match(validatePracticeSetup(state({ totalAttemptsMin: "5", totalAttemptsMax: "2" }), 100).metricError, /最少值不能大于最多值/);
assert.match(validatePracticeSetup(state({ difficultyMin: "101" }), 100).metricError, /0–100/);
assert.match(validatePracticeSetup(state({ lastAttemptFrom: "2026-08-27", lastAttemptTo: "2026-08-26" }), 100).dateError, /开始日期不能晚于结束日期/);
assert.match(validatePracticeSetup(state({ types: [] }), 100).typeError, /至少选择一种/);
assert.match(validatePracticeSetup(state({ amountChoice: "custom", requestedRandomCount: 101 }), 100).customRandomError, /1–100/);

const componentSource = fs.readFileSync(new URL("../../src/app/practice/practice-setup.tsx", import.meta.url), "utf8");
const readSource = fs.readFileSync(new URL("../../src/lib/db/practice-setup-read-v7.ts", import.meta.url), "utf8");
assert.match(componentSource, /readPracticeSetupDatasetV7\(bankIds\)/, "Practice Setup 必须使用独立 canonical read-model");
assert.doesNotMatch(componentSource, /dbV7|attemptStats\.toArray\(\)|reviewRoundProgress\.toArray\(\)/, "Practice Setup React owner 不得直接扫描 IndexedDB 历史表");
assert.match(readSource, /dbV7\.attemptStats\.bulkGet\(ids\)/, "Practice Setup attemptStats 必须按 questionId 主键定向读取");
assert.match(readSource, /dbV7\.reviewRoundProgress\.where\("questionId"\)\.anyOf\(ids\)\.toArray\(\)/, "Practice Setup round progress 必须按 questionId 索引定向读取");
assert.match(readSource, /dbV7\.attempts\.where\("questionId"\)\.anyOf\(ids\)\.toArray\(\)/, "Practice Setup attempts 必须按 questionId 索引定向读取");
assert.doesNotMatch(readSource, /dbV7\.(?:attemptStats|reviewRoundProgress|attempts)\.toArray\(\)/, "Practice Setup read-model 不得回退历史全表扫描");

console.log("practice setup model tests passed: canonical filter model, validation and targeted read ownership");
