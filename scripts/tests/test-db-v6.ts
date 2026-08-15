import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  clearImageCacheV6,
  createBankV6,
  createQuestionV6,
  createPracticeRunV6,
  createReviewRoundV6,
  dbV6,
  deleteBankFolderV6,
  deleteBankV6,
  deleteBankWithExclusiveQuestionsV6,
  deletePracticeRunV6,
  deleteQuestionGroupV6,
  deleteQuestionV6,
  deleteQuestionsV6,
  getBankQuestionsV6,
  getImageAssetBlobV6,
  getImageAssetDescriptorV6,
  getImageCacheSizeV6,
  getQuestionsForBanksV6,
  getReviewRoundQuestionIdsV6,
  importQuestionBankV6,
  putImageAssetV6,
  recordPracticeAnswerV6,
  removeMembershipV6,
  removeMembershipsV6,
  resetV6Database,
  reorderBanksV6,
  saveBankFolderV6,
  saveQuestionGroupV6,
  setPracticeRunStatusV6,
  splitQuestionV6,
  saveNoteV6,
  savePracticeProgressV6,
} from "../../lib/db-v6";
import { discardManagedChangeSetV7, ensureChangeSetQueueBaseV7 } from "../../lib/change-set-v7-queue";
import type { ImageAsset } from "../../lib/v6-types";
import { sha256Blob } from "../../lib/image-assets";

const OLD_NAME = "memory-line-study";
await Dexie.delete(OLD_NAME);
const oldSentinel = new Dexie(OLD_NAME);
oldSentinel.version(1).stores({ sentinel: "id" });
await oldSentinel.table("sentinel").put({ id: "keep", value: "untouched" });
await oldSentinel.close();

await resetV6Database();
await ensureChangeSetQueueBaseV7();
const queueTestBank = await createBankV6("队列级联测试");
await createQuestionV6(queueTestBank.id, { type: "单选", stem: "队列依赖题", options: ["A", "B"], answer: "A" });
const queueTestCreate = await dbV6.changeSets.filter((record) => record.mutations.some((mutation) => mutation.kind === "bank.create" && mutation.bank.id === queueTestBank.id)).first();
assert.ok(queueTestCreate);
await assert.rejects(() => discardManagedChangeSetV7(queueTestCreate.id), /依赖|同时删除/);
await discardManagedChangeSetV7(queueTestCreate.id, { cascadeDependents: true });
assert.equal(await dbV6.banks.get(queueTestBank.id), undefined, "discarding a creation rebuilds the local projection");
assert.equal(await dbV6.questions.count(), 0, "cascade discard removes dependent question creation");
assert.equal(await dbV6.changeSets.count(), 0, "cascade discard removes the complete dependent queue chain");
const source = [
  { q: "  Shared   stem\n", type: "单选", a: ["甲", "乙"], ans: "a", tags: ["共享"] },
  { q: "Only A", type: "判断", a: ["正确", "错误"], ans: "A" },
];
const importedA = await importQuestionBankV6("import-a.json", source);
const importedB = await importQuestionBankV6("import-b.json", [source[0]]);
assert.equal(importedA.questionCount, 2);
assert.equal(importedB.questionCount, 1);
const [shared] = await getQuestionsForBanksV6([importedA.id, importedB.id]);
assert.ok(shared);
assert.equal((await dbV6.questions.count()), 2, "shared content is globally deduplicated");
assert.equal((await getBankQuestionsV6(importedA.id)).length, 2);
assert.equal((await getBankQuestionsV6(importedB.id)).length, 1);

// Split copies editable content and note but not historical projections.
await saveNoteV6(shared.id, "解析");
const run = await createPracticeRunV6({ bankIds: [importedA.id], questionIds: [shared.id] });
await recordPracticeAnswerV6({ runId: run.id, questionId: shared.id, selected: ["A"], correct: false });
const split = await splitQuestionV6(shared.id, [importedA.id, importedB.id]);
assert.equal(split.clones.length, 1);
assert.equal((await getBankQuestionsV6(importedA.id)).find((item) => item.id === split.clones[0].id)?.id, split.clones[0].id);
assert.equal((await getBankQuestionsV6(importedB.id)).find((item) => item.id === split.clones[0].id)?.id, split.clones[0].id);
assert.equal((await dbV6.attemptStats.get(shared.id))?.total, 1);
assert.equal(await dbV6.attemptStats.get(split.clones[0].id), undefined);
assert.equal((await dbV6.notes.get(split.clones[0].id))?.content, "解析");

// Autosave still writes the latest note revision to the notes projection.
const secondNote = await saveNoteV6(shared.id, "解析 最终版");
assert.equal((await dbV6.notes.get(shared.id))?.content, "解析 最终版");
assert.equal((await dbV6.notes.get(shared.id))?.revision, secondNote.revision);

// Review target is dynamic while active and stable after completion.
const round = await createReviewRoundV6({ name: "round", bankIds: [importedA.id] });
const targetBefore = await getReviewRoundQuestionIdsV6(round.id);
assert.equal(targetBefore.length, 2);
const extra = await createQuestionV6(importedA.id, { type: "单选", stem: "dynamic", options: ["A", "B"], answer: "A" });
assert.equal((await getReviewRoundQuestionIdsV6(round.id)).length, 3);
const parallelRound = await createReviewRoundV6({ name: "parallel", bankIds: [importedA.id] });
const dynamicTargets = await getReviewRoundQuestionIdsV6(round.id);
const reviewRun = await createPracticeRunV6({ bankIds: [importedA.id], questionIds: dynamicTargets, reviewRoundId: round.id });
for (const questionId of dynamicTargets) {
  await recordPracticeAnswerV6({ runId: reviewRun.id, questionId, selected: ["A"], correct: true, reviewRoundId: round.id });
}
const completed = await dbV6.reviewRounds.get(round.id);
assert.equal(completed?.status, "completed", "all dynamic targets auto-complete the bound round");
assert.ok(completed?.finalQuestionIds?.length, "completed round captures its final target set");
assert.equal((await dbV6.reviewRounds.get(parallelRound.id))?.status, "active", "parallel round is not advanced");
const stableTarget = await getReviewRoundQuestionIdsV6(round.id);
await removeMembershipV6(importedA.id, extra.id);
assert.deepEqual(await getReviewRoundQuestionIdsV6(round.id), stableTarget);

// Submitting an answer writes the attempt/run projections; an ordinary run
// does not advance a parallel review round.
const cloneRun = await createPracticeRunV6({ bankIds: [importedA.id], questionIds: [split.clones[0].id] });
await assert.rejects(
  () => recordPracticeAnswerV6({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true, reviewRoundId: parallelRound.id }),
  /reviewRoundId/,
);
await recordPracticeAnswerV6({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true });
assert.equal((await dbV6.reviewRoundProgress.get(`${parallelRound.id}:${split.clones[0].id}`)), undefined, "ordinary run does not advance a round");
const changeSetsAfterAnswer = await dbV6.changeSets.count();
const progressedRun = (await dbV6.practiceRuns.get(cloneRun.id))!;
await savePracticeProgressV6({ ...progressedRun, lastAnsweredIndex: 0, revision: progressedRun.revision + 1, updatedAt: new Date().toISOString() });
assert.equal(await dbV6.changeSets.count(), changeSetsAfterAnswer, "navigation progress must not enqueue a new change-set");

// Local folder/group/status/run actions still write projection tables and
// tombstones directly through the change-set writer.
const localFolder = await saveBankFolderV6({ name: "本地文件夹", description: "说明" });
await reorderBanksV6([importedA.id, importedB.id], localFolder.id);
assert.equal((await dbV6.banks.get(importedA.id))?.folderId, localFolder.id);
assert.equal(await deleteBankFolderV6(localFolder.id), true);
assert.equal((await dbV6.banks.get(importedA.id))?.folderId, undefined);
assert.ok(await dbV6.tombstones.get(`bankFolder:${localFolder.id}`));

const localGroup = await saveQuestionGroupV6({ name: "本地题组", type: "专题", description: "", items: [{ questionId: split.clones[0].id, note: "对照" }] });
assert.equal((await dbV6.questionGroups.get(localGroup.id))?.items.length, 1);
assert.equal(await deleteQuestionGroupV6(localGroup.id), true);
assert.ok(await dbV6.tombstones.get(`questionGroup:${localGroup.id}`));
const abandoned = await setPracticeRunStatusV6(cloneRun.id, "abandoned");
assert.equal(abandoned?.status, "abandoned");
const cloneStatsBeforeRunDelete = (await dbV6.attemptStats.get(split.clones[0].id))?.total;
assert.equal(await deletePracticeRunV6(cloneRun.id), true);
assert.equal(await dbV6.practiceRuns.get(cloneRun.id), undefined);
assert.equal((await dbV6.attemptStats.get(split.clones[0].id))?.total, cloneStatsBeforeRunDelete, "deleting a run keeps global learning stats");
assert.ok(await dbV6.tombstones.get(`practiceRun:${cloneRun.id}`), "deleting a submitted run writes a tombstone");

// Deleting a bank removes only joins, while global deletion clears history.
await deleteBankV6(importedB.id);
assert.equal(await dbV6.questions.count(), 4);
assert.equal(await dbV6.attempts.count(), 5);
await deleteQuestionV6(shared.id);
assert.equal(await dbV6.attempts.where("questionId").equals(shared.id).count(), 0);
assert.equal(await dbV6.attemptStats.get(shared.id), undefined);

// Batch cleanup removes selected joins/content, and deleting a bank can clean
// only its exclusive questions without damaging shared content.
const cleanupSource = [
  { q: "批量独占一", type: "单选", a: ["甲", "乙"], ans: "A" },
  { q: "批量独占二", type: "单选", a: ["甲", "乙"], ans: "A" },
  { q: "批量共享", type: "单选", a: ["甲", "乙"], ans: "A" },
];
const cleanupA = await importQuestionBankV6("cleanup-a.json", cleanupSource);
const cleanupB = await importQuestionBankV6("cleanup-b.json", [cleanupSource[2]]);
const cleanupQuestions = await getBankQuestionsV6(cleanupA.id);
const sharedCleanup = cleanupQuestions.find((question) => question.content[0]?.type === "text" && question.content[0].text === "批量共享")!;
const exclusiveCleanupIds = cleanupQuestions.filter((question) => question.id !== sharedCleanup.id).map((question) => question.id);
const bankCleanup = await deleteBankWithExclusiveQuestionsV6(cleanupA.id);
assert.deepEqual(bankCleanup, { bankDeleted: true, deletedQuestions: 2 });
assert.equal(await dbV6.banks.get(cleanupA.id), undefined);
assert.equal((await dbV6.questions.bulkGet(exclusiveCleanupIds)).filter(Boolean).length, 0);
assert.ok(await dbV6.questions.get(sharedCleanup.id), "shared question must survive bank cleanup");
assert.equal((await getBankQuestionsV6(cleanupB.id)).length, 1);

const detachBank = await importQuestionBankV6("batch-detach.json", [
  { q: "批量移除一", type: "判断", a: ["正确", "错误"], ans: "A" },
  { q: "批量移除二", type: "判断", a: ["正确", "错误"], ans: "B" },
]);
const detachIds = (await getBankQuestionsV6(detachBank.id)).map((question) => question.id);
assert.equal(await removeMembershipsV6(detachBank.id, detachIds), 2);
assert.equal((await getBankQuestionsV6(detachBank.id)).length, 0);
assert.equal((await dbV6.questions.bulkGet(detachIds)).filter(Boolean).length, 2, "batch detach must keep global content");
assert.equal(await deleteQuestionsV6(detachIds), 2);
assert.equal((await dbV6.questions.bulkGet(detachIds)).filter(Boolean).length, 0);

// S1.2 [R4] savePracticeProgress 读后写竞争：被 deleteQuestionsV6 裁剪后回写陈旧快照，
// 不得把已删题目塞回 run（复活）。修复后以 DB 当前的 questionIds 为准，并丢弃指向已删题的作答。
{
  const r4Bank = await createBankV6("R4竞争测试");
  const r4q1 = await createQuestionV6(r4Bank.id, { type: "单选", stem: "R4题一", options: ["对", "错"], answer: "A" });
  const r4q2 = await createQuestionV6(r4Bank.id, { type: "单选", stem: "R4题二", options: ["对", "错"], answer: "A" });
  const r4Run = await createPracticeRunV6({ bankId: r4Bank.id, questionIds: [r4q1.id, r4q2.id] });
  await recordPracticeAnswerV6({ runId: r4Run.id, questionId: r4q1.id, selected: "A", correct: true });
  // 模拟 study-app 保存前读到的陈旧快照（含 q1、q1 的答案）
  const staleSnapshot = await dbV6.practiceRuns.get(r4Run.id);
  assert.ok(staleSnapshot && staleSnapshot.questionIds.includes(r4q1.id));
  // 另一处并发删除 q1：run 被裁剪为 [q2]，answers 中 q1 被移除
  await deleteQuestionV6(r4q1.id);
  const trimmed = await dbV6.practiceRuns.get(r4Run.id);
  assert.deepEqual(trimmed?.questionIds, [r4q2.id], "删除后 run 应已裁剪");
  // 现在用陈旧快照调用 savePracticeProgressV6（模拟保存与删除交错的窗口）
  await savePracticeProgressV6({ ...staleSnapshot!, answers: { [r4q1.id]: { selected: ["A"], correct: true, submitted: true, updatedAt: staleSnapshot!.updatedAt, deviceId: staleSnapshot!.deviceId, eventId: "evt-r4" } }, lastAnsweredIndex: 0, updatedAt: new Date().toISOString(), revision: staleSnapshot!.revision + 1 });
  const after = await dbV6.practiceRuns.get(r4Run.id);
  assert.ok(after, "run 行应保留");
  assert.deepEqual(after.questionIds, [r4q2.id], "已删题 q1 不得被陈旧保存复活回 run");
  assert.ok(!after.answers[r4q1.id], "指向已删题的陈旧作答应被丢弃");
  assert.equal(after.revision, (trimmed?.revision ?? 0) + 1, "revision 应基于 DB 当前值自增");
  console.log("S1.2 passed: savePracticeProgress 读后写竞争不再复活已删题（R4）");
}

// S1.4 [E5] 删题级联清空该题跨所有历史 run 的 attempts（全局清理语义，非按 run 隔离）。
{
  const e5Bank = await createBankV6("E5跨run清理");
  const e5q1 = await createQuestionV6(e5Bank.id, { type: "单选", stem: "E5共享题", options: ["对", "错"], answer: "A" });
  const e5q2 = await createQuestionV6(e5Bank.id, { type: "单选", stem: "E5陪跑题", options: ["对", "错"], answer: "A" });
  const runA = await createPracticeRunV6({ bankId: e5Bank.id, questionIds: [e5q1.id, e5q2.id] });
  const runB = await createPracticeRunV6({ bankId: e5Bank.id, questionIds: [e5q1.id, e5q2.id] });
  await recordPracticeAnswerV6({ runId: runA.id, questionId: e5q1.id, selected: "A", correct: true });
  await recordPracticeAnswerV6({ runId: runB.id, questionId: e5q1.id, selected: "B", correct: false });
  assert.ok((await dbV6.attemptStats.get(e5q1.id))?.total, "删前应有全局统计");
  assert.equal(await dbV6.attempts.where("questionId").equals(e5q1.id).count(), 2, "删前两条 run 各有一条作答");
  await deleteQuestionV6(e5q1.id);
  assert.equal(await dbV6.attempts.where("questionId").equals(e5q1.id).count(), 0, "跨 runA/runB 的全部 attempts 应被清空");
  assert.equal(await dbV6.attemptStats.get(e5q1.id), undefined, "全局统计应清除");
  assert.equal(await dbV6.attemptDailyStats.where("questionId").equals(e5q1.id).count(), 0, "每日统计应清除");
  const runAAfter = await dbV6.practiceRuns.get(runA.id);
  const runBAfter = await dbV6.practiceRuns.get(runB.id);
  assert.deepEqual(runAAfter?.questionIds, [e5q2.id], "runA 应被裁剪（行保留）");
  assert.deepEqual(runBAfter?.questionIds, [e5q2.id], "runB 应被裁剪（行保留）");
  console.log("S1.4 passed: 删题级联清空跨 run 全部 attempts（E5 全局清理语义）");
}

// S2.5 [E4] 删活动复习轮次中的题 → 该题已不在轮次目标集，in-flight 作答应被拒（特征化）。
// 活动轮次的目标集运行时按 bankIds 动态派生，删题后该题不再属于目标集。
{
  const e4Bank = await createBankV6("E4复习轮次");
  const e4q1 = await createQuestionV6(e4Bank.id, { type: "单选", stem: "E4轮次题一", options: ["对", "错"], answer: "A" });
  await createQuestionV6(e4Bank.id, { type: "单选", stem: "E4轮次题二", options: ["对", "错"], answer: "A" });
  const e4Round = await createReviewRoundV6({ name: "E4轮", bankIds: [e4Bank.id] });
  assert.ok((await getReviewRoundQuestionIdsV6(e4Round.id)).includes(e4q1.id), "删前 q1 应在轮次目标集");
  const e4Run = await createPracticeRunV6({ bankIds: [e4Bank.id], questionIds: await getReviewRoundQuestionIdsV6(e4Round.id), reviewRoundId: e4Round.id });
  await deleteQuestionV6(e4q1.id);
  assert.ok(!(await getReviewRoundQuestionIdsV6(e4Round.id)).includes(e4q1.id), "删后 q1 不再属于轮次目标集");
  await assert.rejects(() => recordPracticeAnswerV6({ runId: e4Run.id, questionId: e4q1.id, selected: "A", correct: true, reviewRoundId: e4Round.id }), /复习轮次|不属于|练习记录不包含当前题目/, "已删题的 in-flight 作答应被拒（删题已裁剪 run，作答无法落地）");
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
  remote: { path: `sync/v6/assets/${digest}.png`, blobSha: "a".repeat(40), sha256: digest, size: blob.size },
  blob,
};
await putImageAssetV6(asset);
assert.equal(await getImageCacheSizeV6(), blob.size);
assert.equal((await getImageAssetBlobV6(digest))?.size, blob.size);
assert.equal((await getImageAssetDescriptorV6(digest))?.blob, undefined);
await clearImageCacheV6();
assert.equal(await getImageCacheSizeV6(), 0);
assert.ok(await getImageAssetDescriptorV6(digest));

const oldCheck = new Dexie(OLD_NAME);
oldCheck.version(1).stores({ sentinel: "id" });
assert.deepEqual(await oldCheck.table("sentinel").get("keep"), { id: "keep", value: "untouched" });
await oldCheck.close();
await dbV6.delete();
console.log("v6 database tests passed: namespace, joins, import, split, rounds, answers, deletion and image cache");
