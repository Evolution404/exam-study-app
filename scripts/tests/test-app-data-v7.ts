import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import {
  listQuestionViewsForBanksV7,
  listUnfiledQuestionsV7,
  questionAnswerTextV7,
  questionPlainViewV7,
} from "../../src/lib/db/app-data-v7";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetV7Database();
const first = await createBankV7("第一题库");
const second = await createBankV7("第二题库");
const question = await createQuestionV7(first.id, {
  type: "单选",
  content: [{ id: "stem", type: "text", text: "电流是多少？" }],
  options: [[{ id: "a", type: "text", text: "1 A" }], [{ id: "b", type: "text", text: "2 A" }]],
  optionIds: ["a", "b"],
  solution: { kind: "choice", correctOptionIds: ["b"] },
  tags: ["电工"],
});
await dbV7.bankQuestionMemberships.put({
  key: `${second.id}:${question.id}`,
  bankId: second.id,
  questionId: question.id,
  sortOrder: 0,
  addedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deviceId: "test-device",
});

const views = await listQuestionViewsForBanksV7([first.id, second.id]);
assert.equal(views.length, 1, "共享题跨题库只能出现一次");
assert.equal(views[0].memberships.length, 2);
assert.deepEqual(views[0].banks.map((bank) => bank.id), [first.id, second.id]);
assert.deepEqual(questionPlainViewV7(question), {
  stem: "电流是多少？",
  options: ["1 A", "2 A"],
  searchText: "电流是多少？ 1 A 2 A 电工",
  summary: "电流是多少？",
});
assert.equal(questionAnswerTextV7(question), "2 A");
assert.deepEqual(await listUnfiledQuestionsV7(), []);

await dbV7.bankQuestionMemberships.clear();
assert.deepEqual((await listUnfiledQuestionsV7()).map((item) => item.id), [question.id]);
await dbV7.close();
console.log("v7 app data tests passed");
