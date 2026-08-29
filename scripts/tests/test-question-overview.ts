import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { questionOverviewProgress } from "../../src/lib/question/question-overview";

assert.equal(questionOverviewProgress(1, 5), "20.0%", "进度应保留一位小数");
assert.equal(questionOverviewProgress(2, 3), "66.7%", "进度应四舍五入到一位小数");
assert.equal(questionOverviewProgress(0, 0), "0.0%", "空练习进度应为零");

const practiceStyles = await readFile("src/app/practice/practice-main-2.css", "utf8");
const searchStyles = await readFile("src/app/search/search-main-1.css", "utf8");
assert.match(practiceStyles, /\.question-overview \.overview-score\{[^}]*padding:12px 24px[^}]*display:grid[^}]*grid-template-columns:repeat\(4,1fr\)[^}]*gap:8px/, "题目总览统计区必须保持四列卡片布局");
assert.match(practiceStyles, /\.overview-score span\{[^}]*min-height:54px[^}]*padding:9px[^}]*display:flex[^}]*flex-direction:column[^}]*justify-content:center/, "题目总览每项统计必须保持独立纵向卡片布局");
assert.match(practiceStyles, /\.overview-score strong\{[^}]*font:600 22px Georgia,serif/, "题目总览统计数字必须保持原有视觉层级");
assert.match(searchStyles, /\.search-detail-body \{ padding:25px 25px 18px; \}/, "题目详情正文必须保留桌面端左右内容间距");

console.log("question overview tests passed: progress precision, metric-card layout and detail gutter");