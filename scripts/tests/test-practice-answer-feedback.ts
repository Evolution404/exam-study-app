import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const studyApp = read("src/app/shell/app-shell.tsx");
const syncRuntime = read("src/lib/sync/sync-runtime.ts");
const practiceView = read("src/app/shell/views/practice.tsx");
const dashboardView = read("src/app/shell/views/dashboard.tsx");
const practiceSetup = read("src/app/practice/practice-setup.tsx");
const practiceHistory = read("src/app/practice/practice-history.tsx");
const styles = read("src/app/styles/components.css");
const database = read("src/lib/db/db-v7.ts");
const practiceDatabase = read("src/lib/db/db-v7-practice.ts");

assert.match(practiceView, /className="option-status option-status-right"/, "correct status needs a dedicated overlay");
assert.match(practiceView, /className="option-status option-status-wrong"/, "wrong status needs a dedicated overlay");
assert.match(styles, /\.options button \{ position:relative;/, "option cards must anchor their status overlay");
assert.match(styles, /\.option-status \{ position:absolute;/, "answer icons must not participate in option text layout");
assert.match(styles, /padding:10px 50px 10px 15px/, "every option must reserve the same stable status gutter before and after submission");
assert.match(practiceView, /correct \? <p>正确答案：\{displayAnswer\}<\/p> : preferences\.showAnswerOnWrong/, "correct feedback must show only answer letters");
assert.match(practiceView, /正确答案：\{displayAnswer\}｜你的选择：\{selectedAnswer \|\| "不会"\}/, "wrong feedback must show the correct answer before the selected answer");
assert.doesNotMatch(practiceView, /你的选择[^\n]*<MathText/, "answer feedback must never duplicate full option text");
assert.doesNotMatch(practiceView, /\(correct \|\| preferences\.showAnswerOnWrong\) \? <p>正确答案/, "correct feedback must not reuse the verbose wrong-answer explanation");

assert.doesNotMatch(database, /db\.sessions|savePracticeSession|clearPracticeSession/, "practiceRun must be the only persisted progress source");
assert.doesNotMatch(practiceDatabase, /db\.sessions|savePracticeSession|clearPracticeSession/, "practiceRun must be the only persisted progress source");
assert.match(practiceView, /await recordPracticeAnswer\(/, "answer submission must use the single domain-event writer");
assert.doesNotMatch(practiceView, /await recordAttempt\(/, "the practice UI must not create a second attempt event");
assert.match(practiceDatabase, /export async function recordPracticeAnswerV7/, "answer submission must remain the single domain writer");
assert.doesNotMatch(practiceDatabase, /\.events\.put\(/, "answer submission must no longer touch the dormant events store");
assert.match(studyApp, /dbV7\.practiceRuns\.where\("status"\)\.equals\("in_progress"\)\.sortBy\("updatedAt"\)/, "home must query and sort the latest in-progress v7 practiceRun");
assert.match(studyApp, /const run = runId \? await dbV7\.practiceRuns\.get\(runId\) : latestPracticeRun/, "every continue entry must resume the same v7 practiceRun by id");
assert.match(studyApp, /if \(changed\.answers !== current\.answers\) void savePracticeProgress\(next\)/, "question navigation must remain transient and not outrank synced answers");
assert.match(dashboardView, /<span><b>\{answeredInRun\}<\/b> \/ \{latestPracticeRun\.questionIds\.length\} 已作答<\/span>/, "home must use the same answered/total metric as practice history");
assert.doesNotMatch(dashboardView, /停在第 \{savedSession\.currentIndex/, "home must not mix cursor position with answered count");
assert.ok(dashboardView.indexOf("{latestPracticeRun && <section className=\"resume-card\"") < dashboardView.indexOf("{banks.length ? <section className=\"home-bank-scope\""), "latest practice card must appear above bank selection");
assert.match(practiceHistory, /onAbandon: \(runId: string\) => void/, "latest practice banner needs an abandon action");
assert.match(practiceHistory, /className="latest-practice-abandon"/, "latest practice abandon action needs its compact button");
assert.doesNotMatch(practiceHistory, /inProgress \?\? latest/, "practice center must hide the latest banner when no run is in progress");
assert.match(styles, /\.resume-card-actions\{grid-column:3;grid-row:1;display:flex;align-items:center;gap:8px\}/, "home continue and abandon controls must share one ordered action row");
assert.match(styles, /grid-template-columns:minmax\(0,1fr\) 40px/, "mobile home action row must keep abandon immediately right of continue");
assert.match(styles, /\.resume-card small\{color:var\(--ink\)/, "resume card hierarchy must use readable primary text");
assert.match(styles, /\.resume-progress>i>b/, "resume card must render a dedicated progress bar");

assert.match(practiceSetup, /id: "randomCustom"/, "practice setup must expose a one-off custom random mode");
assert.match(practiceSetup, /aria-label="本次随机题数"/, "custom random mode must expose a numeric question-count input");
assert.match(practiceSetup, /amountChoice === "custom" \? requestedRandomCount/, "custom random count must be passed as this run's limit");
assert.match(practiceSetup, /不修改全局配置/, "custom random mode must remain independent from global preferences");
// 正交三段 + 卡片一键开始：卡片走纯预设（quick），组合路径唯一出口 assembleFilter。
assert.match(practiceSetup, /assembleFilter\(card\.combo, \{ quick: true \}\)/, "preset cards must start immediately with a pure combo");
assert.match(practiceSetup, /点卡片立即开始，不使用下方自定义组合/, "card row must explain that cards bypass the custom combo area");
assert.match(practiceSetup, /aria-expanded=\{advancedOpen\}/, "advanced filters must live behind a collapsed toggle");
assert.match(styles, /\.setup-bank \{ width:100%; max-width:none;/, "desktop practice bank selector must use the full setup-card width");
assert.match(styles, /\.scope-bank-list \{ display:grid; grid-template-columns:repeat\(auto-fit,minmax\(240px,1fr\)\);/, "multiple practice banks must flow into all available desktop columns");
assert.match(styles, /@media\(max-width:760px\)[^\n]*\.scope-bank-list\{grid-template-columns:1fr\}/, "mobile practice bank selector must remain one column");
// 日期区间必须挂在真实类名 .date-range 上（旧 .date-range-filter 是零引用死类）。
assert.match(practiceSetup, /className="date-range"/, "date range inputs must use the styled .date-range class");
assert.doesNotMatch(practiceSetup, /date-range-filter/, "the dead date-range-filter class must stay deleted");
// 错题卡实时计数与禁用：口径必须与开始练习一致（scoped + wrongRemovalStreak）。
assert.match(practiceSetup, /当前口径下 \$\{wrongCardCount\} 道错题/, "wrong card must preview the scoped wrong-question count");
assert.match(practiceSetup, /card\.id === "wrong" && wrongCardCount === 0/, "wrong card must disable itself when no wrong questions remain");
assert.match(practiceSetup, /where\("questionId"\)\.anyOf/, "card counts must load attempts via the questionId index instead of the whole table");
assert.match(studyApp, /wrongRemovalStreak=\{preferences\.wrongRemovalStreak\}/, "practice setup must receive the wrong-removal streak preference");
// 只练本次错题按钮：红色调走 danger token；夜间靠 token 自适应（普通按钮的夜间
// 覆盖必须 :not(.danger) 放行，不得新增页面级夜间规则）。
assert.match(practiceHistory, /<button className="danger"[\s\S]*?<XCircle size=\{16\} \/>只练本次错题<\/button>/, "只练本次错题按钮必须带 danger 类");
assert.match(styles, /\.result-actions \.danger\{border-color:var\(--color-danger\);color:var\(--color-danger\);background:var\(--color-danger-soft\)\}/, "只练本次错题按钮应整组走 danger token");
assert.match(styles, /html\[data-theme="dark"\] \.result-actions button:not\(\.danger\)\{border-color:#3a473f/, "夜间普通按钮覆盖必须放行 danger 按钮（不加夜间规则）");
assert.doesNotMatch(styles, /html\[data-theme="dark"\][^\n]*result-actions[^\n]*danger\{/, "danger 按钮不得依赖专属夜间规则（token 自适应）");
// 结果页题型分组折叠 + 题目总览入口：分组头是按钮、折叠箭头旋转、入口靠右，全 token。
assert.match(styles, /\.result-group-toggle\{[^}]*cursor:pointer\}/, "题型分组头必须可点击折叠");
assert.match(styles, /\.result-question-groups>section\.collapsed \.result-group-toggle>svg\{transform:rotate\(-90deg\)\}/, "折叠态分组箭头应旋转指示");
assert.match(styles, /\.result-filters \.result-overview-trigger\{margin-left:auto/, "题目总览入口应停在筛选行右端");

assert.match(studyApp, /syncRuntime\.scheduleAutomaticSync\(\{/, "automatic sync must be delegated to the runtime scheduler");
assert.match(syncRuntime, /void this\.sync\(\)\.catch\(\(error\) => options\.onError\?\.\(error\)\)/, "automatic runtime sync must remain silent by omitting the UI progress callback");
assert.doesNotMatch(syncRuntime, /setQuickSyncing|setQuickSyncProgress|setNotice/, "sync runtime must not own visible React feedback state");
// 用户显式点同步后刷新可见练习会话（对齐远端合并作答、跳到最后一题）是产品需求；
// 但后台定期拉取不得静默重建/跳题打扰答题，且无新作答时不得偏离当前题。
assert.match(studyApp, /result\.pulled \|\| result\.receivedSnapshot\) await refreshActivePracticeAfterSync/, "quick sync must refresh the visible practice session after a pull");
assert.doesNotMatch(studyApp, /pullResult/, "periodic pull must not replace the visible practice session");
assert.doesNotMatch(studyApp, /setPracticeSession\(activePracticeFromRun\(mergedRun/, "sync must not rebuild the visible practice session via a separate merged-run path");
assert.match(studyApp, /activePracticeFromRun\(run, session\.currentIndex\)/, "no new answers: keep the current question");
assert.match(studyApp, /activePracticeFromRun\(run, Math\.max\(0, lastAnsweredIndex\)\)/, "new answers: jump to the last answered question");
assert.match(styles, /translate3d\(100vw,0,0\)/, "slide navigation must animate the whole page from the viewport edge");
assert.match(styles, /\.practice-content \.practice-layout\{animation:question-page-forward/, "slide navigation must animate the whole practice layout");

// ===== 静态断言：个人难度 / 复习优先级 / 有效计时数据链 =====
const metrics = read("src/lib/practice/practice-metrics.ts");
assert.match(metrics, /export function difficultyFromOutcomes/, "难度 v2 纯函数必须存在且可单测");
assert.match(metrics, /outcome\.correct && validBaselineElapsed/, "速度基线只能吸收有效的正确作答");
assert.match(metrics, /export function calibrateDifficultyLearningRate/, "成熟本机历史应支持 Brier score 参数校准");
assert.match(metrics, /if \(latest === null\) return 50;/, "未作答复习优先级必须保持默认 50");
assert.match(metrics, /stats\.recentOutcomes\?\.length\s*\?\s*difficultyFromOutcomes\(stats\.recentOutcomes\)\s*:\s*calculateDifficulty/, "聚合读取必须有 outcomes 优先 + 终身错误率回退");
const derived = read("src/lib/sync/change-set-v7-derived.ts");
assert.match(derived, /recentOutcomes: ordered\.slice\(-32\)\.map\(\(attempt\) => \(\{ id: attempt\.id, createdAt: attempt\.createdAt, correct: attempt\.correct, elapsedMs:/, "同步派生链必须把作答时间写进 outcomes");
const checkpoint = read("src/lib/sync/sync-v7-checkpoint.ts");
assert.match(checkpoint, /outcome\.elapsedMs !== undefined\) assertSafeInt\(outcome\.elapsedMs/, "checkpoint 校验必须接受可选 elapsedMs（新旧互通）");
assert.match(practiceDatabase, /elapsedMs: Math\.max\(0, attempt\.elapsedMs \|\| 0\) \}/, "作答写入链必须记录每次的作答时间");
assert.match(studyApp, /rebuildAttemptStatsFromAttemptsV7\(\)/, "启动时必须执行一次性 attemptStats 重建（为旧数据补作答时间）");
assert.match(practiceView, /document\.hidden \|\| editing \|\| overviewOpen \|\| submitted/, "后台、编辑、题目总览和已提交状态必须暂停有效计时");
assert.match(practiceView, /activeTimer\.current\?\.reset\((?:window\.)?performance\.now\(\)/, "立即重答必须重置有效计时器");
assert.doesNotMatch(practiceView, /Date\.now\(\) - startedAt/, "作答耗时不得恢复为包含后台停留的墙钟时间");
assert.match(practiceView, /个人难度按有效作答时间与作答间隔动态估计/, "练习页个人难度 chip 应说明有效时间与间隔估计口径");
assert.match(studyApp, /right\?\.reviewPriority \?\? 50/, "复习优先排序必须使用独立优先级并保持未作答默认 50");

console.log("practice UI tests passed: stable feedback, one-event submissions, custom random runs, runtime-silent sync and one-source resume cards");
