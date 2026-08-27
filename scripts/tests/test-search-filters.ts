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
import {
  emptySearchFilterProjection,
  filterSearchIndex,
  type SearchIndexQuestion,
} from "../../src/lib/question/search-matching";
import { createSearchWorkerClient, type SearchWorkerLike } from "../../src/app/search/search-worker-client";
import type { SearchWorkerMessage } from "../../src/app/search/search-worker-protocol";
import type { BankV7 } from "../../src/lib/db/v7-types";
import { filterTagOptions, matchesTagSelection } from "../../src/lib/question/tag-filter";

const searchViewSource = fs.readFileSync(new URL("../../src/app/search/search-view.tsx", import.meta.url), "utf8");
const quickSearchSource = fs.readFileSync(new URL("../../src/app/search/quick-search.tsx", import.meta.url), "utf8");
const searchDrawerSource = fs.readFileSync(new URL("../../src/app/search/search-filter-drawer.tsx", import.meta.url), "utf8");
const appSelectSource = fs.readFileSync(new URL("../../src/app/ui/app-select.tsx", import.meta.url), "utf8");
const appStylesRoot = new URL("../../src/app/", import.meta.url);
const componentStyles = fs.readdirSync(appStylesRoot, { recursive: true })
  .filter((file) => file.endsWith(".css"))
  .sort()
  .map((file) => fs.readFileSync(new URL(file, appStylesRoot), "utf8"))
  .join("\n");
const knowledgeViewSource = fs.readFileSync(new URL("../../src/app/bank/knowledge-view.tsx", import.meta.url), "utf8");
const preferencesViewSource = [
  fs.readFileSync(new URL("../../src/app/shell/views/preferences-view.tsx", import.meta.url), "utf8"),
  fs.readFileSync(new URL("../../src/app/shell/views/sync-automation-setting.tsx", import.meta.url), "utf8"),
].join("\n");
const tagMultiSelectSource = fs.readFileSync(new URL("../../src/app/ui/tag-multi-select.tsx", import.meta.url), "utf8");
const practiceSetupSource = fs.readFileSync(new URL("../../src/app/practice/practice-setup.tsx", import.meta.url), "utf8");
const questionManagerSource = fs.readFileSync(new URL("../../src/app/bank/bank-library/question-manager.tsx", import.meta.url), "utf8");
const questionDetailSource = fs.readFileSync(new URL("../../src/app/bank/question-detail.tsx", import.meta.url), "utf8");
const practiceViewSource = fs.readFileSync(new URL("../../src/app/shell/views/practice.tsx", import.meta.url), "utf8");
const practicePresentationSource = fs.readFileSync(new URL("../../src/app/shell/views/practice-presentation.tsx", import.meta.url), "utf8");
const searchWorkerSource = fs.readFileSync(new URL("../../src/app/search/search-worker.ts", import.meta.url), "utf8");
const searchReadV7Source = fs.readFileSync(new URL("../../src/lib/db/search-read-v7.ts", import.meta.url), "utf8");

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
assert.deepEqual(defaults.tags, [], "标签筛选默认不限制标签");
assert.equal(defaults.tagMatch, "any", "多标签默认命中任意一个");
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
assert.equal(countActiveSearchFilters({ ...defaults, tags: ["安全", "线路"] }), 1, "多个标签属于同一个筛选类别");
assert.equal(matchesTagSelection(["安全", "线路"], ["安全", "杆塔"], "any"), true);
assert.equal(matchesTagSelection(["安全", "线路"], ["安全", "杆塔"], "all"), false);
assert.equal(matchesTagSelection(["安全", "线路"], [], "all"), true);
assert.deepEqual(filterTagOptions(["安全工器具", "线路巡视", "安全带"], "安全"), ["安全工器具", "安全带"]);

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
assert.match(preferencesViewSource, /v9 远端协议和热窗口增量同步/, "配置页必须描述当前 v9 同步机制");
assert.doesNotMatch(preferencesViewSource, /v[78] 远端协议|开启后使用 v7 事件/, "配置页不得残留旧 v7/v8 同步文案");
assert.match(searchViewSource, /搜索内容范围/, "搜索页应提供题干、选项、解析和全部范围");
assert.match(quickSearchSource, /快速搜索范围/, "顶栏快速搜索应提供内容范围选择");
assert.doesNotMatch(quickSearchSource, /<select\b/, "顶栏搜索范围不得退回操作系统原生下拉框");
assert.doesNotMatch(searchViewSource, /<select[^>]*className="search-content-scope"/, "搜索页范围不得退回操作系统原生下拉框");
assert.match(appSelectSource, /contentClassName\?: string/, "通用下拉框应允许场景化调整弹层尺寸而不重造原生控件");
assert.match(quickSearchSource, /<AppSelect[^>]*className="quick-search-scope"[^>]*contentClassName="search-scope-select-content quick-search-scope-content"/, "顶栏范围应复用项目通用下拉框样式");
assert.match(searchViewSource, /<AppSelect[^>]*className="search-content-scope"[^>]*contentClassName="search-scope-select-content"/, "搜索页范围应复用项目通用下拉框样式");
assert.match(searchDrawerSource, /search-match-group search-field-group[\s\S]*搜索字段[\s\S]*search-match-group search-mode-group[\s\S]*匹配方式/, "搜索字段与匹配方式必须分成有标题的独立分组");
assert.match(searchDrawerSource, /<TagMultiSelect[^>]*selected=\{filters\.tags\}/, "搜索筛选必须支持可搜索标签多选");
assert.match(practiceSetupSource, /<TagMultiSelect[^>]*selected=\{selectedTags\}/, "练习筛选必须支持可搜索标签多选");
assert.match(questionManagerSource, /<TagMultiSelect[^>]*selected=\{selectedTags\}/, "题库管理筛选必须支持可搜索标签多选");
assert.match(questionManagerSource, /options=\{\["全部", \.\.\.QUESTION_TYPE_ORDER\]\.map/, "题库管理题型筛选必须复用统一 QuestionType 顺序");
assert.match(componentStyles, /\.short-answer-card>label\{display:grid;gap:8px\}/, "简答题回答区必须使用自有布局，不得退回浏览器默认 label 流式布局");
assert.match(componentStyles, /\.short-answer-card textarea\{[^}]*width:100%[^}]*min-height:168px/, "简答题文本框必须占满回答区并具有稳定可用高度");
assert.match(componentStyles, /\.short-reference\{[^}]*background:var\(--color-primary-soft\)/, "简答参考答案必须使用独立的轻量参考卡片");
assert.match(componentStyles, /\.short-grade-actions\{[^}]*display:flex[^}]*flex-wrap:wrap/, "简答自评按钮必须有稳定布局而不是浏览器默认堆叠");
assert.match(practicePresentationSource, /questionType === "简答" \? <><strong>\{shortOutcome === "correct"/, "简答提交结果 presentation 必须走自评专用摘要");
assert.match(practiceViewSource, /const \[shortOutcome, setShortOutcome\] = useState<AttemptOutcome \| undefined>/, "Practice 必须继续持有简答自评状态");
assert.match(practicePresentationSource, /本题按自评记录，参考答案见上方。/, "简答结果框 presentation 不得重复整段参考答案");
assert.doesNotMatch(questionDetailSource, /<strong>正确答案：\{answerText\(question\)\}<\/strong>/, "题目详情不得把正确答案正文同时塞进标题和正文");
assert.match(questionDetailSource, /detailSolution\.kind !== "short" && <section className="search-answer-card"><strong>正确答案<\/strong><p><MathText text=\{answerText\(question\)\}/, "非简答题详情必须只用一个正确答案标题和一份正文");
assert.match(questionDetailSource, /detailSolution\.kind === "short" && <section className="search-answer-card"><strong>参考答案<\/strong><p>\{detailSolution\.referenceText\}<\/p>/, "简答题详情必须只保留一个参考答案卡片");
assert.equal((questionDetailSource.match(/answerText\(question\)/g) ?? []).length, 1, "题目详情标准答案正文只能渲染一次");
assert.match(tagMultiSelectSource, /placeholder="搜索标签"/, "标签多选组件必须提供标签搜索输入框");
assert.match(componentStyles, /\.search-mode-group\{[^}]*background:color-mix/, "匹配方式分组必须具有区别于搜索字段的视觉表面");
assert.match(componentStyles, /\.searchbox \.quick-search-scope\.app-select-trigger\{width:58px;gap:4px;padding-left:7px\}/, "手机顶栏搜索范围下拉框必须按两字标签收紧");
assert.match(componentStyles, /\.topbar:has\(\.searchbox input:focus\) \.quick-sync-split\{width:0;flex-basis:0;[^}]*border-width:0;[^}]*opacity:0;[^}]*pointer-events:none\}/, "手机快速搜索聚焦时必须让同步入口平滑退场并释放宽度");
assert.match(componentStyles, /prefers-reduced-motion:reduce\)\{\.topbar \.quick-sync-split\{transition:none\}/, "同步入口动画必须尊重减少动态效果偏好");

// Top quick-search caret stability contract: preserve the update timing from
// the original 2026-08-13 fix. Keystrokes may filter the preloaded in-memory
// bank synchronously, but must not schedule a delayed result-state update.
assert.match(quickSearchSource, /<input[^>]*value=\{draft\}/, "顶栏快速搜索应保持原修复版本的局部受控输入结构");
assert.match(quickSearchSource, /placeholder="快速搜索"/, "手机顶栏搜索提示必须保持简短");
assert.match(componentStyles, /\.searchbox input::placeholder\{font-size:13px\}/, "手机顶栏搜索提示字号必须小于实际输入字号");
assert.match(componentStyles, /\.quick-sync-split \.sync-pill\.quick-sync \.quick-sync-label\{display:none\}/, "手机同步按钮必须用足够优先级隐藏文字，只保留图标");
assert.doesNotMatch(quickSearchSource, /debouncedQuery|setDebouncedQuery/, "顶栏快速搜索不得为每次按键再安排延迟结果状态更新");
assert.doesNotMatch(quickSearchSource, /setTimeout\([^)]*setDebouncedQuery/, "顶栏快速搜索不得恢复 160ms 延迟过滤链路");
assert.match(quickSearchSource, /const normalizedQuery = query\.trim\(\);/, "顶栏搜索词应直接来自当前 draft，而不是延迟副本");
assert.match(quickSearchSource, /readNotesForQuestionIdsV7\(views\.map\(\(view\) => view\.question\.id\)\)/, "Quick Search 必须按当前题目 ID 定向读取 notes");
assert.doesNotMatch(quickSearchSource, /notes\.toArray\(\)/, "Quick Search 不得恢复 notes 全表扫描");
assert.match(searchReadV7Source, /dbV7\.notes\.bulkGet\(ids\)/, "search read layer 必须通过 notes 主键 bulkGet 定向读取");
assert.match(searchReadV7Source, /dbV7\.attemptStats\.bulkGet\(ids\)/, "Search View 必须通过 attemptStats 主键 bulkGet 定向读取");
assert.match(searchReadV7Source, /dbV7\.attempts\.where\("questionId"\)\.anyOf\(ids\)\.toArray\(\)/, "Search View 必须通过 attempts.questionId 索引定向读取");
assert.match(searchReadV7Source, /dbV7\.reviewRoundProgress\.where\("questionId"\)\.anyOf\(ids\)\.toArray\(\)/, "Search View 必须通过 reviewRoundProgress.questionId 索引定向读取");
assert.doesNotMatch(searchReadV7Source, /dbV7\.(?:notes|attemptStats)\.toArray\(\)/, "主键可定位的搜索数据不得退回全表扫描");
assert.doesNotMatch(searchViewSource, /dbV7\.(?:notes|attemptStats|attempts|reviewRoundProgress)\.toArray\(\)/, "Search View 不得直接全表扫描搜索历史数据");
assert.match(searchViewSource, /readAttemptStatsForQuestionIdsV7\(questionIds\)[\s\S]*readAttemptsForQuestionIdsV7\(questionIds\)[\s\S]*readNotesForQuestionIdsV7\(questionIds\)[\s\S]*readReviewRoundProgressForQuestionIdsV7\(questionIds\)/, "Search View 必须把同一当前题目集合传给全部 targeted readers");
assert.doesNotMatch(quickSearchSource, /enabled=\{open && Boolean\(draft\.trim\(\)\)\}/, "顶栏结果组件不得由输入状态启停数据生命周期");
assert.doesNotMatch(quickSearchSource, /\[bankKey,\s*enabled\]/, "顶栏搜索数据查询只能跟随题库范围");
assert.match(quickSearchSource, /if \(!bankIds\.length\) \{[\s\S]*?questions: \[\][\s\S]*?notes: new Map<string, string>\(\)[\s\S]*?\}[\s\S]*?\}, \[bankKey\]\);/, "顶栏搜索应预加载当前题库范围并只在题库范围变化时刷新订阅");
assert.match(searchViewSource, /buildSearchDerivedData\(\{/, "Search View 必须把 scope stats / note / index 派生交给纯 read-model 层");
assert.doesNotMatch(searchViewSource, /buildScopedQuestionStats|scopedLegacyByQuestion|statsNeedWrongReview/, "Search View 不得重新内联领域派生逻辑");
assert.match(searchViewSource, /useSearchWorkerClient/, "搜索页应通过 Worker 客户端执行大数组筛选");
assert.match(quickSearchSource, /useSearchWorkerClient/, "顶栏搜索应通过 Worker 客户端执行大数组筛选");
assert.match(searchWorkerSource, /type="module"|set-index|filterSearchIndex/, "搜索 Worker 必须使用纯索引协议");
assert.doesNotMatch(searchWorkerSource, /Blob|ArrayBuffer|canonical/, "搜索 Worker 不得接收完整图片或富内容对象");

const searchQuestion = (id: string, index: number): SearchIndexQuestion => ({
  id,
  type: index % 2 ? "多选" : "单选",
  stem: index % 2 ? `快关键词 ${index}` : `慢关键词 ${index}`,
  options: [`选项 ${index}`],
  tags: index % 3 ? ["安全"] : ["线路"],
  explanation: index % 5 ? "" : "个人解析",
  favorite: index % 11 === 0,
  difficulty: index % 101,
  total: index % 9,
  wrong: index % 4,
  latest: null,
  done: index % 7 === 0,
  needsWrongReview: index % 13 === 0,
});

const largeIndex = Array.from({ length: 50_000 }, (_, index) => searchQuestion(`q-${index}`, index));
const largeStartedAt = performance.now();
const largeResult = filterSearchIndex(largeIndex, {
  query: "快关键词",
  filters: emptySearchFilterProjection("stem"),
});
const largeElapsed = performance.now() - largeStartedAt;
assert.equal(largeResult.total, 25_000, "5 万题索引应保持完整匹配结果");
assert.ok(largeElapsed < 2_000, `5 万题纯筛选应在 2 秒内完成，实际 ${largeElapsed.toFixed(1)}ms`);

class DelayedWorker implements SearchWorkerLike {
  onmessage: ((event: MessageEvent<import("../../src/app/search/search-worker-protocol").SearchWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private index: SearchIndexQuestion[] = [];

  postMessage(message: SearchWorkerMessage) {
    if (message.kind === "set-index") {
      this.index = message.questions;
      return;
    }
    if (message.kind !== "search") return;
    const delay = message.request.query.includes("慢") ? 35 : 0;
    setTimeout(() => {
      const result = filterSearchIndex(this.index, message.request);
      this.onmessage?.({ data: { kind: "search-result", requestId: message.requestId, indexKey: message.indexKey, result } } as MessageEvent<import("../../src/app/search/search-worker-protocol").SearchWorkerResponse>);
    }, delay);
  }

  terminate() {}
}

const delayedClient = createSearchWorkerClient({ threshold: 0, workerFactory: () => new DelayedWorker() });
const slowSearch = delayedClient.search({ indexKey: "large", index: largeIndex, request: { query: "慢关键词", filters: emptySearchFilterProjection("stem") } });
const fastSearch = delayedClient.search({ indexKey: "large", index: largeIndex, request: { query: "快关键词", filters: emptySearchFilterProjection("stem") } });
const [slowResult, fastResult] = await Promise.all([slowSearch, fastSearch]);
assert.equal(slowResult, undefined, "新搜索请求应取消旧请求的结果承诺");
assert.equal(fastResult?.total, 25_000, "最新搜索结果应优先返回");
delayedClient.dispose();

const fallbackClient = createSearchWorkerClient({ threshold: 0, workerFactory: () => undefined });
const fallbackResult = await fallbackClient.search({ indexKey: "small", index: largeIndex.slice(0, 10), request: { query: "快关键词", filters: emptySearchFilterProjection("stem") } });
assert.equal(fallbackResult?.total, 5, "Worker 不可用时应可靠回退主线程纯函数");
fallbackClient.dispose();

console.log("search filter assertions passed: parallel bank scopes, immediate multi-select and quick-search caret timing");