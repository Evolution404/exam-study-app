import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  completeReviewRoundV7,
  createBankV7,
  createQuestionV7,
  createReviewRoundV7,
  dbV7,
  deleteBankV7,
  deleteBankWithExclusiveQuestionsV7,
  deleteQuestionV7,
  resetV7Database,
} from "../../src/lib/db/db-v7";
import { createSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint-store";
import { ensureChangeSetQueueBaseV7 } from "../../src/lib/sync/change-set-v7-queue";

await resetV7Database();
await ensureChangeSetQueueBaseV7();

// D1：删题必须同步裁剪 completed/archived review round 的最终题目快照。
{
  const bank = await createBankV7("D1题目级联");
  const question = await createQuestionV7(bank.id, {
    type: "判断",
    stem: "D1待删除题",
    options: ["对", "错"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  const round = await createReviewRoundV7({ name: "D1已完成轮次", bankIds: [bank.id] });
  await completeReviewRoundV7(round.id, [question.id]);

  assert.equal(await deleteQuestionV7(question.id), true);
  const updatedRound = await dbV7.reviewRounds.get(round.id);
  assert.deepEqual(updatedRound?.finalQuestionIds, [], "删题后 completed round 不得保留悬空 finalQuestionIds");
  await createSyncCheckpointV7();
}

// D2：删题库必须同步裁剪所有 review round 的 bankIds，保留轮次历史本身。
{
  const bankA = await createBankV7("D2题库A");
  const bankB = await createBankV7("D2题库B");
  const round = await createReviewRoundV7({ name: "D2轮次", bankIds: [bankA.id, bankB.id] });

  assert.equal(await deleteBankV7(bankA.id), true);
  const updatedRound = await dbV7.reviewRounds.get(round.id);
  assert.ok(updatedRound, "删题库不应删除复习轮次历史");
  assert.deepEqual(updatedRound?.bankIds, [bankB.id], "删题库后 review round 不得保留悬空 bankId");
  await createSyncCheckpointV7();
}

// D3：删除题库+独占题目的判定和两段删除必须处于同一个写事务，禁止 membership 变化插入中间窗口。
{
  const bank = await createBankV7("D3独占删除");
  const question = await createQuestionV7(bank.id, {
    type: "判断",
    stem: "D3独占题",
    options: ["对", "错"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  const originalWhere = dbV7.bankQuestionMemberships.where.bind(dbV7.bankQuestionMemberships);
  let allClassificationReadsInWriteTransaction = true;
  dbV7.bankQuestionMemberships.where = ((index: string | string[]) => {
    if (index === "bankId" || index === "questionId") {
      allClassificationReadsInWriteTransaction &&= Dexie.currentTransaction?.mode === "readwrite";
    }
    return originalWhere(index as never);
  }) as typeof dbV7.bankQuestionMemberships.where;
  try {
    const result = await deleteBankWithExclusiveQuestionsV7(bank.id);
    assert.deepEqual(result, { bankDeleted: true, deletedQuestions: 1 });
  } finally {
    dbV7.bankQuestionMemberships.where = originalWhere as typeof dbV7.bankQuestionMemberships.where;
  }
  assert.equal(allClassificationReadsInWriteTransaction, true, "独占题判定必须发生在覆盖删库+删题的写事务内");
  assert.equal(await dbV7.questions.get(question.id), undefined);
  await createSyncCheckpointV7();
}

await dbV7.close();
console.log("db-v7 deletion integrity tests passed: cascades keep review-round references checkpoint-safe");
