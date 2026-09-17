import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  createReviewRoundV7,
  dbV7,
  archiveReviewRoundV7,
  completeReviewRoundV7,
  deleteBankFolderV7,
  deleteBankV7,
  deletePracticeRunV7,
  deleteQuestionV7,
  deleteQuestionsV7,
  recordPracticeAnswerV7,
  resetV7Database,
  saveBankFolderV7,
  saveNoteV7,
  savePracticeRunV7,
  savePracticeProgressV7,
  saveQuestionGroupV7,
  setPracticeRunStatusV7,
  toggleQuestionFavoriteV7,
  updateQuestionV7,
  updateQuestionsV7,
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

// R5：题目更新的读取、校验、写入和 change set 必须在同一个写事务中。
{
  const bank = await createBankV7("R5题目编辑删除竞争");
  const question = await createQuestionV7(bank.id, { type: "单选", stem: "R5原题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = dbV7.questions.get.bind(dbV7.questions);
  let readTransaction: TxSnapshot | undefined;
  dbV7.questions.get = (async (key) => {
    if (key === question.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.questions.get;
  try {
    await updateQuestionV7(question.id, { tags: ["事务内编辑"] });
  } finally {
    dbV7.questions.get = originalGet as typeof dbV7.questions.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["questions", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `updateQuestionV7 事务必须包含 ${store}`);
  await deleteQuestionV7(question.id);
  await assert.rejects(() => updateQuestionV7(question.id, { tags: ["删除后的编辑"] }), /不存在或已被删除/);
  assert.equal(await originalGet(question.id), undefined);
}

// R6：批量题目属性更新只能生成一个 bulk change set，缺一题时整批失败。
{
  const bank = await createBankV7("R6批量题目更新");
  const q1 = await createQuestionV7(bank.id, { type: "单选", stem: "R6题一", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] }, tags: ["原标签"] });
  const q2 = await createQuestionV7(bank.id, { type: "单选", stem: "R6题二", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] }, tags: ["原标签"] });
  const before = await dbV7.changeSets.count();
  const updated = await updateQuestionsV7([q1.id, q2.id], (question) => ({ tags: [...question.tags, "批量标签"], favorite: true }));
  assert.equal(updated.length, 2);
  assert.equal(await dbV7.changeSets.count(), before + 1);
  const bulkChangeSet = await dbV7.changeSets.orderBy("createdAt").last();
  assert.equal(bulkChangeSet?.mutations.length, 1);
  assert.equal(bulkChangeSet?.mutations[0]?.kind, "question.bulk.upsert");
  if (bulkChangeSet?.mutations[0]?.kind === "question.bulk.upsert") {
    assert.deepEqual(new Set(bulkChangeSet.mutations[0].questions.map((item) => item.id)), new Set([q1.id, q2.id]));
  }
  const q1BeforeFailure = await dbV7.questions.get(q1.id);
  const countBeforeFailure = await dbV7.changeSets.count();
  await assert.rejects(() => updateQuestionsV7([q1.id, "question_missing_r6"], { favorite: false }), /部分题目不存在或已被删除/);
  assert.deepEqual(await dbV7.questions.get(q1.id), q1BeforeFailure);
  assert.equal(await dbV7.changeSets.count(), countBeforeFailure);
}

// R7：删题必须在取得写事务后确定待删题与级联集合。
{
  const bank = await createBankV7("R7删题事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R7待删除", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalBulkGet = dbV7.questions.bulkGet.bind(dbV7.questions);
  let readTransaction: TxSnapshot | undefined;
  dbV7.questions.bulkGet = (async (keys) => {
    if (keys.includes(question.id)) readTransaction = txSnapshot();
    return originalBulkGet(keys);
  }) as typeof dbV7.questions.bulkGet;
  try {
    assert.equal(await deleteQuestionsV7([question.id]), 1);
  } finally {
    dbV7.questions.bulkGet = originalBulkGet as typeof dbV7.questions.bulkGet;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["questions", "bankQuestionMemberships", "questionGroups", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `deleteQuestionsV7 事务必须包含 ${store}`);
}

// R8：删除练习记录必须在写事务中重读最新 run。
{
  const bank = await createBankV7("R8练习删除事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R8练习题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRunV7({ bankIds: [bank.id], questionIds: [question.id] });
  await recordPracticeAnswerV7({ runId: run.id, questionId: question.id, selected: "A", correct: true, elapsedMs: 10 });
  const originalGet = dbV7.practiceRuns.get.bind(dbV7.practiceRuns);
  let readTransaction: TxSnapshot | undefined;
  dbV7.practiceRuns.get = (async (key) => {
    if (key === run.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.practiceRuns.get;
  try {
    assert.equal(await deletePracticeRunV7(run.id), true);
  } finally {
    dbV7.practiceRuns.get = originalGet as typeof dbV7.practiceRuns.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["practiceRuns", "practiceRunStats", "tombstones", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `deletePracticeRunV7 事务必须包含 ${store}`);
}

// R9：解析 revision 必须基于写事务内的最新行递增。
{
  const bank = await createBankV7("R9解析事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R9解析题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = dbV7.notes.get.bind(dbV7.notes);
  let readTransaction: TxSnapshot | undefined;
  dbV7.notes.get = (async (key) => {
    if (key === question.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.notes.get;
  try {
    await saveNoteV7(question.id, "R9第一版");
  } finally {
    dbV7.notes.get = originalGet as typeof dbV7.notes.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["notes", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `saveNoteV7 事务必须包含 ${store}`);
}

// R10：题组的题目存在性校验必须和题组写入处于同一事务。
{
  const bank = await createBankV7("R10题组事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R10题组题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalBulkGet = dbV7.questions.bulkGet.bind(dbV7.questions);
  let readTransaction: TxSnapshot | undefined;
  dbV7.questions.bulkGet = (async (keys) => {
    if (keys.includes(question.id)) readTransaction = txSnapshot();
    return originalBulkGet(keys);
  }) as typeof dbV7.questions.bulkGet;
  try {
    await saveQuestionGroupV7({ name: "R10题组", type: "专题", description: "", items: [{ questionId: question.id, note: "" }] });
  } finally {
    dbV7.questions.bulkGet = originalBulkGet as typeof dbV7.questions.bulkGet;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["questions", "questionGroups", "tombstones", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `saveQuestionGroupV7 事务必须包含 ${store}`);
}

// R11：活动索引必须严格跟随 runActivityAt 语义，而不是 updatedAt。
{
  const bank = await createBankV7("R11练习历史索引");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R11历史题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const startedAt = "2026-09-17T00:00:00.000Z";
  const answeredAt = "2026-09-17T00:10:00.000Z";
  const navigationAt = "2026-09-17T00:20:00.000Z";
  const run = await createPracticeRunV7({ bankIds: [bank.id], questionIds: [question.id], startedAt, updatedAt: startedAt });
  assert.equal((await dbV7.practiceRunActivity.get(run.id))?.activityAt, startedAt);
  await recordPracticeAnswerV7({ runId: run.id, questionId: question.id, selected: "A", correct: true, elapsedMs: 10, createdAt: answeredAt });
  assert.equal((await dbV7.practiceRunActivity.get(run.id))?.activityAt, answeredAt);
  const afterAnswer = await dbV7.practiceRuns.get(run.id);
  assert.ok(afterAnswer);
  await savePracticeProgressV7({ ...afterAnswer!, updatedAt: navigationAt, lastAnsweredIndex: 0 });
  assert.equal((await dbV7.practiceRunActivity.get(run.id))?.activityAt, answeredAt);
  const completed = await setPracticeRunStatusV7(run.id, "completed");
  assert.ok(completed?.completedAt);
  assert.equal((await dbV7.practiceRunActivity.get(run.id))?.activityAt, completed?.completedAt);
  assert.equal(await deletePracticeRunV7(run.id), true);
  assert.equal(await dbV7.practiceRunActivity.get(run.id), undefined);
}

// R12：删文件夹必须在写事务内读取文件夹及当前归属题库。
{
  const folder = await saveBankFolderV7({ name: "R12文件夹", description: "" });
  await createBankV7({ name: "R12题库", folderId: folder.id });
  const originalGet = dbV7.bankFolders.get.bind(dbV7.bankFolders);
  let readTransaction: TxSnapshot | undefined;
  dbV7.bankFolders.get = (async (key) => {
    if (key === folder.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.bankFolders.get;
  try {
    assert.equal(await deleteBankFolderV7(folder.id), true);
  } finally {
    dbV7.bankFolders.get = originalGet as typeof dbV7.bankFolders.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["bankFolders", "banks", "tombstones", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `deleteBankFolderV7 事务必须包含 ${store}`);
}

// R13：删题库必须在写事务内确定 memberships 与 runs，并同步维护活动索引。
{
  const bank = await createBankV7("R13删题库事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R13题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRunV7({ bankIds: [bank.id], questionIds: [question.id] });
  const originalGet = dbV7.banks.get.bind(dbV7.banks);
  let readTransaction: TxSnapshot | undefined;
  dbV7.banks.get = (async (key) => {
    if (key === bank.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.banks.get;
  try {
    assert.equal(await deleteBankV7(bank.id), true);
  } finally {
    dbV7.banks.get = originalGet as typeof dbV7.banks.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["banks", "bankQuestionMemberships", "practiceRuns", "practiceRunActivity", "practiceRunStats", "tombstones", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `deleteBankV7 事务必须包含 ${store}`);
  assert.equal(await dbV7.practiceRuns.get(run.id), undefined);
  assert.equal(await dbV7.practiceRunActivity.get(run.id), undefined);
}

// R14：保存完整 run 与状态切换都必须在取得写事务后重读最新 run，避免陈旧快照覆盖并发写入。
{
  const bank = await createBankV7("R14练习写事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R14练习题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRunV7({ bankIds: [bank.id], questionIds: [question.id] });
  const originalGet = dbV7.practiceRuns.get.bind(dbV7.practiceRuns);
  const reads: TxSnapshot[] = [];
  dbV7.practiceRuns.get = (async (key) => {
    if (key === run.id) {
      const snapshot = txSnapshot();
      if (snapshot) reads.push(snapshot);
      else reads.push({ active: false, mode: "none", storeNames: [] });
    }
    return originalGet(key);
  }) as typeof dbV7.practiceRuns.get;
  try {
    await savePracticeRunV7({ ...run, lastAnsweredIndex: 0 });
    await setPracticeRunStatusV7(run.id, "abandoned");
  } finally {
    dbV7.practiceRuns.get = originalGet as typeof dbV7.practiceRuns.get;
  }
  assert.equal(reads.length, 2);
  for (const readTransaction of reads) {
    assert.equal(readTransaction.active, true);
    assert.equal(readTransaction.mode, "readwrite");
    for (const store of ["practiceRuns", "practiceRunActivity", "practiceRunStats", "changeSets", "syncMeta"]) {
      assert.ok(readTransaction.storeNames.includes(store), `练习写事务必须包含 ${store}`);
    }
  }
}

// R15：复习轮次的更新、完成、归档必须基于写事务内的最新状态，不能用事务外陈旧快照覆盖并发状态。
{
  const bank = await createBankV7("R15复习轮次事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R15复习题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const updateRound = await createReviewRoundV7({ name: "R15更新", bankIds: [bank.id] });
  const completeRound = await createReviewRoundV7({ name: "R15完成", bankIds: [bank.id] });
  const archiveRound = await createReviewRoundV7({ name: "R15归档", bankIds: [bank.id] });
  const watched = new Set([updateRound.id, completeRound.id, archiveRound.id]);
  const originalGet = dbV7.reviewRounds.get.bind(dbV7.reviewRounds);
  const reads = new Map<string, TxSnapshot[]>();
  dbV7.reviewRounds.get = (async (key) => {
    const id = String(key);
    if (watched.has(id)) {
      const snapshot = txSnapshot() ?? { active: false, mode: "none", storeNames: [] };
      reads.set(id, [...(reads.get(id) ?? []), snapshot]);
    }
    return originalGet(key);
  }) as typeof dbV7.reviewRounds.get;
  try {
    await updateReviewRoundV7(updateRound.id, { name: "R15已更新" });
    await completeReviewRoundV7(completeRound.id, [question.id]);
    await archiveReviewRoundV7(archiveRound.id);
  } finally {
    dbV7.reviewRounds.get = originalGet as typeof dbV7.reviewRounds.get;
  }
  for (const roundId of watched) {
    const roundReads = reads.get(roundId) ?? [];
    assert.ok(roundReads.length >= 1);
    for (const readTransaction of roundReads) {
      assert.equal(readTransaction.active, true);
      assert.equal(readTransaction.mode, "readwrite");
      for (const store of ["reviewRounds", "changeSets", "syncMeta"]) assert.ok(readTransaction.storeNames.includes(store), `复习轮次写事务必须包含 ${store}`);
    }
  }
}

// R16：收藏切换必须以写事务内的最新题目值为基准，不能先在事务外读取旧 favorite。
{
  const bank = await createBankV7("R16收藏切换事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R16收藏题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] }, favorite: false });
  const originalGet = dbV7.questions.get.bind(dbV7.questions);
  const reads: TxSnapshot[] = [];
  dbV7.questions.get = (async (key) => {
    if (key === question.id) reads.push(txSnapshot() ?? { active: false, mode: "none", storeNames: [] });
    return originalGet(key);
  }) as typeof dbV7.questions.get;
  try {
    const updated = await toggleQuestionFavoriteV7(question.id);
    assert.equal(updated.favorite, true);
  } finally {
    dbV7.questions.get = originalGet as typeof dbV7.questions.get;
  }
  assert.ok(reads.length >= 1);
  assert.ok(reads.every((readTransaction) => readTransaction.active && readTransaction.mode === "readwrite"), "收藏切换不得在写事务外读取题目");
}

await dbV7.close();
console.log("db-v7 atomic write tests passed: question/note/group/run/bank/review writes stay transactional");
