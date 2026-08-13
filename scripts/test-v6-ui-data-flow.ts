import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isQuestionDoneInScope, normalizeProgressScope } from "../lib/progress-scope";
import { classifyNoticeTone } from "../lib/notice-tone";
import { resumeIndexAfterLastAnswer } from "../lib/practice-resume";

const scope = normalizeProgressScope(undefined);
assert.deepEqual(scope, { type: "rolling", days: 90 }, "默认进度口径必须是 rolling 90");

const now = new Date("2026-08-11T00:00:00.000Z");
const stats = [{ questionId: "old", total: 1, latestAttemptAt: "2026-01-01T00:00:00.000Z" }, { questionId: "new", total: 1, latestAttemptAt: "2026-08-10T00:00:00.000Z" }];
assert.equal(isQuestionDoneInScope("old", scope, stats, [], now), false, "rolling 90 应排除窗口外作答");
assert.equal(isQuestionDoneInScope("new", scope, stats, [], now), true, "rolling 90 应保留窗口内作答");
assert.equal(classifyNoticeTone("同步完成：上传 2 条"), "success", "同步成功提示应使用成功色");
assert.equal(classifyNoticeTone("invalid v6 checkpoint: missing run"), "error", "同步错误提示应使用错误色");
assert.equal(classifyNoticeTone("同步失败，请检查网络"), "error", "中文同步错误提示应使用错误色");

const sharedIds = ["q1", "q1", "q2", "q2", "q3"];
assert.deepEqual([...new Set(sharedIds)], ["q1", "q2", "q3"], "跨题库共享题按 questionId 去重");

const source = (name: string) => readFileSync(new URL(`../app/${name}`, import.meta.url), "utf8");
const editor = source("question-editor.tsx");
assert.match(editor, /同步修改全部题库/);
assert.match(editor, /分裂勾选题库/);
assert.match(editor, /splitQuestionV6/);
assert.match(editor, /membershipsReady/);
assert.match(editor, /membershipRequestRef\.current/);
assert.doesNotMatch(editor, /imageUrl/);
assert.match(editor, /putImageAssetV6/);
assert.match(editor, /个人解析/, "题目编辑器应提供个人解析编辑位置");
assert.match(editor, /onSave: \(changes: QuestionChanges, note\?: string\)/, "编辑器保存应回传个人解析");

const bank = source("bank-library-view.tsx");
assert.match(bank, /仅从当前题库移除/);
assert.match(bank, /全局删除题目及学习记录/);
assert.match(bank, /listUnfiledQuestionsV6/);
assert.match(bank, /progressScopeLabel/);
assert.match(bank, /范围表现（\$\{progressScopeLabel\}）/);
assert.match(bank, /setActivityRange\("custom"\)/);
assert.match(bank, /type="date"/);
// 试题管理：点题目卡片看详情（setViewing），铅笔才编辑；行内统计按区间口径。
assert.match(bank, /<button onClick=\{\(\) => setViewing\(question\)\}/, "题目卡片点击应打开详情而非直接编辑");
assert.match(bank, /作答 \{summary\.total\} 次（\{progressScopeLabel\}）/, "试题管理行内统计应标注区间口径");
assert.match(bank, /<QuestionDetail/, "试题管理应复用共享 QuestionDetail");

const detail = source("question-detail.tsx");
assert.match(detail, /export function QuestionDetail/, "题目详情应抽出为共享组件");
assert.match(detail, /作答（\{scopeLabel\}）/, "题目详情指标应按区间口径显示");
assert.doesNotMatch(detail, /终身/, "题目详情不应再硬编码终身口径");

const renderer = source("content-block-renderer.tsx");
assert.match(renderer, /retry=\{retryAsset/);

const componentStyles = readFileSync(new URL("../app/styles/components.css", import.meta.url), "utf8");
assert.match(componentStyles, /\.question-body h1,\.practice-stem\s*\{[^}]*clamp\(21px,3vw,29px\)/, "富内容题干必须继承原答题页的标准字号");
assert.match(componentStyles, /font-small[^}]*\.practice-stem[^}]*clamp\(18px,2\.4vw,24px\)/, "较小字号必须作用于富内容题干");
assert.match(componentStyles, /font-large[^}]*\.practice-stem[^}]*clamp\(25px,3\.4vw,33px\)/, "较大字号必须作用于富内容题干");
assert.match(componentStyles, /font-xlarge[^}]*\.practice-stem[^}]*clamp\(29px,4vw,38px\)/, "特大字号必须作用于富内容题干");
assert.match(componentStyles, /\.practice-option-content\{[^}]*font-size:15px/, "富内容选项必须恢复标准阅读字号");

const history = source("practice-history.tsx");
assert.match(history, /练习结果详情/);
assert.match(history, /重练本次题目/);
assert.match(history, /onRepeat\(ordered/);

// Continue-practice resume position: one past the furthest answered question,
// except when the final question is answered — then jump to the first
// unanswered question instead of re-showing the answered last one.
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

const study = source("study-app.tsx");
assert.match(study, /resumeIndexAfterLastAnswer/);
assert.match(study, /savePracticeProgressV6/);
assert.match(study, /recordPracticeAnswerV6/);
assert.equal((study.match(/recordPracticeAnswerV6\(/g) ?? []).length, 1, "答题持久化入口只应调用一次 v6 record API");
assert.match(study, /progressScope: \{ type: "rolling", days: 90 \}/);
assert.match(study, /buildScopedQuestionStats/);
assert.match(study, /label=\{`作答（\$\{scopeLabel\}）`\}/);

const search = source("search-view.tsx");
assert.match(search, /searchTriggered/, "搜索页应支持按条件触发搜索");
assert.match(search, /search-trigger-button/, "搜索页应有搜索按钮");
assert.match(search, /buildScopedQuestionStats/, "搜索页应按区间统计作答/难度");
assert.match(search, /作答 \{metric\.total\} 次 · 错误 \{metric\.wrong\} 次（\{scopeLabel\}）/, "搜索结果应标注区间口径");
assert.doesNotMatch(search, /if \(!normalized\) return/, "搜索页不应再因空关键词直接短路");
assert.match(search, /<SearchFilterDrawer/, "搜索页应使用桌面/手机共用的筛选抽屉");

const searchFilters = source("search-filter-drawer.tsx");
assert.match(searchFilters, /"current" \| "all" \| "custom"/, "搜索范围应包含已选、全部和指定题库三个并列模式");
assert.match(searchFilters, /role="checkbox"/, "指定题库应支持多选");
assert.match(searchFilters, /progressScopeOverride/, "学习状态应支持临时覆盖设置页统计范围");
assert.match(searchFilters, /previewCount/, "筛选应用按钮应显示真实结果数量");

const quick = source("quick-search.tsx");
assert.match(quick, /export function QuickSearch/, "顶部搜索框应抽成独立组件");
assert.match(quick, /useState\(""\)/, "QuickSearch 应在内部管理草稿状态而非 StudyApp 顶层 query");
assert.match(quick, /onOpenSearch\(draft\.trim\(\), questionId\)/, "QuickSearch 应在打开时提交草稿关键词");
assert.doesNotMatch(quick, /window\.scrollTo\(0, 0\)/, "QuickSearch 聚焦时不应再用定时 scrollTo 干扰光标");
assert.match(study, /<QuickSearch /, "StudyApp 应使用 QuickSearch 组件");
assert.doesNotMatch(study, /value=\{query\}/, "StudyApp 不应再直接受控渲染顶部搜索输入框");

console.log("v6 UI/data-flow assertions passed");
