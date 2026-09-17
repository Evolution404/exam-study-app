import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  createReviewRoundV7,
  completeReviewRoundV7,
  dbV7,
  getPracticeRunV7,
  getReviewRoundV7,
  resetV7Database,
  savePracticeRunV7,
  updateReviewRoundV7,
} from "../../src/lib/db/db-v7";
import { ensureChangeSetQueueBaseV7 } from "../../src/lib/sync/change-set-v7-queue";

await resetV7Database();
await ensureChangeSetQueueBaseV7();

type TxSnapshot = { active: boolean; mode: string; storeNames: string[] };
const txSnapshot = (): TxSnapshot | undefined => {
  const tx = Dexie.currentTransaction;
  return tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
};

// C1：创建练习必须在写事务内确认题库和题目仍存在，避免并发删除留下悬空 run。
{
  const bank = await createBankV7("C1练习创建完整性");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "C1题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalBanksBulkGet = dbV7.banks.bulkGet.bind(dbV7.banks);
  const originalQuestionsBulkGet = dbV7.questions.bulkGet.bind(dbV7.questions);
  let bankRead: TxSnapshot | undefined;
  let questionRead: TxSnapshot | undefined;
  dbV7.banks.bulkGet = (async (keys) => {
    if (keys.includes(bank.id)) bankRead = txSnapshot();
    return originalBanksBulkGet(keys);
  }) as typeof dbV7.banks.bulkGet;
  dbV7.questions.bulkGet = (async (keys) => {
    if (keys.includes(question.id)) questionRead = txSnapshot();
    return originalQuestionsBulkGet(keys);
  }) as typeof dbV7.questions.bulkGet;
  try {
    await createPracticeRunV7({ bankIds: [bank.id], questionIds: [question.id] });
  } finally {
    dbV7.banks.bulkGet = originalBanksBulkGet as typeof dbV7.banks.bulkGet;
    dbV7.questions.bulkGet = originalQuestionsBulkGet as typeof dbV7.questions.bulkGet;
  }
  for (const snapshot of [bankRead, questionRead]) {
    assert.equal(snapshot?.active, true);
    assert.equal(snapshot?.mode, "readwrite");
    for (const store of [
      "banks",
      "bankQuestionMemberships",
      "questions",
      "reviewRounds",
      "practiceRuns",
      "practiceRunSources",
      "practiceRunItems",
      "bankPracticeStats",
      "changeSets",
      "syncMeta",
    ]) {
      assert.ok(snapshot?.storeNames.includes(store), `createPracticeRunV7 事务必须包含 ${store}`);
    }
  }
  const before = await dbV7.practiceRuns.count();
  await assert.rejects(
    () => createPracticeRunV7({ bankIds: [bank.id], questionIds: ["question_missing_c1"] }),
    /题目不存在|已被删除/,
  );
  assert.equal(await dbV7.practiceRuns.count(), before, "缺失题目时不得写入半成品 run");
  await assert.rejects(
    () => createPracticeRunV7({ bankIds: ["bank_missing_c1"], questionIds: [question.id] }),
    /题库不存在|已被删除/,
  );
}

// C2：绑定复习轮次的新练习必须引用仍存在且 active 的 round。
{
  const bank = await createBankV7("C2轮次练习完整性");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "C2题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await assert.rejects(
    () => createPracticeRunV7({ bankIds: [bank.id], questionIds: [question.id], reviewRoundId: "round_missing_c2" }),
    /复习轮次不存在|已被删除/,
  );
}

// C3：创建复习轮次必须在写事务内确认引用的题库存在。
{
  const bank = await createBankV7("C3轮次创建完整性");
  const originalBulkGet = dbV7.banks.bulkGet.bind(dbV7.banks);
  let bankRead: TxSnapshot | undefined;
  dbV7.banks.bulkGet = (async (keys) => {
    if (keys.includes(bank.id)) bankRead = txSnapshot();
    return originalBulkGet(keys);
  }) as typeof dbV7.banks.bulkGet;
  try {
    await createReviewRoundV7({ name: "C3轮次", bankIds: [bank.id] });
  } finally {
    dbV7.banks.bulkGet = originalBulkGet as typeof dbV7.banks.bulkGet;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["banks", "reviewRounds", "reviewRoundBanks", "reviewRoundItems", "changeSets", "syncMeta"]) {
    assert.ok(bankRead?.storeNames.includes(store), `createReviewRoundV7 事务必须包含 ${store}`);
  }
  await assert.rejects(
    () => createReviewRoundV7({ name: "C3非法轮次", bankIds: ["bank_missing_c3"] }),
    /题库不存在|已被删除/,
  );
}

// C4：更新复习轮次时不得写入已删除/不存在的题库引用。
{
  const bank = await createBankV7("C4轮次更新完整性");
  const round = await createReviewRoundV7({ name: "C4轮次", bankIds: [bank.id] });
  await assert.rejects(
    () => updateReviewRoundV7(round.id, { bankIds: ["bank_missing_c4"] }),
    /题库不存在|已被删除/,
  );
  assert.deepEqual((await getReviewRoundV7(round.id))?.bankIds, [bank.id], "失败的轮次更新不得污染原引用");
}

// C5：完成轮次的最终题目关系必须全部仍存在，否则不能写入悬空 reviewRoundItems。
{
  const bank = await createBankV7("C5轮次完成完整性");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "C5题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const round = await createReviewRoundV7({ name: "C5轮次", bankIds: [bank.id] });
  await assert.rejects(
    () => completeReviewRoundV7(round.id, [question.id, "question_missing_c5"]),
    /题目不存在|已被删除/,
  );
  assert.equal((await dbV7.reviewRounds.get(round.id))?.status, "active", "finalQuestionIds 校验失败时轮次必须保持 active");
  assert.equal(await dbV7.reviewRoundItems.where("roundId").equals(round.id).count(), 0, "校验失败时不得留下半成品 reviewRoundItems");
}

// C6：完整 run 保存同样必须验证所有引用，不能绕过 createPracticeRunV7 的完整性边界。
{
  const bank = await createBankV7("C6完整run保存");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "C6题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRunV7({ bankIds: [bank.id], questionIds: [question.id] });
  await assert.rejects(
    () => savePracticeRunV7({ ...run, bankId: "bank_missing_c6", bankIds: ["bank_missing_c6"] }),
    /题库不存在|已被删除/,
  );
  await assert.rejects(
    () => savePracticeRunV7({ ...run, questionIds: [question.id, "question_missing_c6"] }),
    /题目不存在|已被删除/,
  );
  await assert.rejects(
    () => savePracticeRunV7({ ...run, reviewRoundId: "round_missing_c6" }),
    /复习轮次不存在|已被删除/,
  );
  const stored = await getPracticeRunV7(run.id);
  assert.deepEqual(stored?.bankIds, [bank.id]);
  assert.deepEqual(stored?.questionIds, [question.id]);
  assert.equal(stored?.reviewRoundId, undefined);
  const raw = await dbV7.practiceRuns.get(run.id) as Record<string, unknown> | undefined;
  assert.equal(raw && "bankIds" in raw, false, "practiceRuns 元数据不得重新嵌入 bankIds");
  assert.equal(raw && "questionIds" in raw, false, "practiceRuns 元数据不得重新嵌入 questionIds");
}

await dbV7.close();
console.log("db-v7 creation integrity tests passed: practice runs and review rounds keep valid references");
