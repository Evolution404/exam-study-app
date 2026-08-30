import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { addMembershipsV7, createBankV7, createQuestionV7, dbV7, resetV7Database, setQuestionMembershipsV7 } from "../../src/lib/db/db-v7";
import {
  listQuestionMembershipViewsV7,
  listQuestionViewsAvailableFromOtherBanksV7,
  listQuestionViewsForBankV7,
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
const third = await createBankV7("第三题库");
const question = await createQuestionV7(first.id, {
  type: "单选",
  content: [{ id: "stem", type: "text", text: "电流是多少？" }],
  options: [[{ id: "a", type: "text", text: "1 A" }], [{ id: "b", type: "text", text: "2 A" }]],
  optionIds: ["a", "b"],
  solution: { kind: "choice", correctOptionIds: ["b"] },
  tags: ["电工"],
});

assert.equal(await addMembershipsV7(second.id, [question.id]), 1, "应复用同一题目并加入第二题库");
assert.equal(await addMembershipsV7(second.id, [question.id]), 0, "重复加入不能制造重复 membership");
assert.equal((await dbV7.banks.get(first.id))?.questionCount, 1);
assert.equal((await dbV7.banks.get(second.id))?.questionCount, 1);

const views = await listQuestionViewsForBanksV7([first.id, second.id]);
assert.equal(views.length, 1, "共享题跨题库只能出现一次");
assert.equal(views[0].memberships.length, 2);
assert.deepEqual(views[0].banks.map((bank) => bank.id), [first.id, second.id]);

const firstBankViews = await listQuestionViewsForBankV7(first.id);
assert.equal(firstBankViews.length, 1);
assert.equal(firstBankViews[0].memberships.length, 2, "单题库管理页也必须读到完整所属题库关系");

const membershipViews = await listQuestionMembershipViewsV7([question.id]);
assert.deepEqual(membershipViews[0].banks.map((bank) => bank.id).sort(), [first.id, second.id].sort());

const reusableFromFirst = await listQuestionViewsAvailableFromOtherBanksV7(first.id);
assert.equal(reusableFromFirst.length, 1, "已在当前题库的共享题仍要可见，以便 UI 标记“当前已有”");
assert.equal(reusableFromFirst[0].memberships.some((membership) => membership.bankId === first.id), true);

assert.deepEqual(questionPlainViewV7(question), {
  stem: "电流是多少？",
  options: ["1 A", "2 A"],
  searchText: "电流是多少？ 1 A 2 A 电工",
  summary: "电流是多少？",
});
assert.equal(questionAnswerTextV7(question), "2 A");
assert.deepEqual(await listUnfiledQuestionsV7(), []);

assert.deepEqual(await setQuestionMembershipsV7(question.id, [second.id, third.id]), { added: 1, removed: 1 });
assert.equal((await dbV7.banks.get(first.id))?.questionCount, 0);
assert.equal((await dbV7.banks.get(second.id))?.questionCount, 1);
assert.equal((await dbV7.banks.get(third.id))?.questionCount, 1);
assert.deepEqual((await listQuestionMembershipViewsV7([question.id]))[0].banks.map((bank) => bank.id).sort(), [second.id, third.id].sort());

assert.deepEqual(await setQuestionMembershipsV7(question.id, []), { added: 0, removed: 2 });
assert.equal((await dbV7.banks.get(second.id))?.questionCount, 0);
assert.equal((await dbV7.banks.get(third.id))?.questionCount, 0);
assert.deepEqual((await listUnfiledQuestionsV7()).map((item) => item.id), [question.id]);

await dbV7.close();
console.log("v7 app data tests passed");
