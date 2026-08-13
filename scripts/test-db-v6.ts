import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  clearImageCacheV6,
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
  getImageAssetV6,
  getImageCacheSizeV6,
  getQuestionsForBanksV6,
  getReviewRoundQuestionIdsV6,
  importQuestionBankV6,
  applyV6Event,
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
} from "../lib/db-v6";
import type { BankFolderV6, BankQuestionMembership, BankV6, ImageAsset, NoteV6, QuestionGroupV6, QuestionV6, V6Event } from "../lib/v6-types";
import { sha256Blob } from "../lib/image-assets";

const OLD_NAME = "memory-line-study";
await Dexie.delete(OLD_NAME);
const oldSentinel = new Dexie(OLD_NAME);
oldSentinel.version(1).stores({ sentinel: "id" });
await oldSentinel.table("sentinel").put({ id: "keep", value: "untouched" });
await oldSentinel.close();

await resetV6Database();
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
assert.equal((await dbV6.events.where("type").equals("question.upserted").count()), 3);
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

// A split is one atomic event and its remote reducer is idempotent.
const splitEvent = await dbV6.events.where("type").equals("question.split").first();
assert.ok(splitEvent);
const splitPayload = splitEvent.payload as { clone: { id: string }; memberships: BankQuestionMembership[] };
await dbV6.events.delete(splitEvent.id);
await dbV6.questions.delete(splitPayload.clone.id);
await dbV6.bankQuestionMemberships.where("questionId").equals(splitPayload.clone.id).delete();
await dbV6.notes.delete(splitPayload.clone.id);
assert.equal(await applyV6Event(splitEvent), true);
assert.equal(await applyV6Event(splitEvent), false);
assert.equal((await dbV6.questions.where("id").equals(splitPayload.clone.id).count()), 1);
assert.equal((await dbV6.bankQuestionMemberships.where("questionId").equals(splitPayload.clone.id).count()), 2);
assert.equal((await dbV6.notes.get(splitPayload.clone.id))?.content, "解析");
assert.equal((await dbV6.attemptStats.get(splitPayload.clone.id)), undefined, "split clone starts without history");

// A newer removal blocks an older remote save, while a newer save can restore.
const lwwMembership = (await dbV6.bankQuestionMemberships.where("questionId").equals(splitPayload.clone.id).first())!;
const removal: V6Event = {
  id: "remote-membership-remove",
  type: "membership.removed",
  payload: lwwMembership,
  deviceId: "remote-z",
  sequence: 10,
  createdAt: "2099-01-01T00:00:00.000Z",
  synced: 1,
};
assert.equal(await applyV6Event(removal), true);
const staleSave: V6Event = { ...removal, id: "remote-membership-stale-save", type: "membership.saved", payload: { ...lwwMembership, updatedAt: "2000-01-01T00:00:00.000Z" }, createdAt: "2000-01-01T00:00:00.000Z" };
assert.equal(await applyV6Event(staleSave), true);
assert.equal(await dbV6.bankQuestionMemberships.get(lwwMembership.key), undefined);
const freshSave: V6Event = { ...removal, id: "remote-membership-fresh-save", type: "membership.saved", payload: { ...lwwMembership, updatedAt: "2100-01-01T00:00:00.000Z" }, createdAt: "2100-01-01T00:00:00.000Z" };
assert.equal(await applyV6Event(freshSave), true);
assert.ok(await dbV6.bankQuestionMemberships.get(lwwMembership.key));

// Autosave dedup: repeated edits of the same question collapse into one
// pending event (last content wins) until the batch is published.
const pendingNoteEvents = (questionId: string) => dbV6.events.where("type").equals("note.upserted").filter((event) => event.synced === 0 && (event.payload as NoteV6).questionId === questionId);
assert.equal(await pendingNoteEvents(shared.id).count(), 1, "existing pending note event");
const firstNoteEventId = (await pendingNoteEvents(shared.id).first())!.id;
const secondNote = await saveNoteV6(shared.id, "解析 最终版");
await saveNoteV6(shared.id, "解析 最终版 v2");
assert.equal(await pendingNoteEvents(shared.id).count(), 1, "repeated autosaves keep one pending event");
const mergedNoteEvent = (await pendingNoteEvents(shared.id).first())!;
assert.equal(mergedNoteEvent.id, firstNoteEventId, "merged event keeps its id and sequence");
assert.equal((mergedNoteEvent.payload as NoteV6).content, "解析 最终版 v2", "merged event carries the latest content");
assert.equal((mergedNoteEvent.payload as NoteV6).revision, secondNote.revision + 1, "merged event carries the latest revision");
const otherQuestionId = (await getBankQuestionsV6(importedB.id))[0].id;
assert.notEqual(otherQuestionId, shared.id);
const pendingNoteCountBefore = await dbV6.events.where("type").equals("note.upserted").filter((event) => event.synced === 0).count();
await saveNoteV6(otherQuestionId, "另一道题的解析");
assert.equal(await dbV6.events.where("type").equals("note.upserted").filter((event) => event.synced === 0).count(), pendingNoteCountBefore + 1, "different questions keep separate events");
// A published event is never merged again: the next edit starts a fresh event.
await dbV6.events.put({ ...mergedNoteEvent, synced: 1 as const });
await saveNoteV6(shared.id, "同步后的新编辑");
assert.equal(await pendingNoteEvents(shared.id).count(), 1);
const freshNoteEvent = (await pendingNoteEvents(shared.id).first())!;
assert.notEqual(freshNoteEvent.id, mergedNoteEvent.id, "post-sync edits create a new pending event");

// Review target is dynamic while active and stable after completion.
const round = await createReviewRoundV6({ name: "round", bankIds: [importedA.id] });
const targetBefore = await getReviewRoundQuestionIdsV6(round.id);
assert.equal(targetBefore.length, 2);
const extra = await createQuestionV6(importedA.id, { type: "单选", stem: "dynamic", options: ["A", "B"], answer: "A" });
assert.equal((await getReviewRoundQuestionIdsV6(round.id)).length, 3);
const parallelRound = await createReviewRoundV6({ name: "parallel", bankIds: [importedA.id] });
const dynamicTargets = await getReviewRoundQuestionIdsV6(round.id);
const reviewRun = await createPracticeRunV6({ bankIds: [importedA.id], questionIds: dynamicTargets, reviewRoundId: round.id });
const completedEventCountBefore = await dbV6.events.where("type").equals("review.round.completed").count();
for (const questionId of dynamicTargets) {
  await recordPracticeAnswerV6({ runId: reviewRun.id, questionId, selected: ["A"], correct: true, reviewRoundId: round.id });
}
const completed = await dbV6.reviewRounds.get(round.id);
assert.equal(completed?.status, "completed", "all dynamic targets auto-complete the bound round");
assert.equal(await dbV6.events.where("type").equals("review.round.completed").count(), completedEventCountBefore + 1);
const completionEvent = await dbV6.events.where("type").equals("review.round.completed").last();
assert.deepEqual((completionEvent?.payload as { finalQuestionIds?: string[] }).finalQuestionIds, completed?.finalQuestionIds);
assert.equal((await dbV6.reviewRounds.get(parallelRound.id))?.status, "active", "parallel round is not advanced");
const stableTarget = await getReviewRoundQuestionIdsV6(round.id);
await removeMembershipV6(importedA.id, extra.id);
assert.deepEqual(await getReviewRoundQuestionIdsV6(round.id), stableTarget);

// One answer creates one submitted event; applying it twice is idempotent.
const beforeEvents = await dbV6.events.where("type").equals("practice.answer.submitted").count();
const cloneRun = await createPracticeRunV6({ bankIds: [importedA.id], questionIds: [split.clones[0].id] });
await assert.rejects(
  () => recordPracticeAnswerV6({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true, reviewRoundId: parallelRound.id }),
  /reviewRoundId/,
);
const answerResult = await recordPracticeAnswerV6({ runId: cloneRun.id, questionId: split.clones[0].id, selected: ["A"], correct: true });
assert.equal(await dbV6.events.where("type").equals("practice.answer.submitted").count(), beforeEvents + 1);
assert.equal(await applyV6Event(answerResult.event), false);
assert.equal((await dbV6.reviewRoundProgress.get(`${parallelRound.id}:${split.clones[0].id}`)), undefined, "ordinary run does not advance a round");
const eventCountAfterAnswer = await dbV6.events.count();
const progressedRun = (await dbV6.practiceRuns.get(cloneRun.id))!;
await savePracticeProgressV6({ ...progressedRun, lastAnsweredIndex: 0, revision: progressedRun.revision + 1, updatedAt: new Date().toISOString() });
assert.equal(await dbV6.events.count(), eventCountAfterAnswer, "navigation progress must not emit a second run event");

// Local folder/group/status actions must emit syncable v6 events instead of
// letting pages write projection tables directly.
const localFolder = await saveBankFolderV6({ name: "本地文件夹", description: "说明" });
await reorderBanksV6([importedA.id, importedB.id], localFolder.id);
assert.equal((await dbV6.banks.get(importedA.id))?.folderId, localFolder.id);
assert.ok(await dbV6.events.where("type").equals("bankFolder.saved").first());
assert.equal(await deleteBankFolderV6(localFolder.id), true);
assert.equal((await dbV6.banks.get(importedA.id))?.folderId, undefined);
assert.ok(await dbV6.tombstones.get(`bankFolder:${localFolder.id}`));

const localGroup = await saveQuestionGroupV6({ name: "本地题组", type: "专题", description: "", items: [{ questionId: split.clones[0].id, note: "对照" }] });
assert.equal((await dbV6.questionGroups.get(localGroup.id))?.items.length, 1);
assert.equal(await deleteQuestionGroupV6(localGroup.id), true);
assert.ok(await dbV6.tombstones.get(`questionGroup:${localGroup.id}`));
const abandoned = await setPracticeRunStatusV6(cloneRun.id, "abandoned");
assert.equal(abandoned?.status, "abandoned");
assert.ok(await dbV6.events.where("type").equals("practice.run.status.changed").first());
const cloneStatsBeforeRunDelete = (await dbV6.attemptStats.get(split.clones[0].id))?.total;
assert.equal(await deletePracticeRunV6(cloneRun.id), true);
assert.equal(await dbV6.practiceRuns.get(cloneRun.id), undefined);
assert.equal((await dbV6.attemptStats.get(split.clones[0].id))?.total, cloneStatsBeforeRunDelete, "deleting a run keeps global learning stats");
assert.ok(await dbV6.events.where("type").equals("practice.run.deleted").first());
const staleRun = { ...cloneRun, updatedAt: "2000-01-01T00:00:00.000Z", deviceId: "remote" };
assert.equal(await applyV6Event({ id: "run-stale-save", type: "practice.run.saved", payload: staleRun, deviceId: "remote", sequence: 99, createdAt: staleRun.updatedAt, synced: 1 }), true);
assert.equal(await dbV6.practiceRuns.get(cloneRun.id), undefined, "stale run save must not cross a newer deletion tombstone");

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

// Remote folder/group reducers use LWW tombstones instead of silently
// dropping entities.  A stale save cannot resurrect a newer deletion.
const folder: BankFolderV6 = { id: "remote-folder", name: "远端文件夹", description: "", sortOrder: 0, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z", deviceId: "remote" };
const folderSaved: V6Event = { id: "folder-save", type: "bankFolder.saved", payload: folder, deviceId: "remote", sequence: 1, createdAt: folder.updatedAt, synced: 1 };
assert.equal(await applyV6Event(folderSaved), true);
assert.equal((await dbV6.bankFolders.get(folder.id))?.name, "远端文件夹");
const folderDeleted: V6Event = { id: "folder-delete", type: "bankFolder.deleted", payload: { id: folder.id, deletedAt: "2030-01-01T00:00:00.000Z" }, deviceId: "remote", sequence: 2, createdAt: "2030-01-01T00:00:00.000Z", synced: 1 };
assert.equal(await applyV6Event(folderDeleted), true);
assert.equal(await dbV6.bankFolders.get(folder.id), undefined);
const folderStaleSave: V6Event = { ...folderSaved, id: "folder-stale-save", payload: { ...folder, name: "不应复活" } };
assert.equal(await applyV6Event(folderStaleSave), true);
assert.equal(await dbV6.bankFolders.get(folder.id), undefined);

const group: QuestionGroupV6 = { id: "remote-group", name: "分组", type: "专题", description: "", items: [], createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z", deviceId: "remote" };
assert.equal(await applyV6Event({ id: "group-save", type: "questionGroup.saved", payload: group, deviceId: "remote", sequence: 3, createdAt: group.updatedAt, synced: 1 }), true);
assert.equal((await dbV6.questionGroups.get(group.id))?.name, "分组");
assert.equal(await applyV6Event({ id: "group-delete", type: "questionGroup.deleted", payload: { id: group.id, deletedAt: "2030-01-01T00:00:00.000Z" }, deviceId: "remote", sequence: 4, createdAt: "2030-01-01T00:00:00.000Z", synced: 1 }), true);
assert.equal(await dbV6.questionGroups.get(group.id), undefined);
assert.equal(await applyV6Event({ id: "group-stale-save", type: "questionGroup.saved", payload: group, deviceId: "remote", sequence: 5, createdAt: group.updatedAt, synced: 1 }), true);
assert.equal(await dbV6.questionGroups.get(group.id), undefined);

// A remote descriptor updates metadata but never evicts an existing local
// blob.  Blob SHA is the protocol's strict 40-character Git SHA-1.
const remoteDescriptor: ImageAsset = { ...asset, blob: undefined, remote: { ...asset.remote!, path: "sync/v6/assets/remote.png" } };
assert.equal(await putImageAssetV6(asset), asset);
assert.equal(await applyV6Event({ id: "asset-remote-save", type: "image.asset.saved", payload: remoteDescriptor, deviceId: "remote", sequence: 6, createdAt: "2040-01-01T00:00:00.000Z", synced: 1 }), true);
assert.equal((await getImageAssetBlobV6(digest))?.size, blob.size);
assert.equal((await getImageAssetDescriptorV6(digest))?.remote?.path, "sync/v6/assets/remote.png");
await assert.rejects(() => putImageAssetV6({ ...asset, remote: { ...asset.remote!, blobSha: "a".repeat(41) } }), /blobSha/);
await assert.rejects(() => putImageAssetV6({ ...asset, remote: { ...asset.remote!, blobSha: "a".repeat(64) } }), /blobSha/);
assert.equal(await applyV6Event({ id: "asset-remote-delete", type: "image.asset.deleted", payload: { id: digest, deletedAt: "2050-01-01T00:00:00.000Z" }, deviceId: "remote", sequence: 7, createdAt: "2050-01-01T00:00:00.000Z", synced: 1 }), true);
assert.equal(await getImageAssetV6(digest), undefined);
assert.equal(await applyV6Event({ id: "asset-stale-save", type: "image.asset.saved", payload: remoteDescriptor, deviceId: "remote", sequence: 8, createdAt: "2040-01-01T00:00:00.000Z", synced: 1 }), true);
assert.equal(await getImageAssetV6(digest), undefined);

// Bank/question entity tombstones use the same deterministic clock rules as
// folders and groups. A remote global deletion also removes every learning
// projection, including group membership and practice-run answers.
const conflictBank: BankV6 = {
  ...importedA,
  id: "conflict-bank",
  name: "冲突题库",
  importedAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
  deviceId: "remote",
};
assert.equal(await applyV6Event({ id: "bank-conflict-save", type: "bank.created", payload: conflictBank, deviceId: "remote", sequence: 9, createdAt: conflictBank.updatedAt, synced: 1 }), true);
assert.equal(await applyV6Event({ id: "bank-conflict-delete", type: "bank.deleted", payload: { id: conflictBank.id, deletedAt: "2030-01-01T00:00:00.000Z" }, deviceId: "remote", sequence: 10, createdAt: "2030-01-01T00:00:00.000Z", synced: 1 }), true);
assert.equal(await applyV6Event({ id: "bank-conflict-stale-save", type: "bank.updated", payload: conflictBank, deviceId: "remote", sequence: 11, createdAt: conflictBank.updatedAt, synced: 1 }), true);
assert.equal(await dbV6.banks.get(conflictBank.id), undefined, "stale bank update must not cross a newer tombstone");

const conflictQuestion: QuestionV6 = {
  ...extra,
  id: "conflict-question",
  contentFingerprint: "f".repeat(64),
  updatedAt: "2020-01-01T00:00:00.000Z",
  deviceId: "remote",
};
assert.equal(await applyV6Event({ id: "question-conflict-save", type: "question.upserted", payload: conflictQuestion, deviceId: "remote", sequence: 12, createdAt: conflictQuestion.updatedAt, synced: 1 }), true);
const conflictMembership: BankQuestionMembership = {
  key: `${importedA.id}:${conflictQuestion.id}`,
  bankId: importedA.id,
  questionId: conflictQuestion.id,
  sortOrder: 999,
  addedAt: conflictQuestion.updatedAt,
  updatedAt: conflictQuestion.updatedAt,
  deviceId: "remote",
};
assert.equal(await applyV6Event({ id: "question-conflict-member", type: "membership.saved", payload: conflictMembership, deviceId: "remote", sequence: 13, createdAt: conflictMembership.updatedAt, synced: 1 }), true);
const conflictRun = await createPracticeRunV6({ bankIds: [importedA.id], questionIds: [conflictQuestion.id] });
await recordPracticeAnswerV6({ runId: conflictRun.id, questionId: conflictQuestion.id, selected: ["A"], correct: true });
const conflictGroup = await saveQuestionGroupV6({ name: "待全局删除", type: "专题", description: "", items: [{ questionId: conflictQuestion.id, note: "" }] });
assert.equal(await applyV6Event({ id: "question-conflict-delete", type: "question.deleted", payload: { id: conflictQuestion.id, deletedAt: "2030-01-01T00:00:00.000Z" }, deviceId: "remote", sequence: 14, createdAt: "2030-01-01T00:00:00.000Z", synced: 1 }), true);
assert.equal(await dbV6.questions.get(conflictQuestion.id), undefined);
assert.equal(await dbV6.attemptStats.get(conflictQuestion.id), undefined);
assert.equal(await dbV6.questionGroups.get(conflictGroup.id), undefined);
assert.deepEqual((await dbV6.practiceRuns.get(conflictRun.id))?.questionIds, []);
assert.equal(await applyV6Event({ id: "question-conflict-stale-save", type: "question.upserted", payload: conflictQuestion, deviceId: "remote", sequence: 15, createdAt: conflictQuestion.updatedAt, synced: 1 }), true);
assert.equal(await dbV6.questions.get(conflictQuestion.id), undefined, "stale question update must not cross a newer tombstone");

const orphanMembership = { ...conflictMembership, key: `missing-bank:${extra.id}`, bankId: "missing-bank", questionId: extra.id };
assert.equal(await applyV6Event({ id: "orphan-membership-save", type: "membership.saved", payload: orphanMembership, deviceId: "remote", sequence: 16, createdAt: "2040-01-01T00:00:00.000Z", synced: 1 }), true);
assert.equal(await dbV6.bankQuestionMemberships.get(orphanMembership.key), undefined, "membership cannot point at a missing parent");

const oldCheck = new Dexie(OLD_NAME);
oldCheck.version(1).stores({ sentinel: "id" });
assert.deepEqual(await oldCheck.table("sentinel").get("keep"), { id: "keep", value: "untouched" });
await oldCheck.close();
await dbV6.delete();
console.log("v6 database tests passed: namespace, joins, import, split, rounds, answers, deletion and image cache");
