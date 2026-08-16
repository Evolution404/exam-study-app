import assert from "node:assert/strict";
import {
  clampProgressScopeDays,
  PROGRESS_SCOPE_EXPLANATION,
  progressScopeChoiceKey,
  selectableProgressRounds,
} from "../../src/app/practice/progress-scope-setting";
import {
  activeReviewRounds,
  bankQuestionCount,
  roundSummaryMetrics,
} from "../../src/app/practice/review-round-manager";
import type { Bank } from "../../src/types/types";
import type { ReviewRound } from "../../src/lib/db/v7-types";

const bank = (id: string, questionCount: number): Pick<Bank, "id" | "questionCount"> => ({ id, questionCount });
const round = (id: string, status: ReviewRound["status"], bankIds: string[], finalQuestionIds?: string[]): ReviewRound => ({
  id,
  name: id,
  bankIds,
  startedAt: "2026-01-01T00:00:00.000Z",
  status,
  ...(finalQuestionIds ? { finalQuestionIds, completedAt: "2026-01-02T00:00:00.000Z" } : {}),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deviceId: "test-device",
});

assert.equal(clampProgressScopeDays(0), 1, "custom scope days clamp to the lower bound");
assert.equal(clampProgressScopeDays("36501"), 36_500, "custom scope days clamp to the upper bound");
assert.equal(clampProgressScopeDays("12.9"), 12, "custom scope days use whole days");
assert.equal(clampProgressScopeDays("not-a-number"), 90, "invalid custom scope days use a safe default");
assert.equal(progressScopeChoiceKey({ type: "rolling", days: 90 }), "rolling:90");
assert.equal(progressScopeChoiceKey({ type: "rolling", days: 91 }), "custom");
assert.match(PROGRESS_SCOPE_EXPLANATION, /首页和题库/, "scope copy explains where the selected range is applied");
assert.match(PROGRESS_SCOPE_EXPLANATION, /收藏、标签和个人解析不随时间变化/, "scope copy separates time-based statistics from asset properties");

const activeA = round("active-a", "active", ["bank-a"]);
const activeB = round("active-b", "active", ["bank-b"]);
const completed = round("completed", "completed", ["bank-a"], ["q-1", "q-2"]);
const archived = round("archived", "archived", ["bank-a"]);
assert.deepEqual(activeReviewRounds([activeA, activeB, completed, archived]).map((item) => item.id), ["active-a", "active-b"], "parallel active rounds remain selectable");
assert.deepEqual(selectableProgressRounds([activeA, activeB, completed, archived]).map((item) => item.id), ["active-a", "active-b", "completed"], "progress scope accepts active and completed rounds only");

const banks = [bank("bank-a", 3), bank("bank-b", 4)];
assert.equal(bankQuestionCount(["bank-a", "bank-b"], banks), 7, "fallback question count includes every selected bank");
assert.deepEqual(roundSummaryMetrics(activeA, banks), { questionCount: 3, completedCount: 0 });
assert.deepEqual(roundSummaryMetrics(activeB, banks, { "active-b": { questionCount: 4, completedCount: 2 } }), { questionCount: 4, completedCount: 2 }, "caller metrics drive dynamic counts");
assert.deepEqual(roundSummaryMetrics(completed, banks), { questionCount: 2, completedCount: 0 }, "completed rounds use their final snapshot when no dynamic metric is supplied");
assert.deepEqual(roundSummaryMetrics(completed, banks, { completed: { questionCount: 9, completedCount: 12 } }), { questionCount: 9, completedCount: 9 }, "metrics are bounded by the reported question count");

console.log("review scope UI tests passed: day clamping, active picker, parallel rounds, snapshots, metrics and copy boundary");
