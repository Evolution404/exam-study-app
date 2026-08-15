import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV6, createQuestionV6, dbV6, resetV6Database } from "../../lib/db-v6";
import {
  listQuestionViewsForBanksV6,
  listUnfiledQuestionsV6,
  questionAnswerTextV6,
  questionPlainViewV6,
} from "../../lib/app-data-v6";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetV6Database();
const first = await createBankV6("第一题库");
const second = await createBankV6("第二题库");
const question = await createQuestionV6(first.id, {
  type: "单选",
  content: [{ id: "stem", type: "text", text: "电流是多少？" }],
  options: [[{ id: "a", type: "text", text: "1 A" }], [{ id: "b", type: "text", text: "2 A" }]],
  answer: "B",
  tags: ["电工"],
});
await dbV6.bankQuestionMemberships.put({
  key: `${second.id}:${question.id}`,
  bankId: second.id,
  questionId: question.id,
  sortOrder: 0,
  addedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deviceId: "test-device",
});

const views = await listQuestionViewsForBanksV6([first.id, second.id]);
assert.equal(views.length, 1, "共享题跨题库只能出现一次");
assert.equal(views[0].memberships.length, 2);
assert.deepEqual(views[0].banks.map((bank) => bank.id), [first.id, second.id]);
assert.deepEqual(questionPlainViewV6(question), {
  stem: "电流是多少？",
  options: ["1 A", "2 A"],
  searchText: "电流是多少？ 1 A 2 A 电工",
  summary: "电流是多少？",
});
assert.equal(questionAnswerTextV6(question), "2 A");
assert.deepEqual(await listUnfiledQuestionsV6(), []);

await dbV6.bankQuestionMemberships.clear();
assert.deepEqual((await listUnfiledQuestionsV6()).map((item) => item.id), [question.id]);
await dbV6.close();
console.log("v6 app data tests passed");
