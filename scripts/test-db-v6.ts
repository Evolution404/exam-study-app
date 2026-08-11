import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  clearImageCacheV6,
  createQuestionV6,
  createPracticeRunV6,
  createReviewRoundV6,
  dbV6,
  deleteBankV6,
  deleteQuestionV6,
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
  resetV6Database,
  splitQuestionV6,
  saveNoteV6,
} from "../lib/db-v6";
import type { BankFolderV6, BankQuestionMembership, ImageAsset, QuestionGroupV6, V6Event } from "../lib/v6-types";
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

// Deleting a bank removes only joins, while global deletion clears history.
await deleteBankV6(importedB.id);
assert.equal(await dbV6.questions.count(), 4);
assert.equal(await dbV6.attempts.count(), 5);
await deleteQuestionV6(shared.id);
assert.equal(await dbV6.attempts.where("questionId").equals(shared.id).count(), 0);
assert.equal(await dbV6.attemptStats.get(shared.id), undefined);

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

const oldCheck = new Dexie(OLD_NAME);
oldCheck.version(1).stores({ sentinel: "id" });
assert.deepEqual(await oldCheck.table("sentinel").get("keep"), { id: "keep", value: "untouched" });
await oldCheck.close();
await dbV6.delete();
console.log("v6 database tests passed: namespace, joins, import, split, rounds, answers, deletion and image cache");
