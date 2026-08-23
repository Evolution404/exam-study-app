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
await createQuestionV7(queueTestBank.id, { type: "单选", stem: "队列依赖题", options: ["A", "B"], answer: "A" });
const queueTestCreate = await dbV7.changeSets.filter((record) => record.mutations.some((mutation) => mutation.kind === "bank.create" && mutation.bank.id === queueTestBank.id)).first();
assert.ok(queueTestCreate);
await assert.rejects(() => discardManagedChangeSetV7(queueTestCreate.id), /依赖|同时删除/);
await discardManagedChangeSetV7(queueTestCreate.id, { cascadeDependents: true });
assert.equal(await dbV7.banks.get(queueTestBank.id), undefined, "discarding a creation rebuilds the local projection");
assert.equal(await dbV7.questions.count(), 0, "cascade discard removes dependent question creation");
assert.equal(await dbV7.changeSets.count(), 0, "cascade discard removes the complete dependent queue chain");
const source = [
  { q: "  Shared   stem\n", type: "单选", a: ["甲", "乙"], ans: "a", tags: ["共享"] },
  { q: "Only A", type: "判断", a: ["正确", "错误"], ans: "A" },
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
await recordPracticeAnswerV7({ runId: run.id, questionId: shared.id, selected: ["A"], correct: false });
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
const extra = await createQuestionV7(importedA.id, { type: "单选", stem: "dynamic", options: ["A", "B"], answer: "A" });
assert.equal((await getReviewRoundQuestionIdsV7(round.id)).length, 3);
const parallelRound = await createReviewRoundV7({ name: "parallel", bankIds: [importedA.id] });
const dynamicTargets = await getReviewRoundQuestionIdsV7(round.id);
const reviewRun = await createPracticeRunV7({ bankIds: [importedA.id], questionIds: dynamicTargets, reviewRoundId: round.id });
for (const questionId of dynamicTargets) {
  await recordPracticeAnswerV7({ runId: reviewRun.id, questionId, selected: ["A"], correct: true, reviewRoundId: round.id });
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
  () => recordPracticeAnswerV7({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true, reviewRoundId: parallelRound.id }),
  /reviewRoundId/,
);
await recordPracticeAnswerV7({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true });
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
  { q: "批量独占一", type: "单选", a: ["甲", "乙"], ans: "A" },
  { q: "批量独占二", type: "单选", a: ["甲", "乙"], ans: "A" },
  { q: "批量共享", type: "单选", a: ["甲", "乙"], ans: "A" },
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
  { q: "批量移除一", type: "判断", a: ["正确", "错误"], ans: "A" },
  { q: "批量移除二", type: "判断", a: ["正确", "错误"], ans: "B" },
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
  const r4q1 = await createQuestionV7(r4Bank.id, { type: "单选", stem: "R4题一", options: ["对", "错"], answer: "A" });
  const r4q2 = await createQuestionV7(r4Bank.id, { type: "单选", stem: "R4题二", options: ["对", "错"], answer: "A" });
  const r4Run = await createPracticeRunV7({ bankId: r4Bank.id, questionIds: [r4q1.id, r4q2.id] });
  await recordPracticeAnswerV7({ runId: r4Run.id, questionId: r4q1.id, selected: "A", correct: true });
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

// S1.4 [E5] 删题级联清空该题跨所有历史 run 的 attempts（全局清理语义，非按 run 隔离）。
{
  const e5Bank = await createBankV7("E5跨run清理");
  const e5q1 = await createQuestionV7(e5Bank.id, { type: "单选", stem: "E5共享题", options: ["对", "错"], answer: "A" });
  const e5q2 = await createQuestionV7(e5Bank.id, { type: "单选", stem: "E5陪跑题", options: ["对", "错"], answer: "A" });
  const runA = await createPracticeRunV7({ bankId: e5Bank.id, questionIds: [e5q1.id, e5q2.id] });
  const runB = await createPracticeRunV7({ bankId: e5Bank.id, questionIds: [e5q1.id, e5q2.id] });
  await recordPracticeAnswerV7({ runId: runA.id, questionId: e5q1.id, selected: "A", correct: true });
  await recordPracticeAnswerV7({ runId: runB.id, questionId: e5q1.id, selected: "B", correct: false });
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
  const e4q1 = await createQuestionV7(e4Bank.id, { type: "单选", stem: "E4轮次题一", options: ["对", "错"], answer: "A" });
  await createQuestionV7(e4Bank.id, { type: "单选", stem: "E4轮次题二", options: ["对", "错"], answer: "A" });
  const e4Round = await createReviewRoundV7({ name: "E4轮", bankIds: [e4Bank.id] });
  assert.ok((await getReviewRoundQuestionIdsV7(e4Round.id)).includes(e4q1.id), "删前 q1 应在轮次目标集");
  const e4Run = await createPracticeRunV7({ bankIds: [e4Bank.id], questionIds: await getReviewRoundQuestionIdsV7(e4Round.id), reviewRoundId: e4Round.id });
  await deleteQuestionV7(e4q1.id);
  assert.ok(!(await getReviewRoundQuestionIdsV7(e4Round.id)).includes(e4q1.id), "删后 q1 不再属于轮次目标集");
  await assert.rejects(() => recordPracticeAnswerV7({ runId: e4Run.id, questionId: e4q1.id, selected: "A", correct: true, reviewRoundId: e4Round.id }), /复习轮次|不属于|练习记录不包含当前题目/, "已删题的 in-flight 作答应被拒（删题已裁剪 run，作答无法落地）");
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
  const targetRows = [{ q: "目标库已有题", type: "单选", a: ["甲", "乙"], ans: "A" }];
  const targetBank = await importQuestionBankV7("target-bank.json", targetRows);
  const bankCountBefore = await dbV7.banks.count();
  const questionCountBefore = await dbV7.questions.count();
  const targetImport = await importQuestionBankV7("more-questions.json", [
    targetRows[0], // 与目标库已有题内容一致 → 指纹去重，不计入 importedCount
    { q: "目标库新增单选", type: "单选", a: ["甲", "乙"], ans: "A" },
    { q: "目标库新增判断", type: "判断", a: ["正确", "错误"], ans: "A" },
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
    answer: ["1", "1"],
  });
  assert.equal(calculationQuestion.answer, "1\n1");
  const calculationRun = await createPracticeRunV7({ bankId: calculationBank.id, questionIds: [calculationQuestion.id] });
  const submitted = await recordPracticeAnswerV7({ runId: calculationRun.id, questionId: calculationQuestion.id, selected: ["1", "1"], correct: true });
  assert.deepEqual(submitted.answer.selected, ["1", "1"], "重复数值必须保留为两个位置答案");
  assert.deepEqual((await dbV7.practiceRuns.get(calculationRun.id))?.answers[calculationQuestion.id]?.selected, ["1", "1"]);
}
await dbV7.delete();
console.log("v7 database tests passed: namespace, joins, import, split, rounds, answers, deletion and image cache");
