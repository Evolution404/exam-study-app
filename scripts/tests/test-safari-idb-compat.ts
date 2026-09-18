import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "fake-indexeddb/auto";
import {
  createPracticeRun,
  studyDb,
  enqueueChangeSet,
  getImageAssetBlob,
  getPracticeRun,
  importQuestionBank,
  putImageAsset,
  recordPracticeAnswer,
  resetDatabase,
  restoreLocalCheckpoint,
} from "../../src/lib/db/db";
import { sha256Blob } from "../../src/lib/io/image-assets";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    values: new Map<string, string>(),
    getItem(key: string) { return this.values.get(key) ?? null; },
    setItem(key: string, value: string) { this.values.set(key, value); },
    removeItem(key: string) { this.values.delete(key); },
  },
});

await resetDatabase();

// Mobile/Safari restore must not materialize every cached image Blob into JS
// just to update descriptors. Keep the cache row in place, patch metadata,
// write in bounded batches, and abort an actually stalled atomic transaction.
const restoreSource = readFileSync(resolve(process.cwd(), "src/lib/db/db-restore.ts"), "utf8");
assert.doesNotMatch(restoreSource, /imageAssets\.toArray\(\)/, "checkpoint install must not load the entire image Blob cache into JS memory");
assert.match(restoreSource, /imageAssets\.toCollection\(\)\.primaryKeys\(\)/, "restore should inspect only image keys before reconciling descriptors");
assert.match(restoreSource, /imageAssets\.bulkUpdate/, "existing image descriptors should be patched without replacing cached blobs");
assert.match(restoreSource, /RESTORE_BATCH_SIZE = 400/, "large projection writes should be split into mobile-friendly IDB batches");
assert.match(restoreSource, /transaction\.abort\(\)/, "a stalled Safari write transaction needs an atomic abort watchdog");

const cachedImageBlob = new Blob(["cached-image"], { type: "image/png" });
const cachedImageId = await sha256Blob(cachedImageBlob);
await putImageAsset({ id: cachedImageId, mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10, blob: cachedImageBlob });
const restoreProgress: string[] = [];
const restored = await restoreLocalCheckpoint({
  banks: [],
  bankFolders: [],
  questions: [],
  memberships: [],
  imageAssets: [{ id: cachedImageId, mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10 }],
  attempts: [],
  notes: [],
  practiceRuns: [],
  practiceRunSources: [],
  practiceRunItems: [],
  questionGroups: [],
  questionGroupItems: [],
  reviewRounds: [],
  reviewRoundBanks: [],
  reviewRoundItems: [],
  tombstones: [],
}, { onProgress: (progress) => restoreProgress.push(progress.label) });
assert.equal(restored, true);
const restoredImage = await studyDb.imageAssets.get(cachedImageId);
assert.equal(await (await getImageAssetBlob(cachedImageId))?.text(), "cached-image", "descriptor refresh must preserve the local cached Blob");
assert.equal("blob" in (restoredImage as Record<string, unknown>), false, "Safari restore 后 imageAssets 仍只能保存 descriptor");
assert.deepEqual(
  { mimeType: restoredImage?.mimeType, size: restoredImage?.size, width: restoredImage?.width, height: restoredImage?.height },
  { mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10 },
  "descriptor refresh must retain the current image metadata",
);
assert.ok(restoreProgress.includes("更新图片索引") && restoreProgress.includes("本机数据库写入完成"), "restore should expose granular local-write progress");

await resetDatabase();
const now = new Date().toISOString();
const unsafeBank = { id: "unsafe-bank", name: "unsafe", sortOrder: 0, questionCount: 0, importedAt: now, updatedAt: now, deviceId: "safari-test" };
await assert.rejects(
  () => studyDb.transaction("rw", [studyDb.banks, studyDb.changeSets], async () => {
    await studyDb.banks.put(unsafeBank);
    await enqueueChangeSet([{ kind: "bank.create", bank: unsafeBank }], now);
  }),
  /必须包含 syncMeta/,
  "业务事务漏掉 syncMeta 时应快速失败，禁止退回 Safari 的嵌套写事务死锁",
);

const bank = await importQuestionBank("safari.json", {
  name: "Safari 事务兼容",
  questions: [
    { stem: "Safari Q1", options: ["甲", "乙"], answer: "A", type: "单选" },
    { stem: "Safari Q2", options: ["甲", "乙"], answer: "B", type: "单选" },
  ],
});
assert.equal((await studyDb.bankQuestionStats.get(bank.id))?.questionCount, 2, "Safari 模型下题库导入应完成并建立本地题数投影");
const run = await createPracticeRun({ bankId: bank.id, bankIds: [bank.id] });
const result = await recordPracticeAnswer({ runId: run.id, questionId: run.questionIds[0]!, selected: ["A"], correct: true, elapsedMs: 1200 });
assert.equal(result.answer.submitted, true, "Safari 模型下作答应保存并允许继续下一题");
assert.equal((await getPracticeRun(run.id))?.answers[run.questionIds[0]!]?.submitted, true, "练习读取模型应从 attempt + runItem 还原已提交答案");

const records = await studyDb.changeSets.orderBy("localSequence").toArray();
assert.ok(records.length >= 3, "导入、创建练习和作答都应生成同步事件");
for (let index = 1; index < records.length; index += 1) assert.ok(records[index]!.localSequence > records[index - 1]!.localSequence, "事务内分配的同步序号应严格递增");

studyDb.close();
console.log("Safari IndexedDB compatibility tests passed: nested-write guard, chunked projection restore, image-cache preservation, import and answer workflow");
