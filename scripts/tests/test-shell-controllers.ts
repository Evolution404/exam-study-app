import assert from "node:assert/strict";
import type { ActivePractice } from "../../src/types/types";
import { formatQuickSyncNotice, mergeSearchHistory, removeDeletedQuestionFromSession, summarizeDashboardRows } from "../../src/app/shell/shell-controller-model";

const originalHistory = ["旧题", "弧垂", "安全距离", "绝缘子", "巡视", "杆塔", "导线", "电缆", "接地", "雷击"];
const promoted = mergeSearchHistory(originalHistory, "  弧垂  ");
assert.deepEqual(
  promoted,
  ["弧垂", "旧题", "安全距离", "绝缘子", "巡视", "杆塔", "导线", "电缆", "接地", "雷击"],
  "search history should trim, de-duplicate, promote the keyword, and remain capped at ten entries",
);
assert.deepEqual(originalHistory, ["旧题", "弧垂", "安全距离", "绝缘子", "巡视", "杆塔", "导线", "电缆", "接地", "雷击"], "history merge must not mutate its input");
assert.deepEqual(
  mergeSearchHistory(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"], "   "),
  ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
  "blank searches should preserve order while enforcing the history cap",
);

const lifetimeRows = [
  { total: 3, correct: 2, latestAttemptAt: "2026-08-25T10:00:00.000Z" },
  { total: 5, correct: 4, latestAttemptAt: "2026-08-26T01:00:00.000Z" },
  { total: 2, correct: 0 },
];
const todayRows = [
  { total: 2, correct: 1 },
  { total: 4, correct: 3 },
];
const lifetimeSnapshot = structuredClone(lifetimeRows);
const todaySnapshot = structuredClone(todayRows);
assert.deepEqual(
  summarizeDashboardRows(lifetimeRows, todayRows),
  {
    attempts: 10,
    correct: 6,
    todayAttempts: 6,
    todayCorrect: 4,
    last: "2026-08-26T01:00:00.000Z",
  },
  "dashboard aggregation should preserve lifetime/today scopes and select the newest attempt timestamp",
);
assert.deepEqual(lifetimeRows, lifetimeSnapshot, "dashboard aggregation must not reorder or mutate lifetime rows");
assert.deepEqual(todayRows, todaySnapshot, "dashboard aggregation must not mutate today rows");

const practice: ActivePractice = {
  id: "active",
  runId: "run-1",
  bankId: "bank-1",
  bankIds: ["bank-1"],
  bankName: "输电",
  mode: "sequential",
  modeLabel: "顺序练习",
  questionIds: ["q1", "q2", "q3"],
  questionTypes: { q1: "single", q2: "multiple", q3: "judge" },
  currentIndex: 2,
  lastAnsweredIndex: 2,
  answers: {
    q1: { selected: ["A"], submitted: true, correct: true },
    q2: { selected: ["A", "B"], submitted: false },
    q3: { selected: ["A"], submitted: true, correct: false },
  },
  shuffleOptions: false,
  optionOrders: {},
  startedAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:10:00.000Z",
  revision: 4,
};
const practiceSnapshot = structuredClone(practice);
const afterDelete = removeDeletedQuestionFromSession(practice, "q3");
assert.deepEqual(afterDelete.questionIds, ["q1", "q2"], "deleted questions must be removed from the in-memory run order");
assert.equal(afterDelete.currentIndex, 1, "current index must be clamped to the surviving question range");
assert.equal(afterDelete.lastAnsweredIndex, 0, "last answered index must be recomputed from surviving submitted answers");
assert.equal(afterDelete.answers.q3, undefined, "deleted-question answers must not survive in the session snapshot");
assert.equal(afterDelete.questionTypes?.q3, undefined, "deleted-question type metadata must be removed with the question");
assert.deepEqual(practice, practiceSnapshot, "deleted-question reconciliation must not mutate the stale session snapshot");
assert.strictEqual(removeDeletedQuestionFromSession(practice, "missing"), practice, "a non-member deletion must preserve object identity and avoid a phantom revision");

assert.equal(
  formatQuickSyncNotice({ pushed: 2, pulled: 3, compacted: false, remaining: 0 }),
  "同步完成：上传 2 组操作，接收 3 组操作",
  "ordinary quick sync notices must preserve pushed/pulled semantics",
);
assert.equal(
  formatQuickSyncNotice({
    pushed: 5,
    pulled: 0,
    compacted: true,
    remaining: 4,
    receivedSnapshot: { questions: 1234, totalAttempts: 5678 },
  }),
  "同步完成：上传 5 组操作，接收 1,234 道题、5,678 条作答，远程数据已压缩，待同步 4 组操作",
  "snapshot quick sync notices must preserve snapshot counts, compaction, and remaining queue state",
);

console.log("shell controller behavior tests passed");
