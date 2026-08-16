import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const studyApp = read("src/app/shell/app-shell.tsx");
const practiceView = read("src/app/shell/views.tsx");
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
assert.match(practiceView, /<span><b>\{answeredInRun\}<\/b> \/ \{latestPracticeRun\.questionIds\.length\} 已作答<\/span>/, "home must use the same answered/total metric as practice history");
assert.doesNotMatch(practiceView, /停在第 \{savedSession\.currentIndex/, "home must not mix cursor position with answered count");
assert.ok(practiceView.indexOf("{latestPracticeRun && <section className=\"resume-card\"") < practiceView.indexOf("{banks.length ? <section className=\"home-bank-scope\""), "latest practice card must appear above bank selection");
assert.match(practiceHistory, /onAbandon: \(runId: string\) => void/, "latest practice banner needs an abandon action");
assert.match(practiceHistory, /className="latest-practice-abandon"/, "latest practice abandon action needs its compact button");
assert.doesNotMatch(practiceHistory, /inProgress \?\? latest/, "practice center must hide the latest banner when no run is in progress");
assert.match(styles, /\.resume-card-actions\{grid-column:3;grid-row:1;display:flex;align-items:center;gap:8px\}/, "home continue and abandon controls must share one ordered action row");
assert.match(styles, /grid-template-columns:minmax\(0,1fr\) 40px/, "mobile home action row must keep abandon immediately right of continue");
assert.match(styles, /\.resume-card small\{color:var\(--ink\)/, "resume card hierarchy must use readable primary text");
assert.match(styles, /\.resume-progress>i>b/, "resume card must render a dedicated progress bar");

assert.match(practiceSetup, /id: "randomCustom"/, "practice setup must expose a one-off custom random mode");
assert.match(practiceSetup, /aria-label="本次随机题数"/, "custom random mode must expose a numeric question-count input");
assert.match(practiceSetup, /mode === "randomCustom" \? requestedRandomCount/, "custom random count must be passed as this run's limit");
assert.match(practiceSetup, /不修改全局配置/, "custom random mode must remain independent from global preferences");

assert.match(studyApp, /quickSyncAction\.current\(\{ silent: true \}\)/, "automatic sync must use the silent path");
assert.doesNotMatch(studyApp, /setPracticeSession\(activePracticeFromRun\(mergedRun/, "sync must not rebuild the visible practice session");
assert.doesNotMatch(studyApp, /practiceSessionRef/, "periodic pull must not retain and replace the visible practice session");
assert.match(styles, /translate3d\(100vw,0,0\)/, "slide navigation must animate the whole page from the viewport edge");
assert.match(styles, /\.practice-content \.practice-layout\{animation:question-page-forward/, "slide navigation must animate the whole practice layout");

console.log("practice UI tests passed: stable feedback, one-event submissions, custom random runs, silent sync and one-source resume cards");
