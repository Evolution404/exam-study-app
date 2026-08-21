import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createPracticeRunV7,
  dbV7,
  enqueueChangeSetV7,
  importQuestionBankV7,
  recordPracticeAnswerV7,
  resetV7Database,
} from "../../src/lib/db/db-v7";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    values: new Map<string, string>(),
    getItem(key: string) { return this.values.get(key) ?? null; },
    setItem(key: string, value: string) { this.values.set(key, value); },
    removeItem(key: string) { this.values.delete(key); },
  },
});

await resetV7Database();

const now = new Date().toISOString();
const unsafeBank = { id: "unsafe-bank", name: "unsafe", sortOrder: 0, questionCount: 0, importedAt: now, updatedAt: now, deviceId: "safari-test" };
await assert.rejects(
  () => dbV7.transaction("rw", [dbV7.banks, dbV7.changeSets], async () => {
    await dbV7.banks.put(unsafeBank);
    await enqueueChangeSetV7([{ kind: "bank.create", bank: unsafeBank }], now);
  }),
  /必须包含 syncMeta/,
  "业务事务漏掉 syncMeta 时应快速失败，禁止退回 Safari 的嵌套写事务死锁",
);

const bank = await importQuestionBankV7("safari.json", {
  name: "Safari 事务兼容",
  questions: [
    { q: "Safari Q1", a: ["甲", "乙"], ans: "A", type: "单选" },
    { q: "Safari Q2", a: ["甲", "乙"], ans: "B", type: "单选" },
  ],
});
assert.equal(bank.questionCount, 2, "Safari 模型下题库导入应完成");
const run = await createPracticeRunV7({ bankId: bank.id, bankIds: [bank.id] });
const result = await recordPracticeAnswerV7({ runId: run.id, questionId: run.questionIds[0]!, selected: ["A"], correct: true, elapsedMs: 1200 });
assert.equal(result.answer.submitted, true, "Safari 模型下作答应保存并允许继续下一题");
assert.equal((await dbV7.practiceRuns.get(run.id))?.answers[run.questionIds[0]!]?.submitted, true, "练习投影应包含已提交答案");

const records = await dbV7.changeSets.orderBy("localSequence").toArray();
assert.ok(records.length >= 3, "导入、创建练习和作答都应生成同步事件");
for (let index = 1; index < records.length; index += 1) assert.ok(records[index]!.localSequence > records[index - 1]!.localSequence, "事务内分配的同步序号应严格递增");

dbV7.close();
console.log("Safari IndexedDB compatibility tests passed: nested-write guard, import and answer workflow");
