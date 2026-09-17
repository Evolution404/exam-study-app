import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  clearImageCacheV7,
  createBankV7,
  createQuestionV7,
  createPracticeRunV7,
  createReviewRoundV7,
  dbV7,
  deleteBankFolderV7,
  deleteBankV7,
  deleteBankWithExclusiveQuestionsV7,
  deletePracticeRunV7,
  deleteQuestionGroupV7,
  deleteQuestionV7,
  deleteQuestionsV7,
  getBankQuestionsV7,
  getImageAssetBlobV7,
  getImageAssetDescriptorV7,
  getImageCacheSizeV7,
  getQuestionsForBanksV7,
  getReviewRoundQuestionIdsV7,
  importQuestionBankV7,
  putImageAssetV7,
  recordPracticeAnswerV7,
  removeMembershipV7,
  removeMembershipsV7,
  resetV7Database,
  reorderBanksV7,
  saveBankFolderV7,
  saveQuestionGroupV7,
  setPracticeRunStatusV7,
  splitQuestionV7,
  updateQuestionV7,
  updateQuestionsV7,
  saveNoteV7,
  savePracticeProgressV7,
} from "../../src/lib/db/db-v7";
import { discardManagedChangeSetV7, ensureChangeSetQueueBaseV7 } from "../../src/lib/sync/change-set-v7-queue";
import type { ImageAsset } from "../../src/lib/db/v7-types";
import { sha256Blob } from "../../src/lib/io/image-assets";

const OLD_NAME = "memory-line-study";
await Dexie.delete(OLD_NAME);
const oldSentinel = new Dexie(OLD_NAME);
oldSentinel.version(1).stores({ sentinel: "id" });
await oldSentinel.table("sentinel").put({ id: "keep", value: "untouched" });
await oldSentinel.close();

await resetV7Database();
await ensureChangeSetQueueBaseV7();
const queueTestBank = await createBankV7("队列级联测试");
await createQuestionV7(queueTestBank.id, { type: "单选", stem: "队列依赖题", options: ["A", "B"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
const queueTestCreate = await dbV7.changeSets.filter((record) => record.mutations.some((mutation) => mutation.kind === "bank.create" && mutation.bank.id === queueTestBank.id)).first();
assert.ok(queueTestCreate);
await assert.rejects(() => discardManagedChangeSetV7(queueTestCreate.id), /依赖|同时删除/);
await discardManagedChangeSetV7(queueTestCreate.id, { cascadeDependents: true });
assert.equal(await dbV7.banks.get(queueTestBank.id), undefined, "discarding a creation rebuilds the local projection");
assert.equal(await dbV7.questions.count(), 0, "cascade discard removes dependent question creation");
assert.equal(await dbV7.changeSets.count(), 0, "cascade discard removes the complete dependent queue chain");
const source = [
  { stem: "  Shared   stem\n", type: "单选", options: ["甲", "乙"], answer: "a", tags: ["共享"] },
  { stem: "Only A", type: "判断", options: ["正确", "错误"], answer: "A" },
];
const importedA = await importQuestionBankV7("import-a.json", source);
const importedB = await importQuestionBankV7("import-b.json", [source[0]]);
assert.equal(importedA.questionCount, 2);
assert.equal(importedB.questionCount, 1);
const [shared] = await getQuestionsForBanksV7([importedA.id, importedB.id]);
assert.ok(shared);
assert.equal((await dbV7.questions.count()), 2, "shared content is globally deduplicated");
assert.equal((await getBankQuestionsV7(importedA.id)).length, 2);
assert.equal((await getBankQuestionsV7(importedB.id)).length, 1);

// Split copies editable content and note but not historical projections.
await saveNoteV7(shared.id, "解析");
const run = await createPracticeRunV7({ bankIds: [importedA.id], questionIds: [shared.id] });
await recordPracticeAnswerV7({ runId: run.id, questionId: shared.id, selected: ["A"], correct: false, elapsedMs: 10 });
const split = await splitQuestionV7(shared.id, [importedA.id, importedB.id]);
assert.equal(split.clones.length, 1);
assert.equal((await getBankQuestionsV7(importedA.id)).find((item) => item.id === split.clones[0].id)?.id, split.clones[0].id);
assert.equal((await getBankQuestionsV7(importedB.id)).find((item) => item.id === split.clones[0].id)?.id, split.clones[0].id);
assert.equal((await dbV7.attemptStats.get(shared.id))?.total, 1);
assert.equal(await dbV7.attemptStats.get(split.clones[0].id), undefined);
assert.equal((await dbV7.notes.get(split.clones[0].id))?.content, "解析");

// Autosave still writes the latest note revision to the notes projection.
const secondNote = await saveNoteV7(shared.id, "解析 最终版");
assert.equal((await dbV7.notes.get(shared.id))?.content, "解析 最终版");
assert.equal((await dbV7.notes.get(shared.id))?.revision, secondNote.revision);

// Review target is dynamic while active and stable after completion.
const round = await createReviewRoundV7({ name: "round", bankIds: [importedA.id] });
const targetBefore = await getReviewRoundQuestionIdsV7(round.id);
assert.equal(targetBefore.length, 2);
const extra = await createQuestionV7(importedA.id, { type: "单选", stem: "dynamic", options: ["A", "B"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
assert.equal((await getReviewRoundQuestionIdsV7(round.id)).length, 3);
const parallelRound = await createReviewRoundV7({ name: "parallel", bankIds: [importedA.id] });
const dynamicTargets = await getReviewRoundQuestionIdsV7(round.id);
const reviewRun = await createPracticeRunV7({ bankIds: [importedA.id], questionIds: dynamicTargets, reviewRoundId: round.id });
for (const questionId of dynamicTargets) {
  await recordPracticeAnswerV7({ runId: reviewRun.id, questionId, selected: ["A"], correct: true, reviewRoundId: round.id, elapsedMs: 10 });
}
const roundEvidence = await dbV7.reviewRoundProgress.get(`${round.id}:${dynamicTargets[0]}`);
assert.equal(roundEvidence?.recentOutcomes?.length, 1, "轮次进度应保存个人难度所需的作答证据");
assert.equal(roundEvidence?.firstAttemptCorrect, true);
assert.equal(roundEvidence?.currentCorrectStreak, 1);
assert.equal(roundEvidence?.giveUps, 0);
const completed = await dbV7.reviewRounds.get(round.id);
assert.equal(completed?.status, "completed", "all dynamic targets auto-complete the bound round");
assert.ok(completed?.finalQuestionIds?.length, "completed round captures its final target set");
assert.equal((await dbV7.reviewRounds.get(parallelRound.id))?.status, "active", "parallel round is not advanced");
const stableTarget = await getReviewRoundQuestionIdsV7(round.id);
await removeMembershipV7(importedA.id, extra.id);
assert.deepEqual(await getReviewRoundQuestionIdsV7(round.id), stableTarget);

// Submitting an answer writes the attempt/run projections; an ordinary run
// does not advance a parallel review round.
const cloneRun = await createPracticeRunV7({ bankIds: [importedA.id], questionIds: [split.clones[0].id] });
await assert.rejects(
  () => recordPracticeAnswerV7({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true, reviewRoundId: parallelRound.id, elapsedMs: 10 }),
  /reviewRoundId/,
);
await recordPracticeAnswerV7({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true, elapsedMs: 10 });
assert.equal((await dbV7.reviewRoundProgress.get(`${parallelRound.id}:${split.clones[0].id}`)), undefined, "ordinary run does not advance a round");
const changeSetsAfterAnswer = await dbV7.changeSets.count();
const progressedRun = (await dbV7.practiceRuns.get(cloneRun.id))!;
await savePracticeProgressV7({ ...progressedRun, lastAnsweredIndex: 0, revision: progressedRun.revision + 1, updatedAt: new Date().toISOString() });
assert.equal(await dbV7.changeSets.count(), changeSetsAfterAnswer, "navigation progress must not enqueue a new change-set");

// Local folder/group/status/run actions still write projection tables and
// tombstones directly through the change-set writer.
const localFolder = await saveBankFolderV7({ name: "本地文件夹", description: "说明" });
await reorderBanksV7([importedA.id, importedB.id], localFolder.id);
assert.equal((await dbV7.banks.get(importedA.id))?.folderId, localFolder.id);
assert.equal(await deleteBankFolderV7(localFolder.id), true);
assert.equal((await dbV7.banks.get(importedA.id))?.folderId, undefined);
assert.ok(await dbV7.tombstones.get(`bankFolder:${localFolder.id}`));

const localGroup = await saveQuestionGroupV7({ name: "本地题组", type: "专题", description: "", items: [{ questionId: split.clones[0].id, note: "对照" }] });
assert.equal((await dbV7.questionGroups.get(localGroup.id))?.items.length, 1);
assert.equal(await deleteQuestionGroupV7(localGroup.id), true);
assert.ok(await dbV7.tombstones.get(`questionGroup:${localGroup.id}`));
const abandoned = await setPracticeRunStatusV7(cloneRun.id, "abandoned");
assert.equal(abandoned?.status, "abandoned");
const cloneStatsBeforeRunDelete = (await dbV7.attemptStats.get(split.clones[0].id))?.total;
assert.equal(await deletePracticeRunV7(cloneRun.id), true);
assert.equal(await dbV7.practiceRuns.get(cloneRun.id), undefined);
assert.equal((await dbV7.attemptStats.get(split.clones[0].id))?.total, cloneStatsBeforeRunDelete, "deleting a run keeps global learning stats");
assert.ok(await dbV7.tombstones.get(`practiceRun:${cloneRun.id}`), "deleting a submitted run writes a tombstone");

// Deleting a bank removes only joins, while global deletion clears history.
await deleteBankV7(importedB.id);
assert.equal(await dbV7.questions.count(), 4);
assert.equal(await dbV7.attempts.count(), 5);
await deleteQuestionV7(shared.id);
assert.equal(await dbV7.attempts.where("questionId").equals(shared.id).count(), 0);
assert.equal(await dbV7.attemptStats.get(shared.id), undefined);

// Batch cleanup removes selected joins/content, and deleting a bank can clean
// only its exclusive questions without damaging shared content.
const cleanupSource = [
  { stem: "批量独占一", type: "单选", options: ["甲", "乙"], answer: "A" },
  { stem: "批量独占二", type: "单选", options: ["甲", "乙"], answer: "A" },
  { stem: "批量共享", type: "单选", options: ["甲", "乙"], answer: "A" },
];
const cleanupA = await importQuestionBankV7("cleanup-a.json", cleanupSource);
const cleanupB = await importQuestionBankV7("cleanup-b.json", [cleanupSource[2]]);
const cleanupQuestions = await getBankQuestionsV7(cleanupA.id);
const sharedCleanup = cleanupQuestions.find((question) => question.content[0]?.type === "text" && question.content[0].text === "批量共享")!;
const exclusiveCleanupIds = cleanupQuestions.filter((question) => question.id !== sharedCleanup.id).map((question) => question.id);
const bankCleanup = await deleteBankWithExclusiveQuestionsV7(cleanupA.id);
assert.deepEqual(bankCleanup, { bankDeleted: true, deletedQuestions: 2 });
assert.equal(await dbV7.banks.get(cleanupA.id), undefined);
assert.equal((await dbV7.questions.bulkGet(exclusiveCleanupIds)).filter(Boolean).length, 0);
assert.ok(await dbV7.questions.get(sharedCleanup.id), "shared question must survive bank cleanup");
assert.equal((await getBankQuestionsV7(cleanupB.id)).length, 1);

const detachBank = await importQuestionBankV7("batch-detach.json", [
  { stem: "批量移除一", type: "判断", options: ["正确", "错误"], answer: "A" },
  { stem: "批量移除二", type: "判断", options: ["正确", "错误"], answer: "B" },
]);
const detachIds = (await getBankQuestionsV7(detachBank.id)).map((question) => question.id);
assert.equal(await removeMembershipsV7(detachBank.id, detachIds), 2);
assert.equal((await getBankQuestionsV7(detachBank.id)).length, 0);
assert.equal((await dbV7.questions.bulkGet(detachIds)).filter(Boolean).length, 2, "batch detach must keep global content");
assert.equal(await deleteQuestionsV7(detachIds), 2);
assert.equal((await dbV7.questions.bulkGet(detachIds)).filter(Boolean).length, 0);

// S1.2 [R4] savePracticeProgress 读后写竞争：被 deleteQuestionsV7 裁剪后回写陈旧快照，
// 不得把已删题目塞回 run（复活）。修复后以 DB 当前的 questionIds 为准，并丢弃指向已删题的作答。
{
  const r4Bank = await createBankV7("R4竞争测试");
  const r4q1 = await createQuestionV7(r4Bank.id, { type: "单选", stem: "R4题一", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const r4q2 = await createQuestionV7(r4Bank.id, { type: "单选", stem: "R4题二", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const r4Run = await createPracticeRunV7({ bankId: r4Bank.id, questionIds: [r4q1.id, r4q2.id] });
  await recordPracticeAnswerV7({ runId: r4Run.id, questionId: r4q1.id, selected: "A", correct: true, elapsedMs: 10 });
  // 模拟 study-app 保存前读到的陈旧快照（含 q1、q1 的答案）
  const staleSnapshot = await dbV7.practiceRuns.get(r4Run.id);
  assert.ok(staleSnapshot && staleSnapshot.questionIds.includes(r4q1.id));
  // 另一处并发删除 q1：run 被裁剪为 [q2]，answers 中 q1 被移除
  await deleteQuestionV7(r4q1.id);
  const trimmed = await dbV7.practiceRuns.get(r4Run.id);
  assert.deepEqual(trimmed?.questionIds, [r4q2.id], "删除后 run 应已裁剪");
  // 现在用陈旧快照调用 savePracticeProgressV7（模拟保存与删除交错的窗口）
  await savePracticeProgressV7({ ...staleSnapshot!, answers: { [r4q1.id]: { selected: ["A"], correct: true, submitted: true, updatedAt: staleSnapshot!.updatedAt, deviceId: staleSnapshot!.deviceId, eventId: "evt-r4" } }, lastAnsweredIndex: 0, updatedAt: new Date().toISOString(), revision: staleSnapshot!.revision + 1 });
  const after = await dbV7.practiceRuns.get(r4Run.id);
  assert.ok(after, "run 行应保留");
  assert.deepEqual(after.questionIds, [r4q2.id], "已删题 q1 不得被陈旧保存复活回 run");
  assert.ok(!after.answers[r4q1.id], "指向已删题的陈旧作答应被丢弃");
  assert.equal(after.revision, (trimmed?.revision ?? 0) + 1, "revision 应基于 DB 当前值自增");
  console.log("S1.2 passed: savePracticeProgress 读后写竞争不再复活已删题（R4）");
}

// R5：题目更新的“读取当前值→写入题目→入同步队列”必须处于同一个写事务。
// 旧实现先在事务外读取，删除可以插入两步之间并被陈旧更新复活；把读取收进
// 含 questions/changeSets/syncMeta 的事务后，IndexedDB 写事务串行化会封住该窗口。
{
  const raceBank = await createBankV7("R5题目编辑删除竞争");
  const raceQuestion = await createQuestionV7(raceBank.id, { type: "单选", stem: "R5原题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalGet = dbV7.questions.get.bind(dbV7.questions);
  let readTransaction: { active: boolean; mode: string; storeNames: string[] } | undefined;
  dbV7.questions.get = (async (key) => {
    if (key === raceQuestion.id) {
      const tx = Dexie.currentTransaction;
      readTransaction = tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
    }
    return originalGet(key);
  }) as typeof dbV7.questions.get;
  try {
    await updateQuestionV7(raceQuestion.id, { tags: ["事务内编辑"] });
  } finally {
    dbV7.questions.get = originalGet as typeof dbV7.questions.get;
  }
  assert.equal(readTransaction?.active, true, "updateQuestionV7 读取当前题目时必须已处于活动事务");
  assert.equal(readTransaction?.mode, "readwrite", "updateQuestionV7 必须在读写事务内读取当前题目");
  for (const store of ["questions", "changeSets", "syncMeta"]) assert.ok(readTransaction?.storeNames.includes(store), `updateQuestionV7 事务必须包含 ${store}`);
  await deleteQuestionV7(raceQuestion.id);
  await assert.rejects(() => updateQuestionV7(raceQuestion.id, { tags: ["删除后的编辑"] }), /不存在或已被删除/, "删除完成后后续编辑必须失败");
  assert.equal(await originalGet(raceQuestion.id), undefined, "已删除题目不得被后续编辑复活");
}

// R6：批量题目属性更新必须是一个原子写事务，并只产生一条 bulk change set。
// 任一题在事务开始时已不存在时，整批更新都失败，不能留下部分题目修改或同步事件。
{
  const bulkBank = await createBankV7("R6批量题目更新");
  const bulkQ1 = await createQuestionV7(bulkBank.id, { type: "单选", stem: "R6题一", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] }, tags: ["原标签"] });
  const bulkQ2 = await createQuestionV7(bulkBank.id, { type: "单选", stem: "R6题二", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] }, tags: ["原标签"] });
  const changeSetCountBefore = await dbV7.changeSets.count();
  const updated = await updateQuestionsV7([bulkQ1.id, bulkQ2.id], (question) => ({
    tags: [...question.tags, "批量标签"],
    favorite: true,
  }));
  assert.equal(updated.length, 2);
  assert.equal(await dbV7.changeSets.count(), changeSetCountBefore + 1, "一批更新只能新增一条 change set");
  const bulkChangeSet = await dbV7.changeSets.orderBy("createdAt").last();
  assert.equal(bulkChangeSet?.mutations.length, 1);
  assert.equal(bulkChangeSet?.mutations[0]?.kind, "question.bulk.upsert");
  if (bulkChangeSet?.mutations[0]?.kind === "question.bulk.upsert") {
    assert.deepEqual(new Set(bulkChangeSet.mutations[0].questions.map((question) => question.id)), new Set([bulkQ1.id, bulkQ2.id]));
  }
  assert.deepEqual((await dbV7.questions.get(bulkQ1.id))?.tags, ["原标签", "批量标签"]);
  assert.equal((await dbV7.questions.get(bulkQ2.id))?.favorite, true);

  const beforeFailedBatch = await dbV7.questions.get(bulkQ1.id);
  const changeSetCountBeforeFailure = await dbV7.changeSets.count();
  await assert.rejects(
    () => updateQuestionsV7([bulkQ1.id, "question_missing_r6"], { favorite: false }),
    /部分题目不存在或已被删除/,
  );
  assert.deepEqual(await dbV7.questions.get(bulkQ1.id), beforeFailedBatch, "缺一题时已存在题目也不得半更新");
  assert.equal(await dbV7.changeSets.count(), changeSetCountBeforeFailure, "失败批次不得产生 change set");
}

// R7：删题必须在取得写事务后再读取待删题，避免读取与删除之间新增 membership/change set
// 而被遗漏；事务同时必须覆盖 questionGroups 与 syncMeta，因为级联和序号都会访问它们。
{
  const atomicDeleteBank = await createBankV7("R7删题事务边界");
  const atomicDeleteQuestion = await createQuestionV7(atomicDeleteBank.id, { type: "判断", stem: "R7待删除", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalBulkGet = dbV7.questions.bulkGet.bind(dbV7.questions);
  let deleteReadTransaction: { active: boolean; mode: string; storeNames: string[] } | undefined;
  dbV7.questions.bulkGet = (async (keys) => {
    if (keys.includes(atomicDeleteQuestion.id)) {
      const tx = Dexie.currentTransaction;
      deleteReadTransaction = tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
    }
    return originalBulkGet(keys);
  }) as typeof dbV7.questions.bulkGet;
  try {
    assert.equal(await deleteQuestionsV7([atomicDeleteQuestion.id]), 1);
  } finally {
    dbV7.questions.bulkGet = originalBulkGet as typeof dbV7.questions.bulkGet;
  }
  assert.equal(deleteReadTransaction?.active, true, "deleteQuestionsV7 首次读取待删题时必须已进入活动事务");
  assert.equal(deleteReadTransaction?.mode, "readwrite", "deleteQuestionsV7 必须在读写事务内确定删除集合");
  for (const store of ["questions", "bankQuestionMemberships", "questionGroups", "changeSets", "syncMeta"]) {
    assert.ok(deleteReadTransaction?.storeNames.includes(store), `deleteQuestionsV7 事务必须包含 ${store}`);
  }
}

// R8：删除练习记录必须在写事务中重读 run；否则读取后若并发提交了答案，旧快照会
// 误判为“从未提交”，从而本地删掉记录却不写 tombstone / 删除事件。
{
  const runDeleteBank = await createBankV7("R8练习删除事务边界");
  const runDeleteQuestion = await createQuestionV7(runDeleteBank.id, { type: "判断", stem: "R8练习题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const runToDelete = await createPracticeRunV7({ bankIds: [runDeleteBank.id], questionIds: [runDeleteQuestion.id] });
  await recordPracticeAnswerV7({ runId: runToDelete.id, questionId: runDeleteQuestion.id, selected: "A", correct: true, elapsedMs: 10 });
  const originalRunGet = dbV7.practiceRuns.get.bind(dbV7.practiceRuns);
  let runDeleteReadTransaction: { active: boolean; mode: string; storeNames: string[] } | undefined;
  dbV7.practiceRuns.get = (async (key) => {
    if (key === runToDelete.id) {
      const tx = Dexie.currentTransaction;
      runDeleteReadTransaction = tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
    }
    return originalRunGet(key);
  }) as typeof dbV7.practiceRuns.get;
  try {
    assert.equal(await deletePracticeRunV7(runToDelete.id), true);
  } finally {
    dbV7.practiceRuns.get = originalRunGet as typeof dbV7.practiceRuns.get;
  }
  assert.equal(runDeleteReadTransaction?.active, true, "deletePracticeRunV7 读取 run 时必须已进入活动事务");
  assert.equal(runDeleteReadTransaction?.mode, "readwrite", "deletePracticeRunV7 必须在读写事务内读取 run");
  for (const store of ["practiceRuns", "practiceRunStats", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(runDeleteReadTransaction?.storeNames.includes(store), `deletePracticeRunV7 事务必须包含 ${store}`);
  }
}

// R9：解析 revision 必须基于写事务内的最新值递增。自动保存若在事务外先读旧值，
// 两次并发保存可能都生成同一个 revision，并让同步队列失去本机真实编辑顺序。
{
  const noteRaceBank = await createBankV7("R9解析事务边界");
  const noteRaceQuestion = await createQuestionV7(noteRaceBank.id, { type: "判断", stem: "R9解析题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalNoteGet = dbV7.notes.get.bind(dbV7.notes);
  let noteReadTransaction: { active: boolean; mode: string; storeNames: string[] } | undefined;
  dbV7.notes.get = (async (key) => {
    if (key === noteRaceQuestion.id) {
      const tx = Dexie.currentTransaction;
      noteReadTransaction = tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
    }
    return originalNoteGet(key);
  }) as typeof dbV7.notes.get;
  try {
    await saveNoteV7(noteRaceQuestion.id, "R9第一版");
  } finally {
    dbV7.notes.get = originalNoteGet as typeof dbV7.notes.get;
  }
  assert.equal(noteReadTransaction?.active, true, "saveNoteV7 读取旧解析时必须已进入活动事务");
  assert.equal(noteReadTransaction?.mode, "readwrite", "saveNoteV7 必须在读写事务内计算 revision");
  for (const store of ["notes", "changeSets", "syncMeta"]) assert.ok(noteReadTransaction?.storeNames.includes(store), `saveNoteV7 事务必须包含 ${store}`);
}

// R10：题组保存的题目存在性校验必须与题组写入同一个事务；否则校验后并发删题
// 可以留下引用已删除题目的悬空题组，下一次 checkpoint 校验才会暴露损坏。
{
  const groupRaceBank = await createBankV7("R10题组事务边界");
  const groupRaceQuestion = await createQuestionV7(groupRaceBank.id, { type: "判断", stem: "R10题组题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const originalQuestionBulkGet = dbV7.questions.bulkGet.bind(dbV7.questions);
  let groupValidationTransaction: { active: boolean; mode: string; storeNames: string[] } | undefined;
  dbV7.questions.bulkGet = (async (keys) => {
    if (keys.includes(groupRaceQuestion.id)) {
      const tx = Dexie.currentTransaction;
      groupValidationTransaction = tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
    }
    return originalQuestionBulkGet(keys);
  }) as typeof dbV7.questions.bulkGet;
  try {
    await saveQuestionGroupV7({ name: "R10题组", type: "专题", description: "", items: [{ questionId: groupRaceQuestion.id, note: "" }] });
  } finally {
    dbV7.questions.bulkGet = originalQuestionBulkGet as typeof dbV7.questions.bulkGet;
  }
  assert.equal(groupValidationTransaction?.active, true, "saveQuestionGroupV7 校验题目时必须已进入活动事务");
  assert.equal(groupValidationTransaction?.mode, "readwrite", "saveQuestionGroupV7 必须在读写事务内校验题目");
  for (const store of ["questions", "questionGroups", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(groupValidationTransaction?.storeNames.includes(store), `saveQuestionGroupV7 事务必须包含 ${store}`);
  }
}

// R11：练习历史的本机活动索引必须严格跟随领域 run，同时保持 runActivityAt 口径：
// 导航进度可以改变 updatedAt，但不得把“最后活动时间”从最后一次已提交作答推迟。
{
  const historyIndexBank = await createBankV7("R11练习历史索引");
  const historyIndexQuestion = await createQuestionV7(historyIndexBank.id, { type: "判断", stem: "R11历史题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const startedAt = "2026-09-17T00:00:00.000Z";
  const answeredAt = "2026-09-17T00:10:00.000Z";
  const navigationAt = "2026-09-17T00:20:00.000Z";
  const historyRun = await createPracticeRunV7({ bankIds: [historyIndexBank.id], questionIds: [historyIndexQuestion.id], startedAt, updatedAt: startedAt });
  assert.equal((await dbV7.practiceRunActivity.get(historyRun.id))?.activityAt, startedAt);
  await recordPracticeAnswerV7({ runId: historyRun.id, questionId: historyIndexQuestion.id, selected: "A", correct: true, elapsedMs: 10, createdAt: answeredAt });
  assert.equal((await dbV7.practiceRunActivity.get(historyRun.id))?.activityAt, answeredAt);
  const afterAnswer = await dbV7.practiceRuns.get(historyRun.id);
  assert.ok(afterAnswer);
  await savePracticeProgressV7({ ...afterAnswer!, updatedAt: navigationAt, lastAnsweredIndex: 0 });
  assert.equal((await dbV7.practiceRunActivity.get(historyRun.id))?.activityAt, answeredAt, "未提交的导航进度不得改变历史排序时间");
  const completedRun = await setPracticeRunStatusV7(historyRun.id, "completed");
  assert.ok(completedRun?.completedAt);
  assert.equal((await dbV7.practiceRunActivity.get(historyRun.id))?.activityAt, completedRun?.completedAt, "已完成记录必须按完成时间排序");
  assert.equal(await deletePracticeRunV7(historyRun.id), true);
  assert.equal(await dbV7.practiceRunActivity.get(historyRun.id), undefined, "删除 run 必须同步删除本机活动索引");
}

// R12：删除题库文件夹必须在写事务中读取文件夹和当前归属题库，否则并发移入的题库
// 可能错过 detach，最终留下指向已删除 folderId 的悬空引用。
{
  const folder = await saveBankFolderV7({ name: "R12文件夹", description: "" });
  await createBankV7({ name: "R12题库", folderId: folder.id });
  const originalFolderGet = dbV7.bankFolders.get.bind(dbV7.bankFolders);
  let folderDeleteReadTransaction: { active: boolean; mode: string; storeNames: string[] } | undefined;
  dbV7.bankFolders.get = (async (key) => {
    if (key === folder.id) {
      const tx = Dexie.currentTransaction;
      folderDeleteReadTransaction = tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
    }
    return originalFolderGet(key);
  }) as typeof dbV7.bankFolders.get;
  try {
    assert.equal(await deleteBankFolderV7(folder.id), true);
  } finally {
    dbV7.bankFolders.get = originalFolderGet as typeof dbV7.bankFolders.get;
  }
  assert.equal(folderDeleteReadTransaction?.active, true, "deleteBankFolderV7 读取文件夹时必须已进入活动事务");
  assert.equal(folderDeleteReadTransaction?.mode, "readwrite");
  for (const store of ["bankFolders", "banks", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(folderDeleteReadTransaction?.storeNames.includes(store), `deleteBankFolderV7 事务必须包含 ${store}`);
  }
}

// R13：删除题库必须在写事务中确定 memberships 与 runs；否则删除窗口内新建的关系/
// 练习记录会成为悬空引用。同步序号也必须由同一 syncMeta 事务分配。
{
  const bank = await createBankV7("R13删题库事务边界");
  const question = await createQuestionV7(bank.id, { type: "判断", stem: "R13题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRunV7({ bankIds: [bank.id], questionIds: [question.id] });
  const originalBankGet = dbV7.banks.get.bind(dbV7.banks);
  let bankDeleteReadTransaction: { active: boolean; mode: string; storeNames: string[] } | undefined;
  dbV7.banks.get = (async (key) => {
    if (key === bank.id) {
      const tx = Dexie.currentTransaction;
      bankDeleteReadTransaction = tx ? { active: tx.active, mode: tx.mode, storeNames: [...tx.storeNames] } : undefined;
    }
    return originalBankGet(key);
  }) as typeof dbV7.banks.get;
  try {
    assert.equal(await deleteBankV7(bank.id), true);
  } finally {
    dbV7.banks.get = originalBankGet as typeof dbV7.banks.get;
  }
  assert.equal(bankDeleteReadTransaction?.active, true, "deleteBankV7 读取题库时必须已进入活动事务");
  assert.equal(bankDeleteReadTransaction?.mode, "readwrite");
  for (const store of ["banks", "bankQuestionMemberships", "practiceRuns", "practiceRunActivity", "practiceRunStats", "tombstones", "changeSets", "syncMeta"]) {
    assert.ok(bankDeleteReadTransaction?.storeNames.includes(store), `deleteBankV7 事务必须包含 ${store}`);
  }
  assert.equal(await dbV7.practiceRuns.get(run.id), undefined);
  assert.equal(await dbV7.practiceRunActivity.get(run.id), undefined);
}

// S1.4 [E5] 删题级联清空该题跨所有历史 run 的 attempts（全局清理语义，非按 run 隔离）。
{
  const e5Bank = await createBankV7("E5跨run清理");
  const e5q1 = await createQuestionV7(e5Bank.id, { type: "单选", stem: "E5共享题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const e5q2 = await createQuestionV7(e5Bank.id, { type: "单选", stem: "E5陪跑题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const runA = await createPracticeRunV7({ bankId: e5Bank.id, questionIds: [e5q1.id, e5q2.id] });
  const runB = await createPracticeRunV7({ bankId: e5Bank.id, questionIds: [e5q1.id, e5q2.id] });
  await recordPracticeAnswerV7({ runId: runA.id, questionId: e5q1.id, selected: "A", correct: true, elapsedMs: 10 });
  await recordPracticeAnswerV7({ runId: runB.id, questionId: e5q1.id, selected: "B", correct: false, elapsedMs: 10 });
  assert.ok((await dbV7.attemptStats.get(e5q1.id))?.total, "删前应有全局统计");
  assert.equal(await dbV7.attempts.where("questionId").equals(e5q1.id).count(), 2, "删前两条 run 各有一条作答");
  await deleteQuestionV7(e5q1.id);
  assert.equal(await dbV7.attempts.where("questionId").equals(e5q1.id).count(), 0, "跨 runA/runB 的全部 attempts 应被清空");
  assert.equal(await dbV7.attemptStats.get(e5q1.id), undefined, "全局统计应清除");
  assert.equal(await dbV7.attemptDailyStats.where("questionId").equals(e5q1.id).count(), 0, "每日统计应清除");
  const runAAfter = await dbV7.practiceRuns.get(runA.id);
  const runBAfter = await dbV7.practiceRuns.get(runB.id);
  assert.deepEqual(runAAfter?.questionIds, [e5q2.id], "runA 应被裁剪（行保留）");
  assert.deepEqual(runBAfter?.questionIds, [e5q2.id], "runB 应被裁剪（行保留）");
  console.log("S1.4 passed: 删题级联清空跨 run 全部 attempts（E5 全局清理语义）");
}

// S2.5 [E4] 删活动复习轮次中的题 → 该题已不在轮次目标集，in-flight 作答应被拒（特征化）。
// 活动轮次的目标集运行时按 bankIds 动态派生，删题后该题不再属于目标集。
{
  const e4Bank = await createBankV7("E4复习轮次");
  const e4q1 = await createQuestionV7(e4Bank.id, { type: "单选", stem: "E4轮次题一", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await createQuestionV7(e4Bank.id, { type: "单选", stem: "E4轮次题二", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const e4Round = await createReviewRoundV7({ name: "E4轮", bankIds: [e4Bank.id] });
  assert.ok((await getReviewRoundQuestionIdsV7(e4Round.id)).includes(e4q1.id), "删前 q1 应在轮次目标集");
  const e4Run = await createPracticeRunV7({ bankIds: [e4Bank.id], questionIds: await getReviewRoundQuestionIdsV7(e4Round.id), reviewRoundId: e4Round.id });
  await deleteQuestionV7(e4q1.id);
  assert.ok(!(await getReviewRoundQuestionIdsV7(e4Round.id)).includes(e4q1.id), "删后 q1 不再属于轮次目标集");
  await assert.rejects(() => recordPracticeAnswerV7({ runId: e4Run.id, questionId: e4q1.id, selected: "A", correct: true, reviewRoundId: e4Round.id, elapsedMs: 10 }), /复习轮次|不属于|练习记录不包含当前题目/, "已删题的 in-flight 作答应被拒（删题已裁剪 run，作答无法落地）");
  console.log("S2.5 passed: 删活动复习轮次中的题后该题作答被拒（E4 特征化）");
}

// Image descriptor/blob validation and cache-only clearing.
const bytes = new Uint8Array([1, 2, 3]);
const blob = new Blob([bytes], { type: "image/png" });
const digest = await sha256Blob(blob);
const asset: ImageAsset = {
  id: digest,
  mimeType: "image/png",
  size: blob.size,
  width: 1,
  height: 1,
  remote: { path: `sync/v9/assets/${digest}.png`, blobSha: "a".repeat(40), sha256: digest, size: blob.size },
  blob,
};
await putImageAssetV7(asset);
assert.equal(await getImageCacheSizeV7(), blob.size);
assert.equal((await getImageAssetBlobV7(digest))?.size, blob.size);
assert.equal((await getImageAssetDescriptorV7(digest))?.blob, undefined);
await clearImageCacheV7();
assert.equal(await getImageCacheSizeV7(), 0);
assert.ok(await getImageAssetDescriptorV7(digest));

const oldCheck = new Dexie(OLD_NAME);
oldCheck.version(1).stores({ sentinel: "id" });
assert.deepEqual(await oldCheck.table("sentinel").get("keep"), { id: "keep", value: "untouched" });
await oldCheck.close();

// 往既有题库继续导入：目标库由调用方指定（不再从文件名派生），指纹去重、
// membership 追加排序、题库原名与计数语义全部沿用导入链。放在文件末尾——
// 前面的场景对全局 questions 计数敏感。
{
  const targetRows = [{ stem: "目标库已有题", type: "单选", options: ["甲", "乙"], answer: "A" }];
  const targetBank = await importQuestionBankV7("target-bank.json", targetRows);
  const bankCountBefore = await dbV7.banks.count();
  const questionCountBefore = await dbV7.questions.count();
  const targetImport = await importQuestionBankV7("more-questions.json", [
    targetRows[0], // 与目标库已有题内容一致 → 指纹去重，不计入 importedCount
    { stem: "目标库新增单选", type: "单选", options: ["甲", "乙"], answer: "A" },
    { stem: "目标库新增判断", type: "判断", options: ["正确", "错误"], answer: "A" },
  ], { targetBankId: targetBank.id });
  assert.equal(targetImport.id, targetBank.id, "目标导入不得派生新题库 id");
  assert.equal(targetImport.name, targetBank.name, "目标导入不得改动题库原名");
  assert.equal(targetImport.importedCount, 2, "重复指纹不计入新增计数");
  assert.equal(targetImport.questionCount, 3, "题库计数刷新为 1（已有）+2（新增）");
  assert.equal(await dbV7.banks.count(), bankCountBefore, "目标导入不新建题库");
  assert.equal((await dbV7.questions.count()), questionCountBefore + 2, "全局只新增 2 道题（重复指纹复用）");
  const memberships = (await dbV7.bankQuestionMemberships.where("bankId").equals(targetBank.id).toArray()).sort((a, b) => a.sortOrder - b.sortOrder);
  assert.equal(memberships.length, 3);
  assert.deepEqual(memberships.map((item) => item.sortOrder), [0, 1, 2], "追加排序接在既有 membership 之后");
  const importEvent = await dbV7.changeSets.filter((record) => record.mutations.some((mutation) => mutation.kind === "question.import" && mutation.bank.id === targetBank.id && (mutation as { memberships?: unknown[] }).memberships?.length === 3)).last();
  assert.ok(importEvent, "目标导入应发出携带目标题库的 question.import 变更集");
  await assert.rejects(() => importQuestionBankV7("x.json", targetRows, { targetBankId: "bank_missing" }), /目标题库不存在/, "目标库被删时应明确报错");
}

// 多空计算题的标准答案与作答都按位置保存；相同数值不能被去重。
{
  const calculationBank = await createBankV7("多空计算题");
  const calculationQuestion = await createQuestionV7(calculationBank.id, {
    type: "计算",
    stem: "两个结果分别为【空1】和【空2】",
    options: [],
    solution: { kind: "calculation", blanks: [{ id: "blank-1", expected: 1 }, { id: "blank-2", expected: 1 }] },
  });
  assert.deepEqual(calculationQuestion.solution, { kind: "calculation", blanks: [{ id: "blank-1", expected: 1 }, { id: "blank-2", expected: 1 }] });
  const calculationRun = await createPracticeRunV7({ bankId: calculationBank.id, questionIds: [calculationQuestion.id] });
  const submitted = await recordPracticeAnswerV7({ runId: calculationRun.id, questionId: calculationQuestion.id, selected: ["1", "1"], correct: true, elapsedMs: 10 });
  assert.deepEqual(submitted.answer.selected, ["1", "1"], "重复数值必须保留为两个位置答案");
  assert.deepEqual((await dbV7.practiceRuns.get(calculationRun.id))?.answers[calculationQuestion.id]?.selected, ["1", "1"]);
}
await dbV7.delete();
console.log("v7 database tests passed: namespace, joins, import, split, rounds, answers, deletion and image cache");
