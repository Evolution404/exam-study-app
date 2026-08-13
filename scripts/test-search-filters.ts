import assert from "node:assert/strict";
import {
  countActiveSearchFilters,
  createDefaultSearchFilters,
  effectiveSearchProgressScope,
  resolveSearchBankIds,
} from "../app/search-filter-drawer";
import type { BankV6 } from "../lib/v6-types";

const banks = [
  { id: "a", name: "甲题库", displayName: "甲题库" },
  { id: "b", name: "乙题库", displayName: "乙题库" },
  { id: "c", name: "丙题库", displayName: "丙题库" },
] as BankV6[];

const defaults = createDefaultSearchFilters(["a", "b"]);
assert.equal(defaults.bankScope, "current", "有首页已选题库时默认使用已选题库");
assert.equal(defaults.keywordMode, "plain", "高级搜索默认使用普通关键词");
assert.equal(defaults.progressScopeOverride, null, "统计范围默认跟随设置页");
assert.deepEqual(resolveSearchBankIds(defaults, banks, ["a", "b"]), ["a", "b"]);

const all = { ...defaults, bankScope: "all" as const };
assert.deepEqual(resolveSearchBankIds(all, banks, ["a"]), ["a", "b", "c"]);

const custom = { ...defaults, bankScope: "custom" as const, customBankIds: ["c", "a", "c", "missing"] };
assert.deepEqual(resolveSearchBankIds(custom, banks, ["b"]), ["c", "a"], "指定题库必须支持任意多选、去重并排除失效题库");

assert.deepEqual(effectiveSearchProgressScope(defaults, { type: "rolling", days: 180 }), { type: "rolling", days: 180 }, "默认统计范围应跟随设置页");
const manualScope = { ...defaults, progressScopeOverride: { type: "lifetime" as const } };
assert.deepEqual(effectiveSearchProgressScope(manualScope, { type: "rolling", days: 90 }), { type: "lifetime" }, "手动统计范围应只覆盖本次搜索");
assert.equal(countActiveSearchFilters(defaults), 0);
assert.equal(countActiveSearchFilters({ ...manualScope, bankScope: "custom", customBankIds: ["a", "b"], status: "unanswered" }), 3);

console.log("search filter assertions passed: parallel bank scopes, immediate multi-select and progress overrides");
