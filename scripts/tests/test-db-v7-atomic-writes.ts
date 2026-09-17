import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  createReviewRoundV7,
  dbV7,
  addMembershipsV7,
  archiveReviewRoundV7,
  completeReviewRoundV7,
  clearImageCacheV7,
  deleteBankFolderV7,
  deleteBankV7,
  deletePracticeRunV7,
  deleteQuestionGroupV7,
  deleteQuestionV7,
  deleteQuestionsV7,
  recordPracticeAnswerV7,
  resetV7Database,
  reorderBanksV7,
  putImageAssetBlobV7,
  putImageAssetV7,
  saveBankFolderV7,
  saveNoteV7,
  savePracticeRunV7,
  savePracticeProgressV7,
  saveQuestionGroupV7,
  setQuestionMembershipsV7,
  setPracticeRunStatusV7,
  splitQuestionV7,
  toggleQuestionFavoriteV7,
  updateQuestionV7,
  updateQuestionsV7,
  updateBankV7,
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

// R17：批量新增 membership 必须在同一写事务中确认题库、题目与当前排序，避免并发删题库后写入悬空关系。
{
  const source = await createBankV7("R17来源题库");
  const target = await createBankV7("R17目标题库");
  const question = await createQuestionV7(source.id, { type: "判断", stem: "R17题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = dbV7.banks.get.bind(dbV7.banks);
  let bankRead: TxSnapshot | undefined;
  dbV7.banks.get = (async (key) => {
    if (key === target.id) bankRead = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.banks.get;
  try {
    assert.equal(await addMembershipsV7(target.id, [question.id]), 1);
  } finally {
    dbV7.banks.get = originalGet as typeof dbV7.banks.get;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["banks", "questions", "bankQuestionMemberships", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(bankRead?.storeNames.includes(store), `addMembershipsV7 事务必须包含 ${store}`);
  }
}

// R18：替换题目 membership 必须在写事务内读取题目、目标题库和当前 membership。
{
  const source = await createBankV7("R18来源题库");
  const target = await createBankV7("R18目标题库");
  const question = await createQuestionV7(source.id, { type: "判断", stem: "R18题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = dbV7.questions.get.bind(dbV7.questions);
  let questionRead: TxSnapshot | undefined;
  dbV7.questions.get = (async (key) => {
    if (key === question.id) questionRead = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.questions.get;
  try {
    assert.deepEqual(await setQuestionMembershipsV7(question.id, [target.id]), { added: 1, removed: 1 });
  } finally {
    dbV7.questions.get = originalGet as typeof dbV7.questions.get;
  }
  assert.equal(questionRead?.active, true);
  assert.equal(questionRead?.mode, "readwrite");
  for (const store of ["questions", "banks", "bankQuestionMemberships", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(questionRead?.storeNames.includes(store), `setQuestionMembershipsV7 事务必须包含 ${store}`);
  }
}

// R19：拆题必须在写事务内确定原题、membership 与解析，不能搬运事务外的陈旧关系快照。
{
  const bankA = await createBankV7("R19题库A");
  const bankB = await createBankV7("R19题库B");
  const question = await createQuestionV7(bankA.id, { type: "判断", stem: "R19共享题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await addMembershipsV7(bankB.id, [question.id]);
  const originalGet = dbV7.questions.get.bind(dbV7.questions);
  let questionRead: TxSnapshot | undefined;
  dbV7.questions.get = (async (key) => {
    if (key === question.id) questionRead = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.questions.get;
  try {
    const result = await splitQuestionV7(question.id, [bankB.id]);
    assert.equal(result.clones.length, 1);
  } finally {
    dbV7.questions.get = originalGet as typeof dbV7.questions.get;
  }
  assert.equal(questionRead?.active, true);
  assert.equal(questionRead?.mode, "readwrite");
  for (const store of ["questions", "bankQuestionMemberships", "notes", "banks", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(questionRead?.storeNames.includes(store), `splitQuestionV7 事务必须包含 ${store}`);
  }
}

// R20：创建题目必须在写事务中确认题库仍存在并执行 fingerprint 去重。
{
  const bank = await createBankV7("R20创建题事务边界");
  const originalGet = dbV7.banks.get.bind(dbV7.banks);
  let bankRead: TxSnapshot | undefined;
  dbV7.banks.get = (async (key) => {
    if (key === bank.id) bankRead = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.banks.get;
  try {
    await createQuestionV7(bank.id, { type: "判断", stem: "R20题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  } finally {
    dbV7.banks.get = originalGet as typeof dbV7.banks.get;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["questions", "bankQuestionMemberships", "banks", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(bankRead?.storeNames.includes(store), `createQuestionV7 事务必须包含 ${store}`);
  }
}

// R21：题库更新与移动必须在同一写事务内重读题库并校验目标题库文件夹。
{
  const folder = await saveBankFolderV7({ name: "R21文件夹", description: "" });
  const bank = await createBankV7("R21题库");
  const originalGet = dbV7.banks.get.bind(dbV7.banks);
  let bankRead: TxSnapshot | undefined;
  dbV7.banks.get = (async (key) => {
    if (key === bank.id) bankRead = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.banks.get;
  try {
    await updateBankV7(bank.id, { folderId: folder.id, name: "R21已更新" });
  } finally {
    dbV7.banks.get = originalGet as typeof dbV7.banks.get;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["banks", "bankFolders", "changeSets", "syncMeta"]) assert.ok(bankRead?.storeNames.includes(store), `updateBankV7 事务必须包含 ${store}`);
}

// R22：题库重排必须在写事务中读取当前题库并确认目标文件夹仍存在。
{
  const folder = await saveBankFolderV7({ name: "R22文件夹", description: "" });
  const bankA = await createBankV7("R22题库A");
  const bankB = await createBankV7("R22题库B");
  const originalBulkGet = dbV7.banks.bulkGet.bind(dbV7.banks);
  let bankRead: TxSnapshot | undefined;
  dbV7.banks.bulkGet = (async (keys) => {
    if (keys.includes(bankA.id)) bankRead = txSnapshot();
    return originalBulkGet(keys);
  }) as typeof dbV7.banks.bulkGet;
  try {
    await reorderBanksV7([bankB.id, bankA.id], folder.id);
  } finally {
    dbV7.banks.bulkGet = originalBulkGet as typeof dbV7.banks.bulkGet;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["banks", "bankFolders", "changeSets", "syncMeta"]) assert.ok(bankRead?.storeNames.includes(store), `reorderBanksV7 事务必须包含 ${store}`);
}

// R23：编辑已有文件夹必须在写事务中读取最新行，避免并发删除后被陈旧编辑复活。
{
  const folder = await saveBankFolderV7({ name: "R23文件夹", description: "初始" });
  const originalGet = dbV7.bankFolders.get.bind(dbV7.bankFolders);
  let folderRead: TxSnapshot | undefined;
  dbV7.bankFolders.get = (async (key) => {
    if (key === folder.id) folderRead = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.bankFolders.get;
  try {
    await saveBankFolderV7({ id: folder.id, name: "R23已更新", description: "更新" });
  } finally {
    dbV7.bankFolders.get = originalGet as typeof dbV7.bankFolders.get;
  }
  assert.equal(folderRead?.active, true);
  assert.equal(folderRead?.mode, "readwrite");
  for (const store of ["bankFolders", "tombstones", "changeSets", "syncMeta"]) assert.ok(folderRead?.storeNames.includes(store), `saveBankFolderV7 事务必须包含 ${store}`);
}

// R24：图片 descriptor/blob/cache 清理必须在同一写事务中读取最新缓存行，避免并发写互相覆盖 Blob 或 descriptor。
{
  const bytes = new TextEncoder().encode("abc");
  const id = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const blob = new Blob([bytes], { type: "image/png" });
  await putImageAssetV7({ id, blob, mimeType: "image/png", size: bytes.byteLength, width: 1, height: 1 });

  const originalGet = dbV7.imageAssets.get.bind(dbV7.imageAssets);
  const readSnapshots: TxSnapshot[] = [];
  dbV7.imageAssets.get = (async (key) => {
    if (key === id) readSnapshots.push(txSnapshot() ?? { active: false, mode: "none", storeNames: [] });
    return originalGet(key);
  }) as typeof dbV7.imageAssets.get;
  try {
    await putImageAssetV7({ id, mimeType: "image/png", size: bytes.byteLength, width: 2, height: 2 });
    await putImageAssetBlobV7(id, blob);
  } finally {
    dbV7.imageAssets.get = originalGet as typeof dbV7.imageAssets.get;
  }
  assert.equal(readSnapshots.length, 2);
  assert.ok(readSnapshots.every((snapshot) => snapshot.active && snapshot.mode === "readwrite" && snapshot.storeNames.includes("imageAssets")), "图片缓存 get 必须位于 imageAssets 写事务内");

  const originalToArray = dbV7.imageAssets.toArray.bind(dbV7.imageAssets);
  let clearRead: TxSnapshot | undefined;
  dbV7.imageAssets.toArray = (async () => {
    clearRead = txSnapshot();
    return originalToArray();
  }) as typeof dbV7.imageAssets.toArray;
  try {
    assert.equal(await clearImageCacheV7(), 1);
  } finally {
    dbV7.imageAssets.toArray = originalToArray as typeof dbV7.imageAssets.toArray;
  }
  assert.equal(clearRead?.active, true);
  assert.equal(clearRead?.mode, "readwrite");
}

// R25：删除题组必须在写事务内重读最新题组并分配删除序号，避免并发编辑后误删陈旧快照。
{
  const bank = await createBankV7("R25题组删除事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R25题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const group = await saveQuestionGroupV7({ name: "R25题组", type: "专题", description: "", items: [{ questionId: question.id, note: "" }] });
  const originalGet = dbV7.questionGroups.get.bind(dbV7.questionGroups);
  let groupRead: TxSnapshot | undefined;
  dbV7.questionGroups.get = (async (key) => {
    if (key === group.id) groupRead = txSnapshot();
    return originalGet(key);
  }) as typeof dbV7.questionGroups.get;
  try {
    assert.equal(await deleteQuestionGroupV7(group.id), true);
  } finally {
    dbV7.questionGroups.get = originalGet as typeof dbV7.questionGroups.get;
  }
  assert.equal(groupRead?.active, true);
  assert.equal(groupRead?.mode, "readwrite");
  for (const store of ["questionGroups", "tombstones", "changeSets", "syncMeta"]) assert.ok(groupRead?.storeNames.includes(store), `deleteQuestionGroupV7 事务必须包含 ${store}`);
}

await dbV7.close();
console.log("db-v7 atomic write tests passed: question/note/group/run/bank/review writes stay transactional");
