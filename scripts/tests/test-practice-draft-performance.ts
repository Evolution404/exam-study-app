import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBank,
  createPracticeRun,
  createQuestion,
  resetDatabase,
  savePracticeDraft,
  studyDb,
} from "../../src/lib/db/db";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => "practice-draft-perf-device",
    setItem: () => undefined,
  },
});

await resetDatabase();
const bank = await createBank("草稿性能");
const questions = [];
for (let index = 0; index < 500; index += 1) {
  questions.push(await createQuestion(bank.id, {
    type: "简答",
    stem: `草稿题 ${index}`,
    options: [],
    solution: { kind: "short", referenceText: "参考答案" },
  }));
}
const run = await createPracticeRun({ bankId: bank.id, questionIds: questions.map((question) => question.id) });
const target = questions[237]!;

let itemReads = 0;
const readHook = <T>(row: T): T => {
  itemReads += 1;
  return row;
};
studyDb.practiceRunItems.hook("reading", readHook);
const beforeChanges = await studyDb.changeSets.count();

try {
  const saved = await savePracticeDraft(run.id, target.id, {
    selected: ["正在输入的简答草稿"],
    submitted: false,
  });
  assert.equal(saved, true);
} finally {
  studyDb.practiceRunItems.hook("reading").unsubscribe(readHook);
}

assert.ok(itemReads <= 2, `单题草稿保存不得扫描整个 run，实际 materialize ${itemReads} 条 item`);
assert.equal(await studyDb.changeSets.count(), beforeChanges, "未提交草稿不得生成同步 change set");

const stored = await studyDb.practiceDrafts.get([run.id, target.id]);
assert.deepEqual(stored?.selected, ["正在输入的简答草稿"]);
assert.equal(stored?.questionId, target.id);
assert.equal(
  (await studyDb.practiceDrafts.where("runId").equals(run.id).toArray()).length,
  1,
  "保存一题草稿不得改写其他题",
);
const canonicalItem = await studyDb.practiceRunItems.get([run.id, target.id]);
assert.equal("draftSelected" in (canonicalItem ?? {}), false, "canonical PracticeRunItem 不得携带草稿选择");
assert.equal("draftResponse" in (canonicalItem ?? {}), false, "canonical PracticeRunItem 不得携带草稿响应");

studyDb.close();
console.log(`practice draft perf passed: 500-item run, ${itemReads} item reads`);
