import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  createBank,
  createPracticeRun,
  createQuestion,
  createReviewRound,
  studyDb,
  addMemberships,
  archiveReviewRound,
  completeReviewRound,
  clearImageCache,
  deleteBankFolder,
  deleteBank,
  deletePracticeRun,
  deleteQuestionGroup,
  deleteQuestion,
  deleteQuestions,
  getPracticeRun,
  recordPracticeAnswer,
  resetDatabase,
  reorderBanks,
  putImageAssetBlob,
  putImageAsset,
  importQuestionBank,
  saveBankFolder,
  saveNote,
  savePracticeRun,
  savePracticeProgress,
  saveQuestionGroup,
  setQuestionMemberships,
  setPracticeRunStatus,
  splitQuestion,
  toggleQuestionFavorite,
  updateQuestion,
  updateQuestions,
  updateBank,
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

// R5：题目更新的读取、校验、写入和 change set 必须在同一个写事务中。
console.log("ATOMIC_STAGE R5");
{
  const bank = await createBank("R5题目编辑删除竞争");
  const question = await createQuestion(bank.id, { type: "单选", stem: "R5原题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = studyDb.questions.get.bind(studyDb.questions);
  let readTransaction: TxSnapshot | undefined;
  studyDb.questions.get = (async (key) => {
    if (key === question.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.questions.get;
  try {
    await updateQuestion(question.id, { tags: ["事务内编辑"] });
  } finally {
    studyDb.questions.get = originalGet as typeof studyDb.questions.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["questions", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `updateQuestion 事务必须包含 ${store}`);
  await deleteQuestion(question.id);
  await assert.rejects(() => updateQuestion(question.id, { tags: ["删除后的编辑"] }), /不存在或已被删除/);
  assert.equal(await originalGet(question.id), undefined);
}

// R6：批量题目属性更新只能生成一个 bulk change set，缺一题时整批失败。
console.log("ATOMIC_STAGE R6");
{
  const bank = await createBank("R6批量题目更新");
  const q1 = await createQuestion(bank.id, { type: "单选", stem: "R6题一", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] }, tags: ["原标签"] });
  const q2 = await createQuestion(bank.id, { type: "单选", stem: "R6题二", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] }, tags: ["原标签"] });
  const before = await studyDb.changeSets.count();
  const updated = await updateQuestions([q1.id, q2.id], (question) => ({ tags: [...question.tags, "批量标签"], favorite: true }));
  assert.equal(updated.length, 2);
  assert.equal(await studyDb.changeSets.count(), before + 1);
  const bulkChangeSet = await studyDb.changeSets.orderBy("createdAt").last();
  assert.equal(bulkChangeSet?.mutations.length, 1);
  assert.equal(bulkChangeSet?.mutations[0]?.kind, "question.bulk.upsert");
  if (bulkChangeSet?.mutations[0]?.kind === "question.bulk.upsert") {
    assert.deepEqual(new Set(bulkChangeSet.mutations[0].questions.map((item) => item.id)), new Set([q1.id, q2.id]));
  }
  const q1BeforeFailure = await studyDb.questions.get(q1.id);
  const countBeforeFailure = await studyDb.changeSets.count();
  await assert.rejects(() => updateQuestions([q1.id, "question_missing_r6"], { favorite: false }), /部分题目不存在或已被删除/);
  assert.deepEqual(await studyDb.questions.get(q1.id), q1BeforeFailure);
  assert.equal(await studyDb.changeSets.count(), countBeforeFailure);
}

// R7：删题必须在取得写事务后确定待删题与级联集合。
console.log("ATOMIC_STAGE R7");
{
  const bank = await createBank("R7删题事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R7待删除", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalBulkGet = studyDb.questions.bulkGet.bind(studyDb.questions);
  let readTransaction: TxSnapshot | undefined;
  studyDb.questions.bulkGet = (async (keys) => {
    if (keys.includes(question.id)) readTransaction = txSnapshot();
    return originalBulkGet(keys);
  }) as typeof studyDb.questions.bulkGet;
  try {
    assert.equal(await deleteQuestions([question.id]), 1);
  } finally {
    studyDb.questions.bulkGet = originalBulkGet as typeof studyDb.questions.bulkGet;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["questions", "bankQuestionMemberships", "questionGroups", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `deleteQuestions 事务必须包含 ${store}`);
}

// R8：删除练习记录必须在写事务中重读最新 run。
console.log("ATOMIC_STAGE R8");
{
  const bank = await createBank("R8练习删除事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R8练习题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRun({ bankIds: [bank.id], questionIds: [question.id] });
  await recordPracticeAnswer({ runId: run.id, questionId: question.id, selected: "A", correct: true, elapsedMs: 10 });
  const originalGet = studyDb.practiceRuns.get.bind(studyDb.practiceRuns);
  let readTransaction: TxSnapshot | undefined;
  studyDb.practiceRuns.get = (async (key) => {
    if (key === run.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.practiceRuns.get;
  try {
    assert.equal(await deletePracticeRun(run.id), true);
  } finally {
    studyDb.practiceRuns.get = originalGet as typeof studyDb.practiceRuns.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["practiceRuns", "practiceRunSources", "practiceRunItems", "attempts", "bankPracticeStats", "tombstones", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `deletePracticeRun 事务必须包含 ${store}`);
}

// R9：解析 revision 必须基于写事务内的最新行递增。
console.log("ATOMIC_STAGE R9");
{
  const bank = await createBank("R9解析事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R9解析题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = studyDb.notes.get.bind(studyDb.notes);
  let readTransaction: TxSnapshot | undefined;
  studyDb.notes.get = (async (key) => {
    if (key === question.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.notes.get;
  try {
    await saveNote(question.id, "R9第一版");
  } finally {
    studyDb.notes.get = originalGet as typeof studyDb.notes.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["notes", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `saveNote 事务必须包含 ${store}`);
}

// R10：题组的题目存在性校验必须和题组写入处于同一事务。
console.log("ATOMIC_STAGE R10");
{
  const bank = await createBank("R10题组事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R10题组题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalBulkGet = studyDb.questions.bulkGet.bind(studyDb.questions);
  let readTransaction: TxSnapshot | undefined;
  studyDb.questions.bulkGet = (async (keys) => {
    if (keys.includes(question.id)) readTransaction = txSnapshot();
    return originalBulkGet(keys);
  }) as typeof studyDb.questions.bulkGet;
  let groupId = "";
  try {
    const group = await saveQuestionGroup({ name: "R10题组", type: "专题", description: "", items: [{ questionId: question.id, note: "" }] });
    groupId = group.id;
  } finally {
    studyDb.questions.bulkGet = originalBulkGet as typeof studyDb.questions.bulkGet;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["questions", "questionGroups", "questionGroupItems", "tombstones", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `saveQuestionGroup 事务必须包含 ${store}`);
  assert.deepEqual(await studyDb.questionGroupItems.where("groupId").equals(groupId).toArray(), [{ groupId, questionId: question.id, position: 0 }]);
}

// R11：activityAt 直接属于 practiceRuns，不再维护第二张活动表。
console.log("ATOMIC_STAGE R11");
{
  const bank = await createBank("R11练习历史索引");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R11历史题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const startedAt = "2026-09-17T00:00:00.000Z";
  const answeredAt = "2026-09-17T00:10:00.000Z";
  const navigationAt = "2026-09-17T00:20:00.000Z";
  const run = await createPracticeRun({ bankIds: [bank.id], questionIds: [question.id], startedAt, updatedAt: startedAt });
  assert.equal((await studyDb.practiceRuns.get(run.id) as typeof run & { activityAt?: string })?.activityAt, startedAt);
  await recordPracticeAnswer({ runId: run.id, questionId: question.id, selected: "A", correct: true, elapsedMs: 10, createdAt: answeredAt });
  assert.equal((await studyDb.practiceRuns.get(run.id) as typeof run & { activityAt?: string })?.activityAt, answeredAt);
  const afterAnswer = await getPracticeRun(run.id);
  assert.ok(afterAnswer);
  await savePracticeProgress({ ...afterAnswer!, updatedAt: navigationAt, lastAnsweredIndex: 0 });
  assert.equal((await studyDb.practiceRuns.get(run.id) as typeof run & { activityAt?: string })?.activityAt, answeredAt);
  const completed = await setPracticeRunStatus(run.id, "completed");
  assert.ok(completed?.completedAt);
  assert.equal((await studyDb.practiceRuns.get(run.id) as typeof run & { activityAt?: string })?.activityAt, completed?.completedAt);
  assert.equal(await deletePracticeRun(run.id), true);
  assert.equal(await studyDb.practiceRuns.get(run.id), undefined);
}

// R12：删文件夹必须在写事务内读取文件夹及当前归属题库。
console.log("ATOMIC_STAGE R12");
{
  const folder = await saveBankFolder({ name: "R12文件夹", description: "" });
  await createBank({ name: "R12题库", folderId: folder.id });
  const originalGet = studyDb.bankFolders.get.bind(studyDb.bankFolders);
  let readTransaction: TxSnapshot | undefined;
  studyDb.bankFolders.get = (async (key) => {
    if (key === folder.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.bankFolders.get;
  try {
    assert.equal(await deleteBankFolder(folder.id), true);
  } finally {
    studyDb.bankFolders.get = originalGet as typeof studyDb.bankFolders.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["bankFolders", "banks", "tombstones", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `deleteBankFolder 事务必须包含 ${store}`);
}

// R13：删题库只删除当前主数据；历史练习来源 attribution 必须保留。
console.log("ATOMIC_STAGE R13");
{
  const bank = await createBank("R13删题库事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R13题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRun({ bankIds: [bank.id], questionIds: [question.id] });
  const originalGet = studyDb.banks.get.bind(studyDb.banks);
  let readTransaction: TxSnapshot | undefined;
  studyDb.banks.get = (async (key) => {
    if (key === bank.id) readTransaction = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.banks.get;
  try {
    assert.equal(await deleteBank(bank.id), true);
  } finally {
    studyDb.banks.get = originalGet as typeof studyDb.banks.get;
  }
  assert.equal(readTransaction?.active, true);
  assert.equal(readTransaction?.mode, "readwrite");
  for (const store of ["banks", "bankQuestionMemberships", "bankPracticeStats", "tombstones", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `deleteBank 事务必须包含 ${store}`);
  assert.ok(await studyDb.practiceRuns.get(run.id), "删题库不得删除历史练习");
  assert.ok(await studyDb.practiceRunSources.get([run.id, bank.id]), "历史练习来源 attribution 必须保留");
}

// R14：保存完整 run 与状态切换都必须在取得写事务后重读最新 run，避免陈旧快照覆盖并发写入。
console.log("ATOMIC_STAGE R14");
{
  const bank = await createBank("R14练习写事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R14练习题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRun({ bankIds: [bank.id], questionIds: [question.id] });
  const originalGet = studyDb.practiceRuns.get.bind(studyDb.practiceRuns);
  const reads: TxSnapshot[] = [];
  studyDb.practiceRuns.get = (async (key) => {
    if (key === run.id) {
      const snapshot = txSnapshot();
      if (snapshot) reads.push(snapshot);
      else reads.push({ active: false, mode: "none", storeNames: [] });
    }
    return originalGet(key);
  }) as typeof studyDb.practiceRuns.get;
  try {
    await savePracticeRun({ ...run, lastAnsweredIndex: 0 });
    await setPracticeRunStatus(run.id, "abandoned");
  } finally {
    studyDb.practiceRuns.get = originalGet as typeof studyDb.practiceRuns.get;
  }
  assert.equal(reads.length, 2);
  for (const readTransaction of reads) {
    assert.equal(readTransaction.active, true);
    assert.equal(readTransaction.mode, "readwrite");
    for (const store of ["practiceRuns", "practiceRunSources", "practiceRunItems", "attempts", "bankPracticeStats", "changeSets", "syncMeta"]) {
      assert.ok(readTransaction.storeNames.includes(store), `练习写事务必须包含 ${store}`);
    }
  }
}

// R15：复习轮次的更新、完成、归档必须基于写事务内的最新状态，不能用事务外陈旧快照覆盖并发状态。
console.log("ATOMIC_STAGE R15");
{
  const bank = await createBank("R15复习轮次事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R15复习题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const updateRound = await createReviewRound({ name: "R15更新", bankIds: [bank.id] });
  const completeRound = await createReviewRound({ name: "R15完成", bankIds: [bank.id] });
  const archiveRound = await createReviewRound({ name: "R15归档", bankIds: [bank.id] });
  const watched = new Set([updateRound.id, completeRound.id, archiveRound.id]);
  const originalGet = studyDb.reviewRounds.get.bind(studyDb.reviewRounds);
  const reads = new Map<string, TxSnapshot[]>();
  studyDb.reviewRounds.get = (async (key) => {
    const id = String(key);
    if (watched.has(id)) {
      const snapshot = txSnapshot() ?? { active: false, mode: "none", storeNames: [] };
      reads.set(id, [...(reads.get(id) ?? []), snapshot]);
    }
    return originalGet(key);
  }) as typeof studyDb.reviewRounds.get;
  try {
    await updateReviewRound(updateRound.id, { name: "R15已更新" });
    await completeReviewRound(completeRound.id, [question.id]);
    await archiveReviewRound(archiveRound.id);
  } finally {
    studyDb.reviewRounds.get = originalGet as typeof studyDb.reviewRounds.get;
  }
  for (const roundId of watched) {
    const roundReads = reads.get(roundId) ?? [];
    assert.ok(roundReads.length >= 1);
    for (const readTransaction of roundReads) {
      assert.equal(readTransaction.active, true);
      assert.equal(readTransaction.mode, "readwrite");
      for (const store of ["reviewRounds", "reviewRoundBanks", "reviewRoundItems", "changeSets", "syncMeta"]) assert.ok(readTransaction.storeNames.includes(store), `复习轮次写事务必须包含 ${store}`);
    }
  }
}

// R16：收藏切换必须以写事务内的最新题目值为基准，不能先在事务外读取旧 favorite。
console.log("ATOMIC_STAGE R16");
{
  const bank = await createBank("R16收藏切换事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R16收藏题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] }, favorite: false });
  const originalGet = studyDb.questions.get.bind(studyDb.questions);
  const reads: TxSnapshot[] = [];
  studyDb.questions.get = (async (key) => {
    if (key === question.id) reads.push(txSnapshot() ?? { active: false, mode: "none", storeNames: [] });
    return originalGet(key);
  }) as typeof studyDb.questions.get;
  try {
    const updated = await toggleQuestionFavorite(question.id);
    assert.equal(updated.favorite, true);
  } finally {
    studyDb.questions.get = originalGet as typeof studyDb.questions.get;
  }
  assert.ok(reads.length >= 1);
  assert.ok(reads.every((readTransaction) => readTransaction.active && readTransaction.mode === "readwrite"), "收藏切换不得在写事务外读取题目");
}

// R17：批量新增 membership 必须在同一写事务中确认题库、题目与当前排序，避免并发删题库后写入悬空关系。
console.log("ATOMIC_STAGE R17");
{
  const source = await createBank("R17来源题库");
  const target = await createBank("R17目标题库");
  const question = await createQuestion(source.id, { type: "判断", stem: "R17题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = studyDb.banks.get.bind(studyDb.banks);
  let bankRead: TxSnapshot | undefined;
  studyDb.banks.get = (async (key) => {
    if (key === target.id) bankRead = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.banks.get;
  try {
    assert.equal(await addMemberships(target.id, [question.id]), 1);
  } finally {
    studyDb.banks.get = originalGet as typeof studyDb.banks.get;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["banks", "questions", "bankQuestionMemberships", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(bankRead?.storeNames.includes(store), `addMemberships 事务必须包含 ${store}`);
  }
}

// R18：替换题目 membership 必须在写事务内读取题目、目标题库和当前 membership。
console.log("ATOMIC_STAGE R18");
{
  const source = await createBank("R18来源题库");
  const target = await createBank("R18目标题库");
  const question = await createQuestion(source.id, { type: "判断", stem: "R18题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = studyDb.questions.get.bind(studyDb.questions);
  let questionRead: TxSnapshot | undefined;
  studyDb.questions.get = (async (key) => {
    if (key === question.id) questionRead = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.questions.get;
  try {
    assert.deepEqual(await setQuestionMemberships(question.id, [target.id]), { added: 1, removed: 1 });
  } finally {
    studyDb.questions.get = originalGet as typeof studyDb.questions.get;
  }
  assert.equal(questionRead?.active, true);
  assert.equal(questionRead?.mode, "readwrite");
  for (const store of ["questions", "banks", "bankQuestionMemberships", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(questionRead?.storeNames.includes(store), `setQuestionMemberships 事务必须包含 ${store}`);
  }
}

// R19：拆题必须在写事务内确定原题、membership 与解析，不能搬运事务外的陈旧关系快照。
console.log("ATOMIC_STAGE R19");
{
  const bankA = await createBank("R19题库A");
  const bankB = await createBank("R19题库B");
  const question = await createQuestion(bankA.id, { type: "判断", stem: "R19共享题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await addMemberships(bankB.id, [question.id]);
  const originalGet = studyDb.questions.get.bind(studyDb.questions);
  let questionRead: TxSnapshot | undefined;
  studyDb.questions.get = (async (key) => {
    if (key === question.id) questionRead = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.questions.get;
  try {
    const result = await splitQuestion(question.id, [bankB.id]);
    assert.equal(result.clones.length, 1);
  } finally {
    studyDb.questions.get = originalGet as typeof studyDb.questions.get;
  }
  assert.equal(questionRead?.active, true);
  assert.equal(questionRead?.mode, "readwrite");
  for (const store of ["questions", "bankQuestionMemberships", "notes", "banks", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(questionRead?.storeNames.includes(store), `splitQuestion 事务必须包含 ${store}`);
  }
}

// R20：创建题目必须在写事务中确认题库仍存在并执行 fingerprint 去重。
console.log("ATOMIC_STAGE R20");
{
  const bank = await createBank("R20创建题事务边界");
  const originalGet = studyDb.banks.get.bind(studyDb.banks);
  let bankRead: TxSnapshot | undefined;
  studyDb.banks.get = (async (key) => {
    if (key === bank.id) bankRead = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.banks.get;
  try {
    await createQuestion(bank.id, { type: "判断", stem: "R20题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  } finally {
    studyDb.banks.get = originalGet as typeof studyDb.banks.get;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["questions", "bankQuestionMemberships", "banks", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(bankRead?.storeNames.includes(store), `createQuestion 事务必须包含 ${store}`);
  }
}

// R21：题库更新与移动必须在同一写事务内重读题库并校验目标题库文件夹。
console.log("ATOMIC_STAGE R21");
{
  const folder = await saveBankFolder({ name: "R21文件夹", description: "" });
  const bank = await createBank("R21题库");
  const originalGet = studyDb.banks.get.bind(studyDb.banks);
  let bankRead: TxSnapshot | undefined;
  studyDb.banks.get = (async (key) => {
    if (key === bank.id) bankRead = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.banks.get;
  try {
    await updateBank(bank.id, { folderId: folder.id, name: "R21已更新" });
  } finally {
    studyDb.banks.get = originalGet as typeof studyDb.banks.get;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["banks", "bankFolders", "changeSets", "syncMeta"]) assert.ok(bankRead?.storeNames.includes(store), `updateBank 事务必须包含 ${store}`);
}

// R22：题库重排必须在写事务中读取当前题库并确认目标文件夹仍存在。
console.log("ATOMIC_STAGE R22");
{
  const folder = await saveBankFolder({ name: "R22文件夹", description: "" });
  const bankA = await createBank("R22题库A");
  const bankB = await createBank("R22题库B");
  const originalBulkGet = studyDb.banks.bulkGet.bind(studyDb.banks);
  let bankRead: TxSnapshot | undefined;
  studyDb.banks.bulkGet = (async (keys) => {
    if (keys.includes(bankA.id)) bankRead = txSnapshot();
    return originalBulkGet(keys);
  }) as typeof studyDb.banks.bulkGet;
  try {
    await reorderBanks([bankB.id, bankA.id], folder.id);
  } finally {
    studyDb.banks.bulkGet = originalBulkGet as typeof studyDb.banks.bulkGet;
  }
  assert.equal(bankRead?.active, true);
  assert.equal(bankRead?.mode, "readwrite");
  for (const store of ["banks", "bankFolders", "changeSets", "syncMeta"]) assert.ok(bankRead?.storeNames.includes(store), `reorderBanks 事务必须包含 ${store}`);
}

// R23：编辑已有文件夹必须在写事务中读取最新行，避免并发删除后被陈旧编辑复活。
console.log("ATOMIC_STAGE R23");
{
  const folder = await saveBankFolder({ name: "R23文件夹", description: "初始" });
  const originalGet = studyDb.bankFolders.get.bind(studyDb.bankFolders);
  let folderRead: TxSnapshot | undefined;
  studyDb.bankFolders.get = (async (key) => {
    if (key === folder.id) folderRead = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.bankFolders.get;
  try {
    await saveBankFolder({ id: folder.id, name: "R23已更新", description: "更新" });
  } finally {
    studyDb.bankFolders.get = originalGet as typeof studyDb.bankFolders.get;
  }
  assert.equal(folderRead?.active, true);
  assert.equal(folderRead?.mode, "readwrite");
  for (const store of ["bankFolders", "tombstones", "changeSets", "syncMeta"]) assert.ok(folderRead?.storeNames.includes(store), `saveBankFolder 事务必须包含 ${store}`);
}

// R24：图片 descriptor 与本地 Blob cache 必须分表；组合写入可跨两表原子提交，
// descriptor-only 更新不得触碰缓存，清缓存只删除 imageBlobs。
{
  const bytes = new TextEncoder().encode("abc");
  const id = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const blob = new Blob([bytes], { type: "image/png" });
  await putImageAsset({ id, blob, mimeType: "image/png", size: bytes.byteLength, width: 1, height: 1 });
  const rawDescriptor = await studyDb.imageAssets.get(id) as Record<string, unknown> | undefined;
  assert.equal(rawDescriptor && "blob" in rawDescriptor, false, "imageAssets 只能保存 descriptor，禁止内嵌 Blob");
  assert.equal((await studyDb.imageBlobs.get(id))?.blob.size, bytes.byteLength, "Blob 必须保存到 imageBlobs");

  const originalGet = studyDb.imageAssets.get.bind(studyDb.imageAssets);
  const readSnapshots: TxSnapshot[] = [];
  studyDb.imageAssets.get = (async (key) => {
    if (key === id) readSnapshots.push(txSnapshot() ?? { active: false, mode: "none", storeNames: [] });
    return originalGet(key);
  }) as typeof studyDb.imageAssets.get;
  try {
    await putImageAsset({ id, mimeType: "image/png", size: bytes.byteLength, width: 2, height: 2 });
    await putImageAssetBlob(id, blob);
  } finally {
    studyDb.imageAssets.get = originalGet as typeof studyDb.imageAssets.get;
  }
  assert.equal(readSnapshots.length, 1, "descriptor-only 更新不需要读取或触碰 blob cache；blob 写入才需要校验 descriptor");
  assert.ok(
    readSnapshots.every((snapshot) => snapshot.active && snapshot.mode === "readwrite" && snapshot.storeNames.includes("imageAssets") && snapshot.storeNames.includes("imageBlobs")),
    "blob 写入必须在同时覆盖 imageAssets/imageBlobs 的写事务内校验 descriptor",
  );
  assert.equal((await studyDb.imageAssets.get(id) as Record<string, unknown> | undefined)?.blob, undefined, "descriptor 更新后 imageAssets 仍不得出现 Blob");
  assert.equal((await studyDb.imageBlobs.get(id))?.blob.size, bytes.byteLength, "descriptor-only 更新不得清掉本地 Blob cache");

  const originalToArray = studyDb.imageBlobs.toArray.bind(studyDb.imageBlobs);
  let clearRead: TxSnapshot | undefined;
  studyDb.imageBlobs.toArray = (async () => {
    clearRead = txSnapshot();
    return originalToArray();
  }) as typeof studyDb.imageBlobs.toArray;
  try {
    assert.equal(await clearImageCache(), 1);
  } finally {
    studyDb.imageBlobs.toArray = originalToArray as typeof studyDb.imageBlobs.toArray;
  }
  assert.equal(clearRead?.active, true);
  assert.equal(clearRead?.mode, "readwrite");
  assert.deepEqual(clearRead?.storeNames, ["imageBlobs"], "清缓存事务只能触碰 imageBlobs");
  assert.ok(await studyDb.imageAssets.get(id), "清缓存不得删除 descriptor");
  assert.equal(await studyDb.imageBlobs.get(id), undefined, "清缓存必须删除 blob cache row");
}

// R25：删除题组必须在写事务内重读最新题组并分配删除序号，避免并发编辑后误删陈旧快照。
console.log("ATOMIC_STAGE R25");
{
  const bank = await createBank("R25题组删除事务边界");
  const question = await createQuestion(bank.id, { type: "判断", stem: "R25题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const group = await saveQuestionGroup({ name: "R25题组", type: "专题", description: "", items: [{ questionId: question.id, note: "" }] });
  const originalGet = studyDb.questionGroups.get.bind(studyDb.questionGroups);
  let groupRead: TxSnapshot | undefined;
  studyDb.questionGroups.get = (async (key) => {
    if (key === group.id) groupRead = txSnapshot();
    return originalGet(key);
  }) as typeof studyDb.questionGroups.get;
  try {
    assert.equal(await deleteQuestionGroup(group.id), true);
  } finally {
    studyDb.questionGroups.get = originalGet as typeof studyDb.questionGroups.get;
  }
  assert.equal(groupRead?.active, true);
  assert.equal(groupRead?.mode, "readwrite");
  for (const store of ["questionGroups", "tombstones", "changeSets", "syncMeta"]) assert.ok(groupRead?.storeNames.includes(store), `deleteQuestionGroup 事务必须包含 ${store}`);
}

// R26：题库导入必须在同一写事务内确认目标题库、membership 与 note，避免并发删除后复活题库或覆盖新写入解析。
console.log("ATOMIC_STAGE R26");
{
  const target = await createBank("R26导入目标题库");
  const originalBankGet = studyDb.banks.get.bind(studyDb.banks);
  const originalMembershipGet = studyDb.bankQuestionMemberships.get.bind(studyDb.bankQuestionMemberships);
  const originalNoteGet = studyDb.notes.get.bind(studyDb.notes);
  const snapshots: TxSnapshot[] = [];
  studyDb.banks.get = (async (key) => {
    if (key === target.id) snapshots.push(txSnapshot() ?? { active: false, mode: "none", storeNames: [] });
    return originalBankGet(key);
  }) as typeof studyDb.banks.get;
  studyDb.bankQuestionMemberships.get = (async (key) => {
    if (String(key).startsWith(`${target.id}:`)) snapshots.push(txSnapshot() ?? { active: false, mode: "none", storeNames: [] });
    return originalMembershipGet(key);
  }) as typeof studyDb.bankQuestionMemberships.get;
  studyDb.notes.get = (async (key) => {
    snapshots.push(txSnapshot() ?? { active: false, mode: "none", storeNames: [] });
    return originalNoteGet(key);
  }) as typeof studyDb.notes.get;
  try {
    const imported = await importQuestionBank("R26.json", [{ stem: "R26导入题", type: "单选", options: ["甲", "乙"], answer: "A", note: "R26解析" }], { targetBankId: target.id });
    assert.equal(imported.importedCount, 1);
  } finally {
    studyDb.banks.get = originalBankGet as typeof studyDb.banks.get;
    studyDb.bankQuestionMemberships.get = originalMembershipGet as typeof studyDb.bankQuestionMemberships.get;
    studyDb.notes.get = originalNoteGet as typeof studyDb.notes.get;
  }
  assert.ok(snapshots.length >= 3);
  assert.ok(snapshots.every((snapshot) => snapshot.active && snapshot.mode === "readwrite"), "题库导入的数据库决策读取必须全部位于写事务内");
  for (const store of ["banks", "questions", "bankQuestionMemberships", "notes", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(snapshots.every((snapshot) => snapshot.storeNames.includes(store)), `题库导入事务必须包含 ${store}`);
  }
}

await studyDb.close();
console.log("db atomic write tests passed: question/note/group/run/bank/review writes stay transactional");
