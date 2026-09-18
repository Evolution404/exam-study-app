import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  clearImageCache,
  createBank,
  createQuestion,
  createPracticeRun,
  createReviewRound,
  studyDb,
  deleteBankFolder,
  deleteBank,
  deleteBankWithExclusiveQuestions,
  deletePracticeRun,
  deleteQuestionGroup,
  deleteQuestion,
  deleteQuestions,
  getBankQuestions,
  getImageAssetBlob,
  getImageAssetDescriptor,
  getImageCacheSize,
  getQuestionsForBanks,
  getPracticeRun,
  getReviewRound,
  getReviewRoundQuestionIds,
  importQuestionBank,
  putImageAsset,
  recordPracticeAnswer,
  removeMembership,
  removeMemberships,
  resetDatabase,
  reorderBanks,
  saveBankFolder,
  saveQuestionGroup,
  setPracticeRunStatus,
  splitQuestion,
  saveNote,
  savePracticeProgress,
} from "../../src/lib/db/db";
import { discardManagedChangeSet, ensureChangeSetQueueBase } from "../../src/lib/sync/change-set-queue";
import type { ImageAsset } from "../../src/lib/db/types";
import { sha256Blob } from "../../src/lib/io/image-assets";

const OLD_NAME = "memory-line-study";
await Dexie.delete(OLD_NAME);
const oldSentinel = new Dexie(OLD_NAME);
oldSentinel.version(1).stores({ sentinel: "id" });
await oldSentinel.table("sentinel").put({ id: "keep", value: "untouched" });
await oldSentinel.close();

await resetDatabase();
await ensureChangeSetQueueBase();
const queueTestBank = await createBank("队列级联测试");
await createQuestion(queueTestBank.id, { type: "单选", stem: "队列依赖题", options: ["A", "B"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
const queueTestCreate = await studyDb.changeSets.filter((record) => record.mutations.some((mutation) => mutation.kind === "bank.create" && mutation.bank.id === queueTestBank.id)).first();
assert.ok(queueTestCreate);
await assert.rejects(() => discardManagedChangeSet(queueTestCreate.id), /依赖|同时删除/);
await discardManagedChangeSet(queueTestCreate.id, { cascadeDependents: true });
assert.equal(await studyDb.banks.get(queueTestBank.id), undefined, "discarding a creation rebuilds the local projection");
assert.equal(await studyDb.questions.count(), 0, "cascade discard removes dependent question creation");
assert.equal(await studyDb.changeSets.count(), 0, "cascade discard removes the complete dependent queue chain");
const source = [
  { stem: "  Shared   stem\n", type: "单选", options: ["甲", "乙"], answer: "a", tags: ["共享"] },
  { stem: "Only A", type: "判断", options: ["正确", "错误"], answer: "A" },
];
const importedA = await importQuestionBank("import-a.json", source);
const importedB = await importQuestionBank("import-b.json", [source[0]]);
assert.equal((await studyDb.bankQuestionStats.get(importedA.id))?.questionCount, 2);
assert.equal((await studyDb.bankQuestionStats.get(importedB.id))?.questionCount, 1);
const [shared] = await getQuestionsForBanks([importedA.id, importedB.id]);
assert.ok(shared);
assert.equal((await studyDb.questions.count()), 2, "shared content is globally deduplicated");
assert.equal((await getBankQuestions(importedA.id)).length, 2);
assert.equal((await getBankQuestions(importedB.id)).length, 1);

// Split copies editable content and note but not historical projections.
await saveNote(shared.id, "解析");
const run = await createPracticeRun({ bankIds: [importedA.id], questionIds: [shared.id] });
await recordPracticeAnswer({ runId: run.id, questionId: shared.id, selected: ["A"], correct: false, elapsedMs: 10 });
const split = await splitQuestion(shared.id, [importedA.id, importedB.id]);
assert.equal(split.clones.length, 1);
assert.equal((await getBankQuestions(importedA.id)).find((item) => item.id === split.clones[0].id)?.id, split.clones[0].id);
assert.equal((await getBankQuestions(importedB.id)).find((item) => item.id === split.clones[0].id)?.id, split.clones[0].id);
assert.equal((await studyDb.questionProgress.get(shared.id))?.total, 1);
assert.equal(await studyDb.questionProgress.get(split.clones[0].id), undefined);
assert.equal((await studyDb.notes.get(split.clones[0].id))?.content, "解析");

// Autosave still writes the latest note revision to the notes projection.
const secondNote = await saveNote(shared.id, "解析 最终版");
assert.equal((await studyDb.notes.get(shared.id))?.content, "解析 最终版");
assert.equal((await studyDb.notes.get(shared.id))?.revision, secondNote.revision);

// Review target is dynamic while active and stable after completion.
const round = await createReviewRound({ name: "round", bankIds: [importedA.id] });
const targetBefore = await getReviewRoundQuestionIds(round.id);
assert.equal(targetBefore.length, 2);
const extra = await createQuestion(importedA.id, { type: "单选", stem: "dynamic", options: ["A", "B"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
assert.equal((await getReviewRoundQuestionIds(round.id)).length, 3);
const parallelRound = await createReviewRound({ name: "parallel", bankIds: [importedA.id] });
const dynamicTargets = await getReviewRoundQuestionIds(round.id);
const reviewRun = await createPracticeRun({ bankIds: [importedA.id], questionIds: dynamicTargets, reviewRoundId: round.id });
for (const questionId of dynamicTargets) {
  await recordPracticeAnswer({ runId: reviewRun.id, questionId, selected: ["A"], correct: true, reviewRoundId: round.id, elapsedMs: 10 });
}
const roundEvidence = await studyDb.reviewRoundProgress.get([round.id, dynamicTargets[0]]);
assert.equal(roundEvidence?.recentOutcomes?.length, 1, "轮次进度应保存个人难度所需的作答证据");
assert.equal(roundEvidence?.firstAttemptCorrect, true);
assert.equal(roundEvidence?.currentCorrectStreak, 1);
assert.equal(roundEvidence?.giveUps, 0);
const completed = await getReviewRound(round.id);
assert.equal(completed?.status, "completed", "all dynamic targets auto-complete the bound round");
assert.ok(completed?.finalQuestionIds?.length, "completed round captures its final target set");
assert.equal((await getReviewRound(parallelRound.id))?.status, "active", "parallel round is not advanced");
const stableTarget = await getReviewRoundQuestionIds(round.id);
await removeMembership(importedA.id, extra.id);
assert.deepEqual(await getReviewRoundQuestionIds(round.id), stableTarget);

// Submitting an answer writes the attempt/run projections; an ordinary run
// does not advance a parallel review round.
const cloneRun = await createPracticeRun({ bankIds: [importedA.id], questionIds: [split.clones[0].id] });
await assert.rejects(
  () => recordPracticeAnswer({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true, reviewRoundId: parallelRound.id, elapsedMs: 10 }),
  /reviewRoundId/,
);
await recordPracticeAnswer({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true, elapsedMs: 10 });
assert.equal((await studyDb.reviewRoundProgress.get([parallelRound.id, split.clones[0].id])), undefined, "ordinary run does not advance a round");
const changeSetsAfterAnswer = await studyDb.changeSets.count();
const progressedRun = (await getPracticeRun(cloneRun.id))!;
await savePracticeProgress({ ...progressedRun, lastAnsweredIndex: 0, revision: progressedRun.revision + 1, updatedAt: new Date().toISOString() });
assert.equal(await studyDb.changeSets.count(), changeSetsAfterAnswer, "navigation progress must not enqueue a new change-set");

// Local folder/group/status/run actions still write projection tables and
// tombstones directly through the change-set writer.
const localFolder = await saveBankFolder({ name: "本地文件夹", description: "说明" });
await reorderBanks([importedA.id, importedB.id], localFolder.id);
assert.equal((await studyDb.banks.get(importedA.id))?.folderId, localFolder.id);
assert.equal(await deleteBankFolder(localFolder.id), true);
assert.equal((await studyDb.banks.get(importedA.id))?.folderId, undefined);
assert.ok(await studyDb.tombstones.get(`bankFolder:${localFolder.id}`));

const localGroup = await saveQuestionGroup({ name: "本地题组", type: "专题", description: "", items: [{ questionId: split.clones[0].id, note: "对照" }] });
assert.equal((await studyDb.questionGroupItems.where("groupId").equals(localGroup.id).count()), 1);
assert.equal(await deleteQuestionGroup(localGroup.id), true);
assert.ok(await studyDb.tombstones.get(`questionGroup:${localGroup.id}`));
const abandoned = await setPracticeRunStatus(cloneRun.id, "abandoned");
assert.equal(abandoned?.status, "abandoned");
const cloneStatsBeforeRunDelete = (await studyDb.questionProgress.get(split.clones[0].id))?.total;
assert.equal(await deletePracticeRun(cloneRun.id), true);
assert.equal(await studyDb.practiceRuns.get(cloneRun.id), undefined);
assert.equal((await studyDb.questionProgress.get(split.clones[0].id))?.total, cloneStatsBeforeRunDelete, "deleting a run keeps global learning stats");
assert.ok(await studyDb.tombstones.get(`practiceRun:${cloneRun.id}`), "deleting a submitted run writes a tombstone");

// Deleting a bank removes only joins, while global deletion clears history.
await deleteBank(importedB.id);
assert.equal(await studyDb.questions.count(), 4);
assert.equal(await studyDb.attempts.count(), 5);
await deleteQuestion(shared.id);
assert.equal(await studyDb.attempts.where("questionId").equals(shared.id).count(), 0);
assert.equal(await studyDb.questionProgress.get(shared.id), undefined);

// Batch cleanup removes selected joins/content, and deleting a bank can clean
// only its exclusive questions without damaging shared content.
const cleanupSource = [
  { stem: "批量独占一", type: "单选", options: ["甲", "乙"], answer: "A" },
  { stem: "批量独占二", type: "单选", options: ["甲", "乙"], answer: "A" },
  { stem: "批量共享", type: "单选", options: ["甲", "乙"], answer: "A" },
];
const cleanupA = await importQuestionBank("cleanup-a.json", cleanupSource);
const cleanupB = await importQuestionBank("cleanup-b.json", [cleanupSource[2]]);
const cleanupQuestions = await getBankQuestions(cleanupA.id);
const sharedCleanup = cleanupQuestions.find((question) => question.content[0]?.type === "text" && question.content[0].text === "批量共享")!;
const exclusiveCleanupIds = cleanupQuestions.filter((question) => question.id !== sharedCleanup.id).map((question) => question.id);
const bankCleanup = await deleteBankWithExclusiveQuestions(cleanupA.id);
assert.deepEqual(bankCleanup, { bankDeleted: true, deletedQuestions: 2 });
assert.equal(await studyDb.banks.get(cleanupA.id), undefined);
assert.equal((await studyDb.questions.bulkGet(exclusiveCleanupIds)).filter(Boolean).length, 0);
assert.ok(await studyDb.questions.get(sharedCleanup.id), "shared question must survive bank cleanup");
assert.equal((await getBankQuestions(cleanupB.id)).length, 1);

const detachBank = await importQuestionBank("batch-detach.json", [
  { stem: "批量移除一", type: "判断", options: ["正确", "错误"], answer: "A" },
  { stem: "批量移除二", type: "判断", options: ["正确", "错误"], answer: "B" },
]);
const detachIds = (await getBankQuestions(detachBank.id)).map((question) => question.id);
assert.equal(await removeMemberships(detachBank.id, detachIds), 2);
assert.equal((await getBankQuestions(detachBank.id)).length, 0);
assert.equal((await studyDb.questions.bulkGet(detachIds)).filter(Boolean).length, 2, "batch detach must keep global content");
assert.equal(await deleteQuestions(detachIds), 2);
assert.equal((await studyDb.questions.bulkGet(detachIds)).filter(Boolean).length, 0);

// S1.2 [R4] savePracticeProgress 读后写竞争：被 deleteQuestions 裁剪后回写陈旧快照，
// 不得把已删题目塞回 run（复活）。修复后以 DB 当前的 questionIds 为准，并丢弃指向已删题的作答。
{
  const r4Bank = await createBank("R4竞争测试");
  const r4q1 = await createQuestion(r4Bank.id, { type: "单选", stem: "R4题一", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const r4q2 = await createQuestion(r4Bank.id, { type: "单选", stem: "R4题二", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const r4Run = await createPracticeRun({ bankId: r4Bank.id, questionIds: [r4q1.id, r4q2.id] });
  await recordPracticeAnswer({ runId: r4Run.id, questionId: r4q1.id, selected: "A", correct: true, elapsedMs: 10 });
  // 模拟 study-app 保存前读到的陈旧快照（含 q1、q1 的答案）
  const staleSnapshot = await getPracticeRun(r4Run.id);
  assert.ok(staleSnapshot && staleSnapshot.questionIds.includes(r4q1.id));
  // 另一处并发删除 q1：run 被裁剪为 [q2]，answers 中 q1 被移除
  await deleteQuestion(r4q1.id);
  const trimmed = await getPracticeRun(r4Run.id);
  assert.deepEqual(trimmed?.questionIds, [r4q2.id], "删除后 run 应已裁剪");
  // 现在用陈旧快照调用 savePracticeProgress（模拟保存与删除交错的窗口）
  await savePracticeProgress({ ...staleSnapshot!, answers: { [r4q1.id]: { selected: ["A"], correct: true, submitted: true, updatedAt: staleSnapshot!.updatedAt, deviceId: staleSnapshot!.deviceId, eventId: "evt-r4" } }, lastAnsweredIndex: 0, updatedAt: new Date().toISOString(), revision: staleSnapshot!.revision + 1 });
  const after = await getPracticeRun(r4Run.id);
  assert.ok(after, "run 行应保留");
  assert.deepEqual(after.questionIds, [r4q2.id], "已删题 q1 不得被陈旧保存复活回 run");
  assert.ok(!after.answers[r4q1.id], "指向已删题的陈旧作答应被丢弃");
  assert.equal(after.revision, (trimmed?.revision ?? 0) + 1, "revision 应基于 DB 当前值自增");
  console.log("S1.2 passed: savePracticeProgress 读后写竞争不再复活已删题（R4）");
}

// S1.4 [E5] 删题级联清空该题跨所有历史 run 的 attempts（全局清理语义，非按 run 隔离）。
{
  const e5Bank = await createBank("E5跨run清理");
  const e5q1 = await createQuestion(e5Bank.id, { type: "单选", stem: "E5共享题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const e5q2 = await createQuestion(e5Bank.id, { type: "单选", stem: "E5陪跑题", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const runA = await createPracticeRun({ bankId: e5Bank.id, questionIds: [e5q1.id, e5q2.id] });
  const runB = await createPracticeRun({ bankId: e5Bank.id, questionIds: [e5q1.id, e5q2.id] });
  await recordPracticeAnswer({ runId: runA.id, questionId: e5q1.id, selected: "A", correct: true, elapsedMs: 10 });
  await recordPracticeAnswer({ runId: runB.id, questionId: e5q1.id, selected: "B", correct: false, elapsedMs: 10 });
  assert.ok((await studyDb.questionProgress.get(e5q1.id))?.total, "删前应有全局统计");
  assert.equal(await studyDb.attempts.where("questionId").equals(e5q1.id).count(), 2, "删前两条 run 各有一条作答");
  await deleteQuestion(e5q1.id);
  assert.equal(await studyDb.attempts.where("questionId").equals(e5q1.id).count(), 0, "跨 runA/runB 的全部 attempts 应被清空");
  assert.equal(await studyDb.questionProgress.get(e5q1.id), undefined, "全局统计应清除");
  assert.equal(await studyDb.questionDailyProgress.where("questionId").equals(e5q1.id).count(), 0, "每日统计应清除");
  const runAAfter = await getPracticeRun(runA.id);
  const runBAfter = await getPracticeRun(runB.id);
  assert.deepEqual(runAAfter?.questionIds, [e5q2.id], "runA 应被裁剪（行保留）");
  assert.deepEqual(runBAfter?.questionIds, [e5q2.id], "runB 应被裁剪（行保留）");
  console.log("S1.4 passed: 删题级联清空跨 run 全部 attempts（E5 全局清理语义）");
}

// S2.5 [E4] 删活动复习轮次中的题 → 该题已不在轮次目标集，in-flight 作答应被拒（特征化）。
// 活动轮次的目标集运行时按 bankIds 动态派生，删题后该题不再属于目标集。
{
  const e4Bank = await createBank("E4复习轮次");
  const e4q1 = await createQuestion(e4Bank.id, { type: "单选", stem: "E4轮次题一", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await createQuestion(e4Bank.id, { type: "单选", stem: "E4轮次题二", options: ["对", "错"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const e4Round = await createReviewRound({ name: "E4轮", bankIds: [e4Bank.id] });
  assert.ok((await getReviewRoundQuestionIds(e4Round.id)).includes(e4q1.id), "删前 q1 应在轮次目标集");
  const e4Run = await createPracticeRun({ bankIds: [e4Bank.id], questionIds: await getReviewRoundQuestionIds(e4Round.id), reviewRoundId: e4Round.id });
  await deleteQuestion(e4q1.id);
  assert.ok(!(await getReviewRoundQuestionIds(e4Round.id)).includes(e4q1.id), "删后 q1 不再属于轮次目标集");
  await assert.rejects(() => recordPracticeAnswer({ runId: e4Run.id, questionId: e4q1.id, selected: "A", correct: true, reviewRoundId: e4Round.id, elapsedMs: 10 }), /复习轮次|不属于|练习记录不包含当前题目/, "已删题的 in-flight 作答应被拒（删题已裁剪 run，作答无法落地）");
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
await putImageAsset(asset);
assert.equal(await getImageCacheSize(), blob.size);
assert.equal((await getImageAssetBlob(digest))?.size, blob.size);
assert.equal((await getImageAssetDescriptor(digest))?.blob, undefined);
await clearImageCache();
assert.equal(await getImageCacheSize(), 0);
assert.ok(await getImageAssetDescriptor(digest));

const oldCheck = new Dexie(OLD_NAME);
oldCheck.version(1).stores({ sentinel: "id" });
assert.deepEqual(await oldCheck.table("sentinel").get("keep"), { id: "keep", value: "untouched" });
await oldCheck.close();

// 往既有题库继续导入：目标库由调用方指定（不再从文件名派生），指纹去重、
// membership 追加排序、题库原名与计数语义全部沿用导入链。放在文件末尾——
// 前面的场景对全局 questions 计数敏感。
{
  const targetRows = [{ stem: "目标库已有题", type: "单选", options: ["甲", "乙"], answer: "A" }];
  const targetBank = await importQuestionBank("target-bank.json", targetRows);
  const bankCountBefore = await studyDb.banks.count();
  const questionCountBefore = await studyDb.questions.count();
  const targetImport = await importQuestionBank("more-questions.json", [
    targetRows[0], // 与目标库已有题内容一致 → 指纹去重，不计入 importedCount
    { stem: "目标库新增单选", type: "单选", options: ["甲", "乙"], answer: "A" },
    { stem: "目标库新增判断", type: "判断", options: ["正确", "错误"], answer: "A" },
  ], { targetBankId: targetBank.id });
  assert.equal(targetImport.id, targetBank.id, "目标导入不得派生新题库 id");
  assert.equal(targetImport.name, targetBank.name, "目标导入不得改动题库原名");
  assert.equal(targetImport.importedCount, 2, "重复指纹不计入新增计数");
  assert.equal((await studyDb.bankQuestionStats.get(targetImport.id))?.questionCount, 3, "题库计数刷新为 1（已有）+2（新增）");
  assert.equal(await studyDb.banks.count(), bankCountBefore, "目标导入不新建题库");
  assert.equal((await studyDb.questions.count()), questionCountBefore + 2, "全局只新增 2 道题（重复指纹复用）");
  const memberships = (await studyDb.bankQuestionMemberships.where("bankId").equals(targetBank.id).toArray()).sort((a, b) => a.sortOrder - b.sortOrder);
  assert.equal(memberships.length, 3);
  assert.deepEqual(memberships.map((item) => item.sortOrder), [0, 1, 2], "追加排序接在既有 membership 之后");
  const importEvent = await studyDb.changeSets.filter((record) => record.mutations.some((mutation) => mutation.kind === "question.import" && mutation.bank.id === targetBank.id && (mutation as { memberships?: unknown[] }).memberships?.length === 3)).last();
  assert.ok(importEvent, "目标导入应发出携带目标题库的 question.import 变更集");
  await assert.rejects(() => importQuestionBank("x.json", targetRows, { targetBankId: "bank_missing" }), /目标题库不存在/, "目标库被删时应明确报错");
}

// 多空计算题的标准答案与作答都按位置保存；相同数值不能被去重。
{
  const calculationBank = await createBank("多空计算题");
  const calculationQuestion = await createQuestion(calculationBank.id, {
    type: "计算",
    stem: "两个结果分别为【空1】和【空2】",
    options: [],
    solution: { kind: "calculation", blanks: [{ id: "blank-1", expected: 1 }, { id: "blank-2", expected: 1 }] },
  });
  assert.deepEqual(calculationQuestion.solution, { kind: "calculation", blanks: [{ id: "blank-1", expected: 1 }, { id: "blank-2", expected: 1 }] });
  const calculationRun = await createPracticeRun({ bankId: calculationBank.id, questionIds: [calculationQuestion.id] });
  const submitted = await recordPracticeAnswer({ runId: calculationRun.id, questionId: calculationQuestion.id, selected: ["1", "1"], correct: true, elapsedMs: 10 });
  assert.deepEqual(submitted.answer.selected, ["1", "1"], "重复数值必须保留为两个位置答案");
  assert.deepEqual((await getPracticeRun(calculationRun.id))?.answers[calculationQuestion.id]?.selected, ["1", "1"]);
}
await studyDb.delete();
console.log("database tests passed: namespace, joins, import, split, rounds, answers, deletion and image cache");
