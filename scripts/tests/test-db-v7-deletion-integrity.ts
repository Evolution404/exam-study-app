import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  completeReviewRoundV7,
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  createReviewRoundV7,
  dbV7,
  deleteBankV7,
  deleteBankWithExclusiveQuestionsV7,
  deleteQuestionV7,
  getReviewRoundV7,
  resetV7Database,
  setPracticeRunStatusV7,
} from "../../src/lib/db/db-v7";
import { createSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint-store";
import { ensureChangeSetQueueBaseV7 } from "../../src/lib/sync/change-set-v7-queue";

await resetV7Database();
await ensureChangeSetQueueBaseV7();

// D1：删题必须同步删除 completed/archived review round 的最终题目关系。
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
  const updatedRound = await getReviewRoundV7(round.id);
  assert.deepEqual(updatedRound?.finalQuestionIds ?? [], [], "删题后 completed round 不得保留悬空 reviewRoundItems");
  assert.equal(await dbV7.reviewRoundItems.where("roundId").equals(round.id).count(), 0);
  await createSyncCheckpointV7();
}

// D2：删题库只删除当前主数据；复习轮次的历史来源归属必须保留。
{
  const bankA = await createBankV7("D2题库A");
  const bankB = await createBankV7("D2题库B");
  const round = await createReviewRoundV7({ name: "D2轮次", bankIds: [bankA.id, bankB.id] });

  assert.equal(await deleteBankV7(bankA.id), true);
  const updatedRound = await getReviewRoundV7(round.id);
  assert.ok(updatedRound, "删题库不应删除复习轮次历史");
  assert.deepEqual(updatedRound?.bankIds, [bankA.id, bankB.id], "删题库后必须保留复习轮次创建时的历史来源归属");
  assert.equal(await dbV7.banks.get(bankA.id), undefined, "当前题库主数据必须已经删除");
  assert.deepEqual(
    (await dbV7.reviewRoundBanks.where("roundId").equals(round.id).sortBy("position")).map((row) => row.bankId),
    [bankA.id, bankB.id],
    "历史来源必须由 reviewRoundBanks 独立保存，不能依赖当前 banks 外键存活",
  );

  // 当前旧 checkpoint wire 仍把 reviewRoundBanks 当成强外键校验；Phase 5 会切换为
  // canonical-only 新 wire。这里隔离后续删除测试，不能为了旧 wire 反向抹掉历史事实。
  await resetV7Database();
  await ensureChangeSetQueueBaseV7();
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

// D4：删题后界面持有的旧 answers 快照不得在状态切换时把已删题答案写回 run。
{
  const bank = await createBankV7("D4状态切换");
  const q1 = await createQuestionV7(bank.id, {
    type: "判断",
    stem: "D4保留题",
    options: ["对", "错"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  const q2 = await createQuestionV7(bank.id, {
    type: "判断",
    stem: "D4删除题",
    options: ["对", "错"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q1.id, q2.id] });
  const answeredAt = "2026-09-17T03:30:00.000Z";
  const staleAnswers = {
    [q1.id]: { selected: ["A"], submitted: true as const, correct: true, updatedAt: answeredAt, deviceId: "device-d4", eventId: "event-d4-1" },
    [q2.id]: { selected: ["A"], submitted: true as const, correct: true, updatedAt: answeredAt, deviceId: "device-d4", eventId: "event-d4-2" },
  };

  assert.equal(await deleteQuestionV7(q2.id), true);
  const completed = await setPracticeRunStatusV7(run.id, "completed", staleAnswers);
  assert.ok(completed);
  assert.deepEqual(completed?.questionIds, [q1.id]);
  assert.deepEqual(Object.keys(completed?.answers ?? {}), [q1.id], "状态切换不得重新写回已移出 run 的题目答案");
}

await dbV7.close();
console.log("db-v7 deletion integrity tests passed: cascades remove live facts without erasing historical attribution");
