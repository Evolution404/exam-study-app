import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isQuestionDoneInScope, normalizeProgressScope } from "../../src/lib/practice/progress-scope";
import { classifyNoticeTone } from "../../src/lib/practice/notice-tone";
import { resumeIndexAfterLastAnswer } from "../../src/lib/practice/practice-resume";
import { isBankEnabled } from "../../src/lib/db/v7-types";

assert.equal(isBankEnabled({}), true, "旧题库缺少 enabled 字段时必须默认启用");
assert.equal(isBankEnabled({ enabled: true }), true);
assert.equal(isBankEnabled({ enabled: false }), false);

const scope = normalizeProgressScope(undefined);
assert.deepEqual(scope, { type: "rolling", days: 90 }, "默认进度口径必须是 rolling 90");

const now = new Date("2026-08-11T00:00:00.000Z");
const stats = [{ questionId: "old", total: 1, latestAttemptAt: "2026-01-01T00:00:00.000Z" }, { questionId: "new", total: 1, latestAttemptAt: "2026-08-10T00:00:00.000Z" }];
assert.equal(isQuestionDoneInScope("old", scope, stats, [], now), false, "rolling 90 应排除窗口外作答");
assert.equal(isQuestionDoneInScope("new", scope, stats, [], now), true, "rolling 90 应保留窗口内作答");
assert.equal(classifyNoticeTone("同步完成：上传 2 条"), "success", "同步成功提示应使用成功色");
assert.equal(classifyNoticeTone("invalid v7 checkpoint: missing run"), "error", "同步错误提示应使用错误色");
assert.equal(classifyNoticeTone("同步失败，请检查网络"), "error", "中文同步错误提示应使用错误色");

const sharedIds = ["q1", "q1", "q2", "q2", "q3"];
assert.deepEqual([...new Set(sharedIds)], ["q1", "q2", "q3"], "跨题库共享题按 questionId 去重");

const source = (name: string) => readFileSync(new URL(`../../src/app/${name}`, import.meta.url), "utf8");
const editor = source("bank/question-editor.tsx");
assert.match(editor, /同步修改全部题库/);
assert.match(editor, /分裂勾选题库/);
assert.match(editor, /splitQuestionV7/);
assert.match(editor, /membershipsReady/);
assert.match(editor, /membershipRequestRef\.current/);
assert.doesNotMatch(editor, /imageUrl/);
assert.match(editor, /putImageAssetV7/);
assert.match(editor, /个人解析/, "题目编辑器应提供个人解析编辑位置");
assert.match(editor, /onSave: \(changes: QuestionChanges, note\?: string\)/, "编辑器保存应回传个人解析");

const bank = [
  "bank/bank-library-view.tsx",
  "bank/bank-library/bank-detail.tsx",
  "bank/bank-library/question-manager.tsx",
  "bank/bank-library/unfiled-question-section.tsx",
  "bank/bank-library/bank-delete-dialog.tsx",
  "bank/bank-library/bank-question-delete-dialog.tsx",
  "bank/bank-library/bank-folder-section.tsx",
].map(source).join("\n");
assert.match(bank, /仅从当前题库移除/);
assert.match(bank, /全局删除题目及学习记录/);
assert.match(bank, /listUnfiledQuestionsV7/);
const questionManagerSource = source("bank/bank-library/question-manager.tsx");
assert.match(questionManagerSource, /导入题目/, "试题管理头部应提供往当前题库导入题目的入口");
assert.match(questionManagerSource, /onImportQuestions/, "试题管理应把导入入口上抛给题库详情");
const dbQuestion = readFileSync(new URL("../../src/lib/db/db-v7-question-import.ts", import.meta.url), "utf8");
assert.match(dbQuestion, /targetBankId/, "导入数据层必须支持指定目标题库");
assert.match(bank, /progressScopeLabel/);
assert.match(bank, /范围表现（\$\{progressScopeLabel\}）/);
assert.match(bank, /setActivityRange\("custom"\)/);
assert.match(bank, /type="date"/);
assert.match(bank, /deleteBankWithExclusiveQuestionsV7/, "删除题库应允许同步清理只属于该题库的题目");
assert.match(bank, /只删除题库，保留题目/, "删除题库应保留只删题库选项");
assert.match(bank, /删除题库和独占题目/, "删除题库应提供清理独占题目选项");
assert.match(bank, /removeMembershipsV7/, "试题管理应支持批量移出当前题库");
assert.match(bank, /deleteQuestionsV7/, "试题管理与未归档区应支持批量永久删除");
assert.match(bank, /选择当前筛选/, "试题管理应支持按当前筛选结果全选");
assert.match(bank, /批量删除/, "未归档题目应支持批量删除");
assert.match(bank, /setViewing\(question\)/, "题目卡片点击应打开详情而非直接编辑");
assert.match(bank, /作答 \{summary\.total\} 次（\{progressScopeLabel\}）/, "试题管理行内统计应标注区间口径");
assert.match(bank, /<QuestionDetail/, "试题管理应复用共享 QuestionDetail");
assert.match(bank, /@dnd-kit\/sortable/, "题库拖动必须使用成熟拖拽组件 dnd-kit");
assert.match(bank, /useSortable/, "题库拖动卡片必须通过 useSortable 接入 dnd-kit");

const detail = source("bank/question-detail.tsx");
assert.match(detail, /export function QuestionDetail/, "题目详情应抽出为共享组件");
assert.match(detail, /event\.key !== "Escape"/, "题目详情应支持 ESC 关闭");
assert.match(detail, /作答（\{scopeLabel\}）/, "题目详情指标应按区间口径显示");
assert.doesNotMatch(detail, /终身/, "题目详情不应再硬编码终身口径");

const renderer = source("bank/content-block-renderer.tsx");
assert.match(renderer, /retry=\{retryAsset/);

const appStylesRoot = new URL("../../src/app/", import.meta.url);
const splitStyleNames = readdirSync(appStylesRoot, { recursive: true }).filter((file) => file.endsWith(".css")).sort();
const componentStyles = splitStyleNames.map((file) => readFileSync(new URL(file, appStylesRoot), "utf8")).join("\n");
assert.match(componentStyles, /\.secondary\s*\{[^}]*min-height:42px[^}]*var\(--color-surface-raised\)/, "全局二级按钮应为 42px 令牌化表面样式");
const primaryRule = componentStyles.match(/\.primary\s*\{[^}]*min-height:\s*42px[^}]*\}/)?.[0] ?? "";
assert.match(primaryRule, /min-height:42px/, "全局主按钮统一 42px 高");
assert.match(primaryRule, /border-radius:10px/, "全局主按钮统一 10px 圆角");
assert.doesNotMatch(primaryRule, /box-shadow/, "全局主按钮不再叠加投影");
assert.match(componentStyles, /\.bank-management-grid article[^}]*transition/, "题库拖动卡片应保留移动过渡动画");
assert.match(componentStyles, /\.question-body h1,\.practice-stem\s*\{[^}]*clamp\(21px,3vw,29px\)/, "富内容题干必须继承原答题页的标准字号");
assert.match(componentStyles, /font-small[^}]*\.practice-stem[^}]*clamp\(18px,2\.4vw,24px\)/, "较小字号必须作用于富内容题干");
assert.match(componentStyles, /font-large[^}]*\.practice-stem[^}]*clamp\(25px,3\.4vw,33px\)/, "较大字号必须作用于富内容题干");
assert.match(componentStyles, /font-xlarge[^}]*\.practice-stem[^}]*clamp\(29px,4vw,38px\)/, "特大字号必须作用于富内容题干");
assert.match(componentStyles, /\.practice-option-content\{[^}]*font-size:15px/, "富内容选项必须恢复标准阅读字号");

const history = source("practice/practice-history.tsx");
assert.match(history, /<QuestionDetail/, "练习结果详情应复用共享 QuestionDetail");
assert.match(history, /data-question-id=/, "结果列表应带 question id 供详情跟随定位");
assert.match(history, /scrollIntoView\(/, "结果详情切换时应滚动到当前题目");
assert.match(history, /buildScopedQuestionStats/, "练习结果详情应按全局口径统计题目数据");
assert.match(history, /progressScope/, "练习结果详情应使用全局进度口径");
assert.match(history, /activeResultQuestionId/, "结果详情关闭后应保留当前题目高亮");
assert.match(history, /加入题组/, "练习结果详情应保留加入题组入口");
assert.match(history, /编辑题目/, "练习结果详情应保留编辑题目入口");
assert.match(history, /已收藏这道题/, "练习结果详情应支持收藏切换");
assert.doesNotMatch(history, /只练这一题/, "全项目不应再保留只练这一题入口");
assert.match(history, /重练本次题目/);
assert.match(history, /onRepeat\(ordered/);
assert.match(history, /runActivityAt\(b\)\.localeCompare\(runActivityAt\(a\)\)/, "练习记录必须按活动时间倒序");
assert.doesNotMatch(history, /orderBy\("startedAt"\)/, "练习记录不得再按开始时间排序");
assert.match(history, /formatTime\(runActivityAt\(run\)\)/, "记录卡片时间戳应与排序同口径（最后活动时间）");
assert.match(history, /<button className="danger"[\s\S]*?<XCircle size=\{16\} \/>只练本次错题<\/button>/, "只练本次错题按钮应带 danger 红色调");
assert.match(history, /import \{ QuestionOverview \} from "@\/app\/shell\/views\/question-overview"/, "结果页总览必须复用做题界面组件");
assert.match(history, /aria-label="打开题目总览"/, "结果页筛选行应有题目总览入口");
assert.match(history, /aria-expanded=\{!collapsed\}/, "题型分组头必须支持折叠并标注 aria-expanded");
assert.match(history, /className=\{collapsed \? "collapsed" : ""\}/, "折叠态需要稳定的 collapsed 类名");
assert.match(history, /onJump=\{\(target\) =>/, "总览点击题号应跳转打开对应题目详情");

const browserTest = readFileSync(new URL("./test-browser-visible.mjs", import.meta.url), "utf8");
assert.doesNotMatch(browserTest, /osascript|keepBrowserInBackground|frontmostAppName/, "浏览器测试不得切换系统窗口焦点");

const answered = (indexes: number[]) => {
  const answers: Record<string, { submitted: boolean }> = {};
  for (const index of indexes) answers[`q${index}`] = { submitted: true, selected: ["A"] };
  return answers as Parameters<typeof resumeIndexAfterLastAnswer>[1];
};
const resumeIds = ["q0", "q1", "q2", "q3", "q4"];
assert.equal(resumeIndexAfterLastAnswer(resumeIds, answered([0, 1])), 2, "顺序作答从最后一题之后继续");
assert.equal(resumeIndexAfterLastAnswer(resumeIds, answered([0, 2])), 3, "跳答时从最远已答之后继续");
assert.equal(resumeIndexAfterLastAnswer(resumeIds, answered([0, 1, 2, 3, 4])), 4, "全部答完回退到最后一题");
assert.equal(resumeIndexAfterLastAnswer(resumeIds, answered([0, 1, 3, 4])), 2, "最后一题已答时从第一道未做的开始");
assert.equal(resumeIndexAfterLastAnswer(resumeIds, answered([0, 4])), 1, "最后一题已答且中间有缺口时从第一道未做的开始");
assert.equal(resumeIndexAfterLastAnswer(resumeIds, {}), 0, "未作答从第一题开始");
assert.equal(resumeIndexAfterLastAnswer([], {}), 0, "空练习从 0 开始");

const study = source("shell/app-shell.tsx");
const dashboardController = source("shell/use-dashboard-data.ts");
const quickSyncController = source("shell/use-quick-sync-controller.ts");
assert.match(dashboardController, /const enabledBanks = banks\.filter\(isBankEnabled\)/, "Dashboard controller 必须集中定义学习可见题库");
assert.match(study, /BankLibraryView banks=\{banks\}/, "题库管理必须继续接收全部题库");
assert.match(study, /Dashboard[\s\S]*?banks=\{enabledBanks\}/, "首页只显示启用题库");
assert.match(study, /PracticeSetupView[\s\S]*?banks=\{enabledBanks\}/, "新练习只使用启用题库");
assert.match(study, /SearchView[\s\S]*?banks=\{enabledBanks\}/, "搜索只使用启用题库");
assert.match(dashboardController, /localStorage\.setItem\("study-current-banks", JSON\.stringify\(next\)\)/, "远端停用后必须由 Dashboard controller 清理本机幽灵选择");
assert.match(bank, /已启用 \{enabledCount\}/, "题库管理应提供启用筛选");
assert.match(bank, /已停用 \{disabledCount\}/, "题库管理应提供停用筛选");
assert.match(bank, /saveBank\(bank\.id, \{ enabled \}\)/, "启停必须走同步题库更新");
assert.match(study, /importTargetBankIdRef/, "app-shell 应以 ref 记住导入目标题库后复用全局文件输入");
const shellHelpers = source("shell/helpers.ts");
const dashboardView = source("shell/views/dashboard.tsx");
assert.match(shellHelpers, /resumeIndexAfterLastAnswer/);
assert.match(shellHelpers, /savePracticeProgressV7/);
assert.match(shellHelpers, /recordPracticeAnswerV7/);
assert.equal((shellHelpers.match(/recordPracticeAnswerV7\(/g) ?? []).length, 1, "答题持久化入口只应调用一次 v7 record API");
assert.match(shellHelpers, /progressScope: \{ type: "rolling", days: 90 \}/);
assert.match(dashboardController, /buildScopedQuestionStats/, "Dashboard controller 应集中计算首页区间统计");
assert.match(dashboardView, /label=\{`作答（\$\{scopeLabel\}）`\}/);
const topbar = source("shell/topbar.tsx");
assert.match(study, /pending=\{stats\.pending\}/, "AppShell 应把真实待同步数量传给顶部栏");
assert.match(topbar, /pending\.toLocaleString\("zh-CN"\)/, "右上角同步按钮应显示真实待同步数量");
const syncRuntimeSource = readFileSync(new URL("../../src/lib/sync/sync-runtime.ts", import.meta.url), "utf8");
const syncApplicationSource = readFileSync(new URL("../../src/lib/sync/sync-application.ts", import.meta.url), "utf8");
assert.match(quickSyncController, /syncRuntime\.scheduleAutomaticSync/, "Quick Sync controller 应把自动同步调度委托给 runtime");
assert.match(syncRuntimeSource, /requestIdleCallback/, "runtime 应等浏览器空闲帧再触发自动同步，不撞答题反馈动画");
assert.match(dashboardController, /syncApplication\.pendingCount\(\)/, "待同步计数应由 Dashboard controller 通过 application 轻量订阅，不与全表统计绑定");
assert.match(syncApplicationSource, /changeSets\.where\("state"\)\.anyOf\(\["pending", "blocked"\]\)\.count\(\)/, "application 内部保留索引化轻量待同步计数");
const syncOrchestrator = readFileSync(new URL("../../src/lib/sync/sync-v7-orchestrator.ts", import.meta.url), "utf8");
assert.match(syncOrchestrator, /yieldToMainIfVisible/, "本地归并应逐条让出主线程");
assert.match(syncOrchestrator, /applyChangeSetToOwnedProjectionV7/, "本地归并应走浅信封单次派生路径（不再每条全量克隆）");
assert.doesNotMatch(study, /Math\.min\(stats\.pending,\s*99\)/, "待同步数量不应截断为 99");
assert.match(quickSyncController, /syncApplication\.restoreCache[\s\S]*setTimeout\(resolve, 300\)/, "快捷恢复经 application boundary 完成后仍应由 Quick Sync controller 留出可见时间");

assert.match(componentStyles, /\.delete-choice-list>button span\{[^}]*font-size:14px/, "删除题库选项标题应保持可读字号");
assert.match(componentStyles, /\.delete-choice-list>button:not\(:disabled\):hover/, "删除题库选项应提供悬浮反馈");

const search = source("search/search-view.tsx");
const searchReadModel = readFileSync(new URL("../../src/lib/question/search-read-model.ts", import.meta.url), "utf8");
assert.match(search, /detail-current/, "搜索列表应为当前详情题目标记样式");
assert.match(search, /\(detailQuestionId \?\? activeQuestionId\) === question\.id/, "搜索列表应知道当前详情题目");
assert.match(search, /setActiveQuestionId\(detailQuestionId\)/, "搜索详情关闭后应保留当前题目高亮");
assert.match(search, /data-question-id=/, "搜索结果列表应带 question id 供详情跟随定位");
assert.match(search, /scrollIntoView\(/, "搜索详情切换时应滚动到当前题目");
assert.match(search, /searchTriggered/, "搜索页应支持按条件触发搜索");
assert.match(search, /search-trigger-button/, "搜索页应有搜索按钮");
assert.match(search, /buildSearchDerivedData/, "搜索页应把区间统计/read-model 派生委托给纯领域层");
assert.doesNotMatch(search, /buildScopedQuestionStats/, "搜索 React 视图不得重新内联区间统计派生");
assert.match(searchReadModel, /buildScopedQuestionStats/, "搜索 read-model 领域层应按区间统计作答/难度");
assert.match(search, /作答 \{metric\.total\} 次 · 错误 \{metric\.wrong\} 次（\{scopeLabel\}）/, "搜索结果应标注区间口径");
assert.doesNotMatch(search, /if \(!normalized\) return/, "搜索页不应再因空关键词直接短路");
assert.match(search, /<SearchFilterDrawer/, "搜索页应使用桌面/手机共用的筛选抽屉");

const searchFilters = source("search/search-filter-drawer.tsx");
assert.match(searchFilters, /"current" \| "all" \| "custom"/, "搜索范围应包含已选、全部和指定题库三个并列模式");
assert.match(searchFilters, /role="checkbox"/, "指定题库应支持多选");
assert.match(searchFilters, /progressScopeOverride/, "学习状态应支持临时覆盖设置页统计范围");
assert.doesNotMatch(searchFilters, /previewCount|查看 \{previewCount|search-filter-apply/, "筛选抽屉不应保留重复的底部应用操作");
assert.match(searchFilters, /event\.target === event\.currentTarget/, "点击筛选抽屉外的遮罩应关闭抽屉");

const group = source("bank/knowledge-view.tsx");
assert.match(group, /detail-current/, "题组编辑列表应为当前详情题目标记样式");
assert.match(group, /\(detailQuestionId \?\? activeQuestionId\) === question\.id/, "题组编辑列表应知道当前详情题目");
assert.match(group, /activeQuestionId/, "题组编辑详情关闭后应保留当前题目高亮");
assert.match(group, /group-question-open/, "题组编辑中的题目应可点击打开详情");
assert.match(group, /@dnd-kit\/sortable/, "题组拖动必须使用成熟拖拽组件 dnd-kit");
assert.match(group, /useSortable/, "题组题目必须通过 useSortable 接入 dnd-kit");
assert.match(group, /DndContext/, "题组列表必须使用 DndContext 管理拖拽");
assert.doesNotMatch(group, /ArrowUp|ArrowDown/, "题组编辑不应保留上下箭头排序按钮");
assert.match(group, /data-question-id=/, "题组列表应带 question id 供详情跟随定位");
assert.match(group, /scrollIntoView\(/, "题组详情切换时应滚动到当前题目");

assert.match(bank, /detail-current/, "题库管理列表应为当前详情题目标记样式");
assert.match(bank, /\(viewing\?\.id \?\? activeQuestionId\) === question\.id/, "题库管理列表应知道当前详情题目");
assert.match(bank, /activeQuestionId/, "题库管理详情关闭后应保留当前题目高亮");
assert.match(bank, /data-question-id=/, "题库管理列表应带 question id 供详情跟随定位");
assert.match(bank, /scrollIntoView\(/, "题库管理详情切换时应滚动到当前题目");

assert.match(componentStyles, /\.search-result-list article\.detail-current/, "搜索当前题目样式应存在");
assert.match(componentStyles, /\.managed-question-list article\.detail-current/, "题库管理当前题目样式应存在");
assert.match(componentStyles, /\.group-items article\.detail-current/, "题组编辑当前题目样式应存在");

const quick = source("search/quick-search.tsx");
assert.match(quick, /export function QuickSearch/, "顶部搜索框应抽成独立组件");
assert.match(quick, /useState\(""\)/, "QuickSearch 应在内部管理草稿状态而非 StudyApp 顶层 query");
assert.match(quick, /onOpenSearch\(draft\.trim\(\), questionId\)/, "QuickSearch 应在打开时提交草稿关键词");
assert.doesNotMatch(quick, /window\.scrollTo\(0, 0\)/, "QuickSearch 聚焦时不应再用定时 scrollTo 干扰光标");
assert.match(topbar, /<QuickSearch /, "顶部栏应使用 QuickSearch 组件");
assert.doesNotMatch(study, /<QuickSearch /, "AppShell 不应再直接承载顶部搜索输入框");
assert.doesNotMatch(study, /value=\{query\}/, "AppShell 不应再直接受控渲染顶部搜索输入框");

console.log("v7 UI/data-flow assertions passed");
