import assert from "node:assert/strict";
import fs from "node:fs";
import {
  countActiveSearchFilters,
  createDefaultSearchFilters,
  effectiveSearchProgressScope,
  resolveSearchBankIds,
} from "../../src/app/search/search-filter-drawer";
import type { BankV7 } from "../../src/lib/db/v7-types";

const searchViewSource = fs.readFileSync(new URL("../../src/app/search/search-view.tsx", import.meta.url), "utf8");
const knowledgeViewSource = fs.readFileSync(new URL("../../src/app/bank/knowledge-view.tsx", import.meta.url), "utf8");
const preferencesViewSource = [
  fs.readFileSync(new URL("../../src/app/shell/views/preferences-view.tsx", import.meta.url), "utf8"),
  fs.readFileSync(new URL("../../src/app/shell/views/sync-automation-setting.tsx", import.meta.url), "utf8"),
].join("\n");

const banks = [
  { id: "a", name: "甲题库", displayName: "甲题库" },
  { id: "b", name: "乙题库", displayName: "乙题库" },
  { id: "c", name: "丙题库", displayName: "丙题库" },
] as BankV7[];

const defaults = createDefaultSearchFilters(["a", "b"]);
assert.equal(defaults.bankScope, "current", "有首页已选题库时默认使用已选题库");
assert.equal(defaults.keywordMode, "regex", "高级搜索默认使用正则表达式");
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
assert.match(searchViewSource, /aria-label="搜索" className="search-trigger-button"/, "手机图标搜索按钮必须保留可访问名称");
assert.match(searchViewSource, /aria-label=\{activeFilterCount \? `筛选，已设置 \$\{activeFilterCount\} 项` : "筛选"\}/, "手机图标筛选按钮必须说明已设置条件数");
assert.match(knowledgeViewSource, /aria-label="关闭标签详情"/, "标签详情关闭按钮不能成为无名称图标按钮");
assert.match(preferencesViewSource, /v8 远端协议和热窗口增量同步/, "配置页必须描述当前 v8 同步机制");
assert.doesNotMatch(preferencesViewSource, /开启后使用 v7 事件/, "配置页不得残留旧 v7 同步文案");

console.log("search filter assertions passed: parallel bank scopes, immediate multi-select and progress overrides");
