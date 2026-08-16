import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  clearImageCacheV7,
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  createReviewRoundV7,
  dbV7,
  deleteBankWithExclusiveQuestionsV7,
  deleteQuestionV7,
  getImageAssetBlobV7,
  importQuestionBankV7,
  putImageAssetV7,
  recordPracticeAnswerV7,
  removeMembershipV7,
  resetV7Database,
  restoreV7Checkpoint,
  saveNoteV7,
  splitQuestionV7,
} from "../../src/lib/db/db-v7";
import { sha256Blob } from "../../src/lib/io/image-assets";

const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

await resetV7Database();

// ---------------------------------------------------------------------------
// 题库不能引用不存在的文件夹（否则 checkpoint 无法通过校验）
// ---------------------------------------------------------------------------
{
  await assert.rejects(
    () => createBankV7({ name: "坏文件夹", folderId: "missing-folder" }),
    /文件夹不存在/,
  );
}

// ---------------------------------------------------------------------------
// 删除题库：共享题存活，独占题删除
// ---------------------------------------------------------------------------
{
  const b1 = await createBankV7("共享题库一");
  const b2 = await createBankV7("共享题库二");
  const b3 = await createBankV7("独占题库");
  const qShared = await createQuestionV7(b1.id, { type: "单选", stem: "共享题", options: ["甲", "乙"], answer: "A" });
  await createQuestionV7(b2.id, { type: "单选", stem: "共享题", options: ["甲", "乙"], answer: "A" });
  const qExclusive = await createQuestionV7(b3.id, { type: "单选", stem: "独占题", options: ["甲", "乙"], answer: "A" });

  const result = await deleteBankWithExclusiveQuestionsV7(b3.id);
  assert.equal(result.bankDeleted, true);
  assert.equal(result.deletedQuestions, 1);
  assert.equal(await dbV7.questions.get(qExclusive.id), undefined, "独占题删除");
  assert.ok(await dbV7.questions.get(qShared.id), "共享题存活");
  assert.equal((await dbV7.bankQuestionMemberships.where("questionId").equals(qShared.id).count()), 2, "共享题仍属于两个题库");
}

// ---------------------------------------------------------------------------
// 移除最后一条成员关系后进入未归档
// ---------------------------------------------------------------------------
{
  const bank = await createBankV7("移除测试");
  const q = await createQuestionV7(bank.id, { type: "单选", stem: "移除后未归档", options: ["甲", "乙"], answer: "A" });
  await removeMembershipV7(bank.id, q.id);
  assert.equal(await dbV7.bankQuestionMemberships.where("questionId").equals(q.id).count(), 0);
  assert.ok(await dbV7.questions.get(q.id), "题目本身保留");
}

// ---------------------------------------------------------------------------
// 题目分裂：目标题库关系迁移、解析复制、原题保留
// ---------------------------------------------------------------------------
{
  const b1 = await createBankV7("分裂源题库");
  const b2 = await createBankV7("分裂目标题库");
  const q = await createQuestionV7(b1.id, { type: "单选", stem: "分裂题", options: ["甲", "乙"], answer: "A" });
  await createQuestionV7(b2.id, { type: "单选", stem: "分裂题", options: ["甲", "乙"], answer: "A" });
  const note = await saveNoteV7(q.id, "原题解析");

  const { original, clones } = await splitQuestionV7(q.id, [b2.id]);
  assert.equal(clones.length, 1);
  const clone = clones[0];
  assert.notEqual(clone.id, original.id);
  assert.equal(await dbV7.bankQuestionMemberships.where("questionId").equals(clone.id).count(), 1);
  assert.equal((await dbV7.bankQuestionMemberships.where("bankId").equals(b2.id).toArray()).filter((m) => m.questionId === clone.id).length, 1, "目标题库关系指向 clone");
  assert.equal((await dbV7.notes.get(clone.id))?.content, note.content, "解析复制到 clone");
  assert.equal(await dbV7.questions.get(q.id) !== undefined, true, "原题保留");
}

// ---------------------------------------------------------------------------
// 重复导入按指纹去重，标签不被覆盖
// ---------------------------------------------------------------------------
{
  await importQuestionBankV7("dup.json", { name: "去重导入", questions: [{ stem: "重复题", type: "单选", options: ["甲", "乙"], answer: "A", tags: ["原标签"] }] });
  const again = await importQuestionBankV7("dup2.json", { name: "去重导入2", questions: [{ stem: "重复题", type: "单选", options: ["甲", "乙"], answer: "A", tags: ["新标签"] }] });
  assert.equal(again.questionCount, 1);
  const all = await dbV7.questions.where("contentFingerprint").equals((await dbV7.questions.toArray()).find((q) => q.content.some((b) => b.type === "text" && (b as { text: string }).text.includes("重复题")))!.contentFingerprint).toArray();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].tags, ["原标签"], "重复导入不覆盖用户标签");
}

// ---------------------------------------------------------------------------
// recordPracticeAnswerV7：一次作答一条 submitted 事件 + 统计一致
// ---------------------------------------------------------------------------
{
  const bank = await createBankV7("作答统计");
  const q = await createQuestionV7(bank.id, { type: "单选", stem: "作答统计题", options: ["甲", "乙"], answer: "A" });
  const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id] });
  const { attempt } = await recordPracticeAnswerV7({ runId: run.id, questionId: q.id, selected: ["A"], correct: true, elapsedMs: 100 });
  assert.ok(attempt.id);
  assert.equal((await dbV7.changeSets.where("state").equals("pending").toArray()).filter((c) => c.mutations.some((m) => m.kind === "practice.answer.submitted")).length, 1);
  const stats = await dbV7.attemptStats.get(q.id);
  assert.equal(stats?.total, 1);
  assert.equal(stats?.correct, 1);
  const daily = await dbV7.attemptDailyStats.toArray();
  assert.equal(daily.length, 1);
}

// ---------------------------------------------------------------------------
// 图片缓存清理与 checkpoint 恢复保留缓存 blob
// ---------------------------------------------------------------------------
{
  const bytes = new TextEncoder().encode("cache-test-image-bytes");
  const id = await sha256Blob(new Blob([bytes], { type: "image/png" }));
  await putImageAssetV7({ id, blob: new Blob([bytes], { type: "image/png" }), mimeType: "image/png", size: bytes.length, width: 1, height: 1 });
  assert.ok(await getImageAssetBlobV7(id));
  // 只写 descriptor 不应清掉已缓存的 blob
  await putImageAssetV7({ id, mimeType: "image/png", size: bytes.length, width: 1, height: 1 });
  assert.ok(await getImageAssetBlobV7(id), "descriptor 写入不应清掉 blob 缓存");
  await clearImageCacheV7();
  assert.equal(await getImageAssetBlobV7(id), undefined, "清缓存后 blob 为空");
  await putImageAssetV7({ id, blob: new Blob([bytes], { type: "image/png" }), mimeType: "image/png", size: bytes.length, width: 1, height: 1 });
  const snapshot = {
    banks: [], bankFolders: [], questions: [], memberships: [], imageAssets: [{ id, mimeType: "image/png", size: bytes.length, width: 1, height: 1 }],
    attempts: [], attemptStats: [], attemptDailyStats: [], notes: [], practiceRuns: [], practiceRunStats: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [],
  } as const;
  await restoreV7Checkpoint(snapshot);
  assert.ok(await getImageAssetBlobV7(id), "恢复检查点后应保留已缓存 blob");
}

// ---------------------------------------------------------------------------
// 复习轮次：删除题目后该题作答被拒（E4 特征化）
// ---------------------------------------------------------------------------
{
  const bank = await createBankV7("轮次删除题");
  const q = await createQuestionV7(bank.id, { type: "单选", stem: "轮次删除题", options: ["甲", "乙"], answer: "A" });
  const round = await createReviewRoundV7({ name: "轮次", bankIds: [bank.id] });
  const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id], reviewRoundId: round.id });
  await deleteQuestionV7(q.id);
  await assert.rejects(
    () => recordPracticeAnswerV7({ runId: run.id, questionId: q.id, selected: ["A"], correct: true, reviewRoundId: round.id }),
    /不属于 active 复习轮次|不存在|不包含/,
  );
}

console.log("db-v7 extra tests passed");
process.exit(0);
