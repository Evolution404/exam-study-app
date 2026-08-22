import assert from "node:assert/strict";
import fs from "node:fs";
import {
  countActiveSearchFilters,
  createDefaultSearchFilters,
  effectiveSearchProgressScope,
  resolveSearchBankIds,
} from "../../src/app/search/search-filter-drawer";
import {
  createSearchMatcher,
  searchFieldsForQuestion,
} from "../../src/app/search/search-matching";
import type { BankV7 } from "../../src/lib/db/v7-types";

const searchViewSource = fs.readFileSync(new URL("../../src/app/search/search-view.tsx", import.meta.url), "utf8");
const quickSearchSource = fs.readFileSync(new URL("../../src/app/search/quick-search.tsx", import.meta.url), "utf8");
const searchDrawerSource = fs.readFileSync(new URL("../../src/app/search/search-filter-drawer.tsx", import.meta.url), "utf8");
const appSelectSource = fs.readFileSync(new URL("../../src/app/ui/app-select.tsx", import.meta.url), "utf8");
const componentStyles = fs.readFileSync(new URL("../../src/app/styles/components.css", import.meta.url), "utf8");
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
assert.equal(defaults.contentScope, "all", "搜索内容范围默认覆盖全部字段");
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

const question = { stem: "题干关键词", options: ["选项关键词", "另一个选项"], tags: ["标签关键词"] };
assert.equal(createSearchMatcher("题干关键词", "plain").matches(searchFieldsForQuestion(question, "解析关键词", "stem")), true, "题干范围应命中题干");
assert.equal(createSearchMatcher("选项关键词", "plain").matches(searchFieldsForQuestion(question, "解析关键词", "options")), true, "选项范围应命中选项");
assert.equal(createSearchMatcher("解析关键词", "plain").matches(searchFieldsForQuestion(question, "解析关键词", "explanation")), true, "解析范围应命中个人解析");
assert.equal(createSearchMatcher("选项关键词", "plain").matches(searchFieldsForQuestion(question, "解析关键词", "stem")), false, "题干范围不得命中选项");
assert.equal(createSearchMatcher("标签关键词", "plain").matches(searchFieldsForQuestion(question, "解析关键词", "all")), true, "全部范围应保留原有标签搜索能力");
assert.match(createSearchMatcher("(", "regex").error, /正则表达式/, "无效正则应返回可读错误");
assert.match(createSearchMatcher("(a+)+", "regex").error, /过于复杂/, "明显灾难性正则应被拒绝");
assert.match(createSearchMatcher("x".repeat(257), "plain").error, /不能超过/, "过长关键词应被限制");
assert.match(searchViewSource, /aria-label="搜索" className="search-trigger-button"/, "手机图标搜索按钮必须保留可访问名称");
assert.match(searchViewSource, /aria-label=\{activeFilterCount \? `筛选，已设置 \$\{activeFilterCount\} 项` : "筛选"\}/, "手机图标筛选按钮必须说明已设置条件数");
assert.match(knowledgeViewSource, /aria-label="关闭标签详情"/, "标签详情关闭按钮不能成为无名称图标按钮");
assert.match(preferencesViewSource, /v8 远端协议和热窗口增量同步/, "配置页必须描述当前 v8 同步机制");
assert.doesNotMatch(preferencesViewSource, /开启后使用 v7 事件/, "配置页不得残留旧 v7 同步文案");
assert.match(searchViewSource, /搜索内容范围/, "搜索页应提供题干、选项、解析和全部范围");
assert.match(quickSearchSource, /快速搜索范围/, "顶栏快速搜索应提供内容范围选择");
assert.doesNotMatch(quickSearchSource, /<select\b/, "顶栏搜索范围不得退回操作系统原生下拉框");
assert.doesNotMatch(searchViewSource, /<select[^>]*className="search-content-scope"/, "搜索页范围不得退回操作系统原生下拉框");
assert.match(appSelectSource, /contentClassName\?: string/, "通用下拉框应允许场景化调整弹层尺寸而不重造原生控件");
assert.match(quickSearchSource, /<AppSelect[^>]*className="quick-search-scope"[^>]*contentClassName="search-scope-select-content quick-search-scope-content"/, "顶栏范围应复用项目通用下拉框样式");
assert.match(searchViewSource, /<AppSelect[^>]*className="search-content-scope"[^>]*contentClassName="search-scope-select-content"/, "搜索页范围应复用项目通用下拉框样式");
assert.match(searchDrawerSource, /search-match-group search-field-group[\s\S]*搜索字段[\s\S]*search-match-group search-mode-group[\s\S]*匹配方式/, "搜索字段与匹配方式必须分成有标题的独立分组");
assert.match(componentStyles, /\.search-mode-group\{[^}]*background:color-mix/, "匹配方式分组必须具有区别于搜索字段的视觉表面");
assert.match(quickSearchSource, /enabled=\{open && Boolean\(draft\.trim\(\)\)\}/, "快速搜索结果仍应只在展开且有输入时显示");
assert.doesNotMatch(quickSearchSource, /if \(!enabled \|\| !bankIds\.length\)/, "顶栏搜索的 IndexedDB 订阅不得由输入状态启停，避免移动端输入光标跳动");
assert.doesNotMatch(quickSearchSource, /\[bankKey,\s*enabled\]/, "顶栏搜索数据查询只能跟随题库范围，输入状态不得重启订阅");
assert.match(quickSearchSource, /if \(!bankIds\.length\) \{[\s\S]*?questions: \[\][\s\S]*?notes: new Map<string, string>\(\)[\s\S]*?\}[\s\S]*?\}, \[bankKey\]\);/, "顶栏搜索应预加载当前题库范围并只在题库范围变化时刷新订阅");
assert.match(quickSearchSource, /ref=\{inputRef\}[\s\S]*defaultValue=""/, "顶栏快速搜索输入值应由 DOM 持有，避免 React 重渲染改写 iOS 光标位置");
assert.doesNotMatch(quickSearchSource, /<input[\s\S]{0,500}value=\{draft\}/, "顶栏快速搜索不得退回受控 value={draft} 输入");
assert.match(quickSearchSource, /onCompositionStart=\{\(\) => \{ composingRef\.current = true; \}\}/, "顶栏快速搜索必须识别中文输入法 composition 开始");
assert.match(quickSearchSource, /onCompositionEnd=\{\(event\) => \{[\s\S]*?composingRef\.current = false;[\s\S]*?setDraft\(event\.currentTarget\.value\)/, "composition 结束后才能把最终文本同步到搜索状态");
assert.match(quickSearchSource, /if \(composingRef\.current\) return;[\s\S]*?setDraft\(event\.currentTarget\.value\)/, "composition 期间不得用中间拼音状态驱动搜索结果重渲染");
assert.match(searchViewSource, /scopedLegacyByQuestion/, "错题筛选应使用当前进度范围统计");

console.log("search filter assertions passed: parallel bank scopes, immediate multi-select and progress overrides");
