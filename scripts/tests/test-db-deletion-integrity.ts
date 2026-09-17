import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  completeReviewRound,
  createBank,
  createPracticeRun,
  createQuestion,
  createReviewRound,
  studyDb,
  deleteBank,
  deleteBankWithExclusiveQuestions,
  deleteQuestion,
  getReviewRound,
  resetDatabase,
  setPracticeRunStatus,
} from "../../src/lib/db/db";
import { createSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-store";
import { ensureChangeSetQueueBase } from "../../src/lib/sync/change-set-queue";

await resetDatabase();
await ensureChangeSetQueueBase();

// D1：删题必须同步删除 completed/archived review round 的最终题目关系。
{
  const bank = await createBank("D1题目级联");
  const question = await createQuestion(bank.id, {
    type: "判断",
    stem: "D1待删除题",
    options: ["对", "错"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  const round = await createReviewRound({ name: "D1已完成轮次", bankIds: [bank.id] });
  await completeReviewRound(round.id, [question.id]);

  assert.equal(await deleteQuestion(question.id), true);
  const updatedRound = await getReviewRound(round.id);
  assert.deepEqual(updatedRound?.finalQuestionIds ?? [], [], "删题后 completed round 不得保留悬空 reviewRoundItems");
  assert.equal(await studyDb.reviewRoundItems.where("roundId").equals(round.id).count(), 0);
  await createSyncCheckpoint();
}

// D2：删题库只删除当前主数据；复习轮次的历史来源归属必须保留。
{
  const bankA = await createBank("D2题库A");
  const bankB = await createBank("D2题库B");
  const round = await createReviewRound({ name: "D2轮次", bankIds: [bankA.id, bankB.id] });

  assert.equal(await deleteBank(bankA.id), true);
  const updatedRound = await getReviewRound(round.id);
  assert.ok(updatedRound, "删题库不应删除复习轮次历史");
  assert.deepEqual(updatedRound?.bankIds, [bankA.id, bankB.id], "删题库后必须保留复习轮次创建时的历史来源归属");
  assert.equal(await studyDb.banks.get(bankA.id), undefined, "当前题库主数据必须已经删除");
  assert.deepEqual(
    (await studyDb.reviewRoundBanks.where("roundId").equals(round.id).sortBy("position")).map((row) => row.bankId),
    [bankA.id, bankB.id],
    "历史来源必须由 reviewRoundBanks 独立保存，不能依赖当前 banks 外键存活",
  );

  // 当前旧 checkpoint wire 仍把 reviewRoundBanks 当成强外键校验；Phase 5 会切换为
  // canonical-only 新 wire。这里隔离后续删除测试，不能为了旧 wire 反向抹掉历史事实。
  await resetDatabase();
  await ensureChangeSetQueueBase();
}

// D3：删除题库+独占题目的判定和两段删除必须处于同一个写事务，禁止 membership 变化插入中间窗口。
{
  const bank = await createBank("D3独占删除");
  const question = await createQuestion(bank.id, {
    type: "判断",
    stem: "D3独占题",
    options: ["对", "错"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  const originalWhere = studyDb.bankQuestionMemberships.where.bind(studyDb.bankQuestionMemberships);
  let allClassificationReadsInWriteTransaction = true;
  studyDb.bankQuestionMemberships.where = ((index: string | string[]) => {
    if (index === "bankId" || index === "questionId") {
      allClassificationReadsInWriteTransaction &&= Dexie.currentTransaction?.mode === "readwrite";
    }
    return originalWhere(index as never);
  }) as typeof studyDb.bankQuestionMemberships.where;
  try {
    const result = await deleteBankWithExclusiveQuestions(bank.id);
    assert.deepEqual(result, { bankDeleted: true, deletedQuestions: 1 });
  } finally {
    studyDb.bankQuestionMemberships.where = originalWhere as typeof studyDb.bankQuestionMemberships.where;
  }
  assert.equal(allClassificationReadsInWriteTransaction, true, "独占题判定必须发生在覆盖删库+删题的写事务内");
  assert.equal(await studyDb.questions.get(question.id), undefined);
  await createSyncCheckpoint();
}

// D4：删题后界面持有的旧 answers 快照不得在状态切换时把已删题答案写回 run。
{
  const bank = await createBank("D4状态切换");
  const q1 = await createQuestion(bank.id, {
    type: "判断",
    stem: "D4保留题",
    options: ["对", "错"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  const q2 = await createQuestion(bank.id, {
    type: "判断",
    stem: "D4删除题",
    options: ["对", "错"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  const run = await createPracticeRun({ bankId: bank.id, questionIds: [q1.id, q2.id] });
  const answeredAt = "2026-09-17T03:30:00.000Z";
  const staleAnswers = {
    [q1.id]: { selected: ["A"], submitted: true as const, correct: true, updatedAt: answeredAt, deviceId: "device-d4", eventId: "event-d4-1" },
    [q2.id]: { selected: ["A"], submitted: true as const, correct: true, updatedAt: answeredAt, deviceId: "device-d4", eventId: "event-d4-2" },
  };

  assert.equal(await deleteQuestion(q2.id), true);
  const completed = await setPracticeRunStatus(run.id, "completed", staleAnswers);
  assert.ok(completed);
  assert.deepEqual(completed?.questionIds, [q1.id]);
  assert.deepEqual(Object.keys(completed?.answers ?? {}), [q1.id], "状态切换不得重新写回已移出 run 的题目答案");
}

await studyDb.close();
console.log("db deletion integrity tests passed: cascades remove live facts without erasing historical attribution");
