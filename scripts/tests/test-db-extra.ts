import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  clearImageCache,
  createBank,
  createPracticeRun,
  createQuestion,
  createReviewRound,
  studyDb,
  deleteBankWithExclusiveQuestions,
  deleteQuestion,
  getImageAssetBlob,
  importQuestionBank,
  putImageAsset,
  recordPracticeAnswer,
  removeMembership,
  resetDatabase,
  restoreLocalCheckpoint,
  saveNote,
  splitQuestion,
} from "../../src/lib/db/db";
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

await resetDatabase();

// Current choice imports must contain at least one real option id.
{
  const base = { type: "单选", stem: "非法答案完整性", options: ["甲", "乙"], optionIds: ["opt-a", "opt-b"], tags: [] };
  await assert.rejects(() => importQuestionBank("empty-choice.json", { questions: [{ ...base, solution: { kind: "choice", correctOptionIds: [] } }] }), /没有可导入的有效题目/);
  await assert.rejects(() => importQuestionBank("missing-choice.json", { questions: [{ ...base, solution: { kind: "choice", correctOptionIds: ["missing"] } }] }), /没有可导入的有效题目/);
  await assert.rejects(() => importQuestionBank("bad-letter.json", { questions: [{ ...base, solution: undefined, answer: "Z" }] }), /没有可导入的有效题目/);
}

// ---------------------------------------------------------------------------
// 题库不能引用不存在的文件夹（否则 checkpoint 无法通过校验）
// ---------------------------------------------------------------------------
{
  await assert.rejects(
    () => createBank({ name: "坏文件夹", folderId: "missing-folder" }),
    /文件夹不存在/,
  );
}

// ---------------------------------------------------------------------------
// 删除题库：共享题存活，独占题删除
// ---------------------------------------------------------------------------
{
  const b1 = await createBank("共享题库一");
  const b2 = await createBank("共享题库二");
  const b3 = await createBank("独占题库");
  const qShared = await createQuestion(b1.id, { type: "单选", stem: "共享题", options: ["甲", "乙"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await createQuestion(b2.id, { type: "单选", stem: "共享题", options: ["甲", "乙"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const qExclusive = await createQuestion(b3.id, { type: "单选", stem: "独占题", options: ["甲", "乙"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });

  const result = await deleteBankWithExclusiveQuestions(b3.id);
  assert.equal(result.bankDeleted, true);
  assert.equal(result.deletedQuestions, 1);
  assert.equal(await studyDb.questions.get(qExclusive.id), undefined, "独占题删除");
  assert.ok(await studyDb.questions.get(qShared.id), "共享题存活");
  assert.equal((await studyDb.bankQuestionMemberships.where("questionId").equals(qShared.id).count()), 2, "共享题仍属于两个题库");
}

// ---------------------------------------------------------------------------
// 移除最后一条成员关系后进入未归档
// ---------------------------------------------------------------------------
{
  const bank = await createBank("移除测试");
  const q = await createQuestion(bank.id, { type: "单选", stem: "移除后未归档", options: ["甲", "乙"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await removeMembership(bank.id, q.id);
  assert.equal(await studyDb.bankQuestionMemberships.where("questionId").equals(q.id).count(), 0);
  assert.ok(await studyDb.questions.get(q.id), "题目本身保留");
}

// ---------------------------------------------------------------------------
// 题目分裂：目标题库关系迁移、解析复制、原题保留
// ---------------------------------------------------------------------------
{
  const b1 = await createBank("分裂源题库");
  const b2 = await createBank("分裂目标题库");
  const q = await createQuestion(b1.id, { type: "单选", stem: "分裂题", options: ["甲", "乙"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  await createQuestion(b2.id, { type: "单选", stem: "分裂题", options: ["甲", "乙"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const note = await saveNote(q.id, "原题解析");

  const { original, clones } = await splitQuestion(q.id, [b2.id]);
  assert.equal(clones.length, 1);
  const clone = clones[0];
  assert.notEqual(clone.id, original.id);
  assert.equal(await studyDb.bankQuestionMemberships.where("questionId").equals(clone.id).count(), 1);
  assert.equal((await studyDb.bankQuestionMemberships.where("bankId").equals(b2.id).toArray()).filter((m) => m.questionId === clone.id).length, 1, "目标题库关系指向 clone");
  assert.equal((await studyDb.notes.get(clone.id))?.content, note.content, "解析复制到 clone");
  assert.equal(await studyDb.questions.get(q.id) !== undefined, true, "原题保留");
}

// ---------------------------------------------------------------------------
// 重复导入按指纹去重，标签不被覆盖
// ---------------------------------------------------------------------------
{
  await importQuestionBank("dup.json", { name: "去重导入", questions: [{ stem: "重复题", type: "单选", options: ["甲", "乙"], answer: "A", tags: ["原标签"] }] });
  const again = await importQuestionBank("dup2.json", { name: "去重导入2", questions: [{ stem: "重复题", type: "单选", options: ["甲", "乙"], answer: "A", tags: ["新标签"] }] });
  assert.equal(again.questionCount, 1);
  const all = await studyDb.questions.where("contentFingerprint").equals((await studyDb.questions.toArray()).find((q) => q.content.some((b) => b.type === "text" && (b as { text: string }).text.includes("重复题")))!.contentFingerprint).toArray();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].tags, ["原标签"], "重复导入不覆盖用户标签");
}

// ---------------------------------------------------------------------------
// recordPracticeAnswer：一次作答一条 submitted 事件 + 统计一致
// ---------------------------------------------------------------------------
{
  const bank = await createBank("作答统计");
  const q = await createQuestion(bank.id, { type: "单选", stem: "作答统计题", options: ["甲", "乙"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const run = await createPracticeRun({ bankId: bank.id, questionIds: [q.id] });
  const { attempt } = await recordPracticeAnswer({ runId: run.id, questionId: q.id, selected: ["A"], correct: true, elapsedMs: 100 });
  assert.ok(attempt.id);
  assert.equal((await studyDb.changeSets.where("state").equals("pending").toArray()).filter((c) => c.mutations.some((m) => m.kind === "practice.answer.submitted")).length, 1);
  const stats = await studyDb.questionProgress.get(q.id);
  assert.equal(stats?.total, 1);
  assert.equal(stats?.correct, 1);
  const daily = await studyDb.questionDailyProgress.toArray();
  assert.equal(daily.length, 1);
}

// ---------------------------------------------------------------------------
// 图片缓存清理与 checkpoint 恢复保留缓存 blob
// ---------------------------------------------------------------------------
{
  const bytes = new TextEncoder().encode("cache-test-image-bytes");
  const id = await sha256Blob(new Blob([bytes], { type: "image/png" }));
  await putImageAsset({ id, blob: new Blob([bytes], { type: "image/png" }), mimeType: "image/png", size: bytes.length, width: 1, height: 1 });
  assert.ok(await getImageAssetBlob(id));
  // 只写 descriptor 不应清掉已缓存的 blob
  await putImageAsset({ id, mimeType: "image/png", size: bytes.length, width: 1, height: 1 });
  assert.ok(await getImageAssetBlob(id), "descriptor 写入不应清掉 blob 缓存");
  await clearImageCache();
  assert.equal(await getImageAssetBlob(id), undefined, "清缓存后 blob 为空");
  await putImageAsset({ id, blob: new Blob([bytes], { type: "image/png" }), mimeType: "image/png", size: bytes.length, width: 1, height: 1 });
  const snapshot = {
    banks: [], bankFolders: [], questions: [], memberships: [], imageAssets: [{ id, mimeType: "image/png", size: bytes.length, width: 1, height: 1 }],
    attempts: [], notes: [],
    practiceRuns: [], practiceRunSources: [], practiceRunItems: [],
    questionGroups: [], questionGroupItems: [],
    reviewRounds: [], reviewRoundBanks: [], reviewRoundItems: [],
    tombstones: [],
  } as const;
  await restoreLocalCheckpoint(snapshot);
  assert.ok(await getImageAssetBlob(id), "恢复检查点后应保留已缓存 blob");
}

// ---------------------------------------------------------------------------
// 复习轮次：删除题目后该题作答被拒（E4 特征化）
// ---------------------------------------------------------------------------
{
  const bank = await createBank("轮次删除题");
  const q = await createQuestion(bank.id, { type: "单选", stem: "轮次删除题", options: ["甲", "乙"], optionIds: ["opt-0", "opt-1"], solution: { kind: "choice", correctOptionIds: ["opt-0"] } });
  const round = await createReviewRound({ name: "轮次", bankIds: [bank.id] });
  const run = await createPracticeRun({ bankId: bank.id, questionIds: [q.id], reviewRoundId: round.id });
  await deleteQuestion(q.id);
  await assert.rejects(
    () => recordPracticeAnswer({ runId: run.id, questionId: q.id, selected: ["A"], correct: true, reviewRoundId: round.id, elapsedMs: 10 }),
    /不属于 active 复习轮次|不存在|不包含/,
  );
}

console.log("db extra tests passed");
process.exit(0);
