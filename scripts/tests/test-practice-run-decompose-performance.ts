import assert from "node:assert/strict";
import { decomposePracticeRuns } from "../../src/lib/db/practice-run-store";
import type { Attempt, PracticeRun } from "../../src/lib/db/types";

const at = "2026-09-18T00:00:00.000Z";
const deviceId = "practice-run-decompose-perf";
const runCount = 64;
const questionsPerRun = 32;

const runs: PracticeRun[] = Array.from({ length: runCount }, (_, runIndex) => {
  const questionIds = Array.from({ length: questionsPerRun }, (_, questionIndex) => `q-${runIndex}-${questionIndex}`);
  return {
    id: `run-${runIndex}`,
    bankId: "bank-1",
    bankIds: ["bank-1"],
    bankName: "性能题库",
    mode: "sequential",
    modeLabel: "练习",
    questionIds,
    questionTypes: Object.fromEntries(questionIds.map((id) => [id, "单选"])),
    answers: {},
    shuffleOptions: false,
    optionOrders: {},
    startedAt: at,
    updatedAt: at,
    status: "completed",
    revision: 1,
    completedAt: at,
  };
});

const attempts: Attempt[] = runs.flatMap((run) => run.questionIds.map((questionId, questionIndex) => ({
  id: `attempt-${run.id}-${questionIndex}`,
  runId: run.id,
  questionId,
  selected: "A",
  correct: questionIndex % 3 !== 0,
  elapsedMs: 100,
  createdAt: new Date(Date.parse(at) + questionIndex).toISOString(),
  deviceId,
})));

let iteratorVisits = 0;
const trackedAttempts = new Proxy(attempts, {
  get(target, property, receiver) {
    if (property === Symbol.iterator) {
      return function* trackedIterator() {
        for (const attempt of target) {
          iteratorVisits += 1;
          yield attempt;
        }
      };
    }
    return Reflect.get(target, property, receiver);
  },
}) as Attempt[];

const bundles = decomposePracticeRuns(runs, trackedAttempts);

assert.equal(bundles.length, runCount);
assert.equal(
  bundles.reduce((sum, bundle) => sum + bundle.items.length, 0),
  runCount * questionsPerRun,
  "批量拆解必须保留全部 run item",
);
assert.ok(
  bundles.every((bundle) => bundle.items.every((item) => Boolean(item.submittedAttemptId))),
  "每个已作答 run item 都必须关联对应 attempt",
);
assert.ok(
  iteratorVisits <= attempts.length + runCount,
  `批量拆解必须近似单遍扫描 attempts，实际访问 ${iteratorVisits} / ${attempts.length}`,
);

console.log(`practice run decompose perf passed: ${runCount} runs, ${attempts.length} attempts, ${iteratorVisits} attempt visits`);
