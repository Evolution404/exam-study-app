import assert from "node:assert/strict";
import { questionOverviewProgress } from "../../src/lib/question/question-overview";

assert.equal(questionOverviewProgress(1, 5), "20.0%", "进度应保留一位小数");
assert.equal(questionOverviewProgress(2, 3), "66.7%", "进度应四舍五入到一位小数");
assert.equal(questionOverviewProgress(0, 0), "0.0%", "空练习进度应为零");

console.log("question overview tests passed: progress precision");
