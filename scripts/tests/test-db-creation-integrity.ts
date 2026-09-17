import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  createBank,
  createPracticeRun,
  createQuestion,
  createReviewRound,
  completeReviewRound,
  studyDb,
  getPracticeRun,
  getReviewRound,
  resetDatabase,
  savePracticeRun,
  updateReviewRound,
} from "../../src/lib/db/db";
import { ensureChangeSetQueueBase } from "../../src/lib/sync/change-set-queue";

await resetDatabase();
await ensureChangeSetQueueBase();

type TxSnapshot = { active: boolean; mode: string; storeNames: string[] };
const txSnapshot = (): TxSnapshot | undefined => {
  const tx = Dexie.currentTransaction;
  return tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
};

// C1：创建练习必须在写事务内确认题库和题目仍存在，避免并发删除留下悬空 run。
{
  const bank = await createBank("C1练习创建完整性");
  const question = await createQuestion(bank.id, { type: "判断", stem: "C1题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalBanksBulkGet = studyDb.banks.bulkGet.bind(studyDb.banks);
  const originalQuestionsBulkGet = studyDb.questions.bulkGet.bind(studyDb.questions);
  let bankRead: TxSnapshot | undefined;
  let questionRead: TxSnapshot | undefined;
  studyDb.banks.bulkGet = (async (keys) => {
    if (keys.includes(bank.id)) bankRead = txSnapshot();
    return originalBanksBulkGet(keys);
  }) as typeof studyDb.banks.bulkGet;
  studyDb.questions.bulkGet = (async (keys) => {
    if (keys.includes(question.id)) questionRead = txSnapshot();
    return originalQuestionsBulkGet(keys);
  }) as typeof studyDb.questions.bulkGet;
  try {
    await createPracticeRun({ bankIds: [bank.id], questionIds: [question.id] });
  } finally {
    studyDb.banks.bulkGet = originalBanksBulkGet as typeof studyDb.banks.bulkGet;
    studyDb.questions.bulkGet = originalQuestionsBulkGet as typeof studyDb.questions.bulkGet;
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
      assert.ok(snapshot?.storeNames.includes(store), `createPracticeRun 事务必须包含 ${store}`);
    }
  }
  const before = await studyDb.practiceRuns.count();
  await assert.rejects(
    () => createPracticeRun({ bankIds: [bank.id], questionIds: ["question_missing_c1"] }),
    /题目不存在|已被删除/,
  );
  assert.equal(await studyDb.practiceRuns.count(), before, "缺失题目时不得写入半成品 run");
  await assert.rejects(
    () => createPracticeRun({ bankIds: ["bank_missing_c1"], questionIds: [question.id] }),
    /题库不存在|已被删除/,
  );
}

// C2：绑定复习轮次的新练习必须引用仍存在且 active 的 round。
{
  const bank = await createBank("C2轮次练习完整性");
  const question = await createQuestion(bank.id, { type: "判断", stem: "C2题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await assert.rejects(
    () => createPracticeRun({ bankIds: [bank.id], questionIds: [question.id], reviewRoundId: "round_missing_c2" }),
    /复习轮次不存在|已被删除/,
  );
}

// C3：创建复习轮次必须在写事务内确认引用的题库存在。
{
  const bank = await createBank("C3轮次创建完整性");
  const originalBulkGet = studyDb.banks.bulkGet.bind(studyDb.banks);
  let bankRead: TxSnapshot | undefined;
  studyDb.banks.bulkGet = (async (keys) => {
    if (keys.includes(bank.id)) bankRead = txSnapshot();
    return originalBulkGet(keys);
  }) as typeof studyDb.banks.bulkGet;
  try {
    await createReviewRound({ name: "C3轮次", bankIds: [bank.id] });
  } finally {
    studyDb.banks.bulkGet = originalBulkGet as typeof studyDb.banks.bulkGet;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["banks", "reviewRounds", "reviewRoundBanks", "reviewRoundItems", "changeSets", "syncMeta"]) {
    assert.ok(bankRead?.storeNames.includes(store), `createReviewRound 事务必须包含 ${store}`);
  }
  await assert.rejects(
    () => createReviewRound({ name: "C3非法轮次", bankIds: ["bank_missing_c3"] }),
    /题库不存在|已被删除/,
  );
}

// C4：更新复习轮次时不得写入已删除/不存在的题库引用。
{
  const bank = await createBank("C4轮次更新完整性");
  const round = await createReviewRound({ name: "C4轮次", bankIds: [bank.id] });
  await assert.rejects(
    () => updateReviewRound(round.id, { bankIds: ["bank_missing_c4"] }),
    /题库不存在|已被删除/,
  );
  assert.deepEqual((await getReviewRound(round.id))?.bankIds, [bank.id], "失败的轮次更新不得污染原引用");
}

// C5：完成轮次的最终题目关系必须全部仍存在，否则不能写入悬空 reviewRoundItems。
{
  const bank = await createBank("C5轮次完成完整性");
  const question = await createQuestion(bank.id, { type: "判断", stem: "C5题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const round = await createReviewRound({ name: "C5轮次", bankIds: [bank.id] });
  await assert.rejects(
    () => completeReviewRound(round.id, [question.id, "question_missing_c5"]),
    /题目不存在|已被删除/,
  );
  assert.equal((await studyDb.reviewRounds.get(round.id))?.status, "active", "finalQuestionIds 校验失败时轮次必须保持 active");
  assert.equal(await studyDb.reviewRoundItems.where("roundId").equals(round.id).count(), 0, "校验失败时不得留下半成品 reviewRoundItems");
}

// C6：完整 run 保存同样必须验证所有引用，不能绕过 createPracticeRun 的完整性边界。
{
  const bank = await createBank("C6完整run保存");
  const question = await createQuestion(bank.id, { type: "判断", stem: "C6题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRun({ bankIds: [bank.id], questionIds: [question.id] });
  await assert.rejects(
    () => savePracticeRun({ ...run, bankId: "bank_missing_c6", bankIds: ["bank_missing_c6"] }),
    /题库不存在|已被删除/,
  );
  await assert.rejects(
    () => savePracticeRun({ ...run, questionIds: [question.id, "question_missing_c6"] }),
    /题目不存在|已被删除/,
  );
  await assert.rejects(
    () => savePracticeRun({ ...run, reviewRoundId: "round_missing_c6" }),
    /复习轮次不存在|已被删除/,
  );
  const stored = await getPracticeRun(run.id);
  assert.deepEqual(stored?.bankIds, [bank.id]);
  assert.deepEqual(stored?.questionIds, [question.id]);
  assert.equal(stored?.reviewRoundId, undefined);
  const raw = await studyDb.practiceRuns.get(run.id) as Record<string, unknown> | undefined;
  assert.equal(raw && "bankIds" in raw, false, "practiceRuns 元数据不得重新嵌入 bankIds");
  assert.equal(raw && "questionIds" in raw, false, "practiceRuns 元数据不得重新嵌入 questionIds");
}

await studyDb.close();
console.log("db creation integrity tests passed: practice runs and review rounds keep valid references");
