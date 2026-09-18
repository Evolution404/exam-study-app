import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBank,
  createPracticeRun,
  createQuestion,
  recordPracticeAnswer,
  resetDatabase,
  studyDb,
} from "../../src/lib/db/db";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => "practice-answer-write-perf-device",
    setItem: () => undefined,
  },
});

await resetDatabase();
const bank = await createBank("单题作答写入性能");
const questions = [];
for (let index = 0; index < 500; index += 1) {
  questions.push(await createQuestion(bank.id, {
    type: "单选",
    stem: `作答性能题 ${index}`,
    options: ["A", "B"],
    optionIds: ["a", "b"],
    solution: { kind: "choice", correctOptionIds: ["a"] },
  }));
}
const run = await createPracticeRun({ bankId: bank.id, questionIds: questions.map((question) => question.id) });
const target = questions[318]!;

let itemReads = 0;
const itemHook = () => {
  itemReads += 1;
};
studyDb.practiceRunItems.hook("reading", itemHook);
try {
  await recordPracticeAnswer({
    runId: run.id,
    questionId: target.id,
    selected: ["A"],
    correct: true,
    elapsedMs: 25,
  });
} finally {
  studyDb.practiceRunItems.hook("reading").unsubscribe(itemHook);
}

assert.ok(itemReads <= 2, `提交单题不得 hydrate 整个 500 题 run，实际 materialize ${itemReads} 条 item`);
assert.equal(await studyDb.attempts.where("runId").equals(run.id).count(), 1);
const record = await studyDb.practiceRuns.get(run.id);
assert.equal(record?.lastAnsweredIndex, 318);
assert.equal(record?.revision, 1);

studyDb.close();
console.log(`practice answer write perf passed: 500-item run, ${itemReads} item reads`);
