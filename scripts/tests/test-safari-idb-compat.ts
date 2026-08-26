import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "fake-indexeddb/auto";
import {
  createPracticeRunV7,
  dbV7,
  enqueueChangeSetV7,
  importQuestionBankV7,
  recordPracticeAnswerV7,
  resetV7Database,
  restoreV7Checkpoint,
} from "../../src/lib/db/db-v7";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    values: new Map<string, string>(),
    getItem(key: string) { return this.values.get(key) ?? null; },
    setItem(key: string, value: string) { this.values.set(key, value); },
    removeItem(key: string) { this.values.delete(key); },
  },
});

await resetV7Database();

// Mobile/Safari restore must not materialize every cached image Blob into JS
// just to update descriptors. Keep the cache row in place, patch metadata,
// write in bounded batches, and abort an actually stalled atomic transaction.
const restoreSource = readFileSync(resolve(process.cwd(), "src/lib/db/db-v7-restore.ts"), "utf8");
assert.doesNotMatch(restoreSource, /imageAssets\.toArray\(\)/, "checkpoint install must not load the entire image Blob cache into JS memory");
assert.match(restoreSource, /imageAssets\.toCollection\(\)\.primaryKeys\(\)/, "restore should inspect only image keys before reconciling descriptors");
assert.match(restoreSource, /imageAssets\.bulkUpdate/, "existing image descriptors should be patched without replacing cached blobs");
assert.match(restoreSource, /RESTORE_BATCH_SIZE = 400/, "large projection writes should be split into mobile-friendly IDB batches");
assert.match(restoreSource, /transaction\.abort\(\)/, "a stalled Safari write transaction needs an atomic abort watchdog");

const cachedImageId = "a".repeat(64);
const cachedImageBlob = new Blob(["cached-image"], { type: "image/png" });
await dbV7.imageAssets.put({ id: cachedImageId, mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10, blob: cachedImageBlob });
const restoreProgress: string[] = [];
const restored = await restoreV7Checkpoint({
  banks: [],
  bankFolders: [],
  questions: [],
  memberships: [],
  imageAssets: [{ id: cachedImageId, mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10 }],
  attempts: [],
  attemptStats: [],
  attemptDailyStats: [],
  notes: [],
  practiceRuns: [],
  practiceRunStats: [],
  questionGroups: [],
  reviewRounds: [],
  reviewRoundProgress: [],
  tombstones: [],
}, { onProgress: (progress) => restoreProgress.push(progress.label) });
assert.equal(restored, true);
const restoredImage = await dbV7.imageAssets.get(cachedImageId);
assert.equal(await restoredImage?.blob?.text(), "cached-image", "descriptor refresh must preserve the local cached Blob");
assert.deepEqual(
  { mimeType: restoredImage?.mimeType, size: restoredImage?.size, width: restoredImage?.width, height: restoredImage?.height },
  { mimeType: "image/png", size: cachedImageBlob.size, width: 20, height: 10 },
  "descriptor refresh must retain the current image metadata",
);
assert.ok(restoreProgress.includes("更新图片索引") && restoreProgress.includes("本机数据库写入完成"), "restore should expose granular local-write progress");

await resetV7Database();
const now = new Date().toISOString();
const unsafeBank = { id: "unsafe-bank", name: "unsafe", sortOrder: 0, questionCount: 0, importedAt: now, updatedAt: now, deviceId: "safari-test" };
await assert.rejects(
  () => dbV7.transaction("rw", [dbV7.banks, dbV7.changeSets], async () => {
    await dbV7.banks.put(unsafeBank);
    await enqueueChangeSetV7([{ kind: "bank.create", bank: unsafeBank }], now);
  }),
  /必须包含 syncMeta/,
  "业务事务漏掉 syncMeta 时应快速失败，禁止退回 Safari 的嵌套写事务死锁",
);

const bank = await importQuestionBankV7("safari.json", {
  name: "Safari 事务兼容",
  questions: [
    { stem: "Safari Q1", options: ["甲", "乙"], answer: "A", type: "单选" },
    { stem: "Safari Q2", options: ["甲", "乙"], answer: "B", type: "单选" },
  ],
});
assert.equal(bank.questionCount, 2, "Safari 模型下题库导入应完成");
const run = await createPracticeRunV7({ bankId: bank.id, bankIds: [bank.id] });
const result = await recordPracticeAnswerV7({ runId: run.id, questionId: run.questionIds[0]!, selected: ["A"], correct: true, elapsedMs: 1200 });
assert.equal(result.answer.submitted, true, "Safari 模型下作答应保存并允许继续下一题");
assert.equal((await dbV7.practiceRuns.get(run.id))?.answers[run.questionIds[0]!]?.submitted, true, "练习投影应包含已提交答案");

const records = await dbV7.changeSets.orderBy("localSequence").toArray();
assert.ok(records.length >= 3, "导入、创建练习和作答都应生成同步事件");
for (let index = 1; index < records.length; index += 1) assert.ok(records[index]!.localSequence > records[index - 1]!.localSequence, "事务内分配的同步序号应严格递增");

dbV7.close();
console.log("Safari IndexedDB compatibility tests passed: nested-write guard, chunked projection restore, image-cache preservation, import and answer workflow");
