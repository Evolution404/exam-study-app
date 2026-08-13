import assert from "node:assert/strict";
import { questionOverviewFocusIndex, questionOverviewProgress } from "../lib/question-overview";

const ids = ["q1", "q2", "q3", "q4", "q5"];
const submitted = (indexes: number[]) => Object.fromEntries(indexes.map((index) => [ids[index], { submitted: true }]));

assert.equal(questionOverviewFocusIndex(ids, submitted([0])), 4, "最后一题未完成时应定位到最后一题");
assert.equal(questionOverviewFocusIndex(ids, submitted([0, 4])), 1, "最后一题完成后应定位到第一道未完成题");
assert.equal(questionOverviewFocusIndex(ids, submitted([0, 1, 2, 3, 4])), 4, "全部完成后应定位到最后一题");
assert.equal(questionOverviewFocusIndex([], {}), -1, "空练习不应产生定位目标");
assert.equal(questionOverviewProgress(1, 5), "20.0%", "进度应保留一位小数");
assert.equal(questionOverviewProgress(2, 3), "66.7%", "进度应四舍五入到一位小数");
assert.equal(questionOverviewProgress(0, 0), "0.0%", "空练习进度应为零");

console.log("question overview tests passed: progress precision and initial focus target");
