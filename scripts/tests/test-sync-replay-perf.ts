import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBank, createQuestion, studyDb, resetDatabase } from "../../src/lib/db/db";
import type { Attempt, Bank, PracticeRun, Question } from "../../src/lib/db/types";
import { type ChangeSet } from "../../src/lib/sync/change-set-types";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import {
  applyChangeSetToOwnedProjection,
  finalizeRebasedProjection,
  reduceChangeSets,
  replayChangeSetBatch,
  type ChangeSetProjection,
} from "../../src/lib/sync/change-set-projection";
import { discardManagedChangeSet, ensureChangeSetQueueBase } from "../../src/lib/sync/change-set-queue";

// 批量重放提速套件（Part C 防回退）：
//   1. 等价性 —— 批量重放与逐条 reduce 的最终投影 deepEqual（含 bulk.delete、
//      作答、run 答案 copy-on-write、墓碑级联）；
//   2. poison-skip 语义 —— 单条失败只跳过该条，且失败条的部分写入不泄漏
//      （浅信封回滚安全）；
//   3. strict 模式 —— onConflict:"throw" 首个失败即抛；
//   4. 性能 —— 大投影 × 100 条 change 的批量重放明显快于逐条路径；
//   5. 队列删除 discardManagedChangeSet 在 60 条 pending 下正确。

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-device-id") currentDeviceId = value;
    },
  },
});

const at = "2026-08-01T00:00:00.000Z";
const deviceId = "device-perf";
let sequence = 0;

async function cs(mutations: Parameters<typeof createChangeSet>[0]["mutations"]): Promise<ChangeSet> {
  return createChangeSet({ deviceId, localSequence: ++sequence, createdAt: at, mutations });
}

function emptyProjection(): ChangeSetProjection {
  return { banks: [], bankFolders: [], questions: [], memberships: [], imageAssets: [], attempts: [], attemptStats: [], attemptDailyStats: [], notes: [], practiceRuns: [], practiceRunStats: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [] };
}

// 构造一个有分量的投影：500 题 + 一个进行中的 run（答案逐题提交会触发 copy-on-write）。
function bigProjection(seedQuestions: number): ChangeSetProjection {
  const projection = emptyProjection();
  const bank: Bank = { id: "bank-1", name: "性能题库", sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId };
  projection.banks.push(bank);
  const questionIds: string[] = [];
  for (let index = 0; index < seedQuestions; index += 1) {
    const id = `q-${index}`;
    questionIds.push(id);
    const optionIds = [0, 1, 2, 3].map((optionIndex) => `${id}-${optionIndex}`);
    const question = {
      id, type: "单选" as const,
      content: [{ id: `${id}-stem`, type: "text" as const, text: `性能题 ${index}：`.padEnd(64, "细节") }],
      options: ["甲", "乙", "丙", "丁"].map((text, optionIndex) => [{ id: `${id}-${optionIndex}`, type: "text" as const, text }]),
      optionIds,
      solution: { kind: "choice" as const, correctOptionIds: [optionIds[0]!] },
      tags: ["性能"], favorite: false, contentFingerprint: `fp-${index}`, updatedAt: at, deviceId,
    } satisfies Question;
    projection.questions.push(question);
    projection.memberships.push({ key: `bank-1:${id}`, bankId: "bank-1", questionId: id, sortOrder: 0, addedAt: at, updatedAt: at, deviceId });
  }
  const questionTypes = Object.fromEntries(questionIds.map((id) => [id, "单选"]));
  const run = { id: "run-1", bankId: "bank-1", bankIds: ["bank-1"], bankName: "性能题库", mode: "sequential" as const, modeLabel: "练习", questionIds, questionTypes, answers: {}, shuffleOptions: false, optionOrders: {}, startedAt: at, updatedAt: at, status: "in_progress" as const, revision: 0 } satisfies PracticeRun;
  projection.practiceRuns.push(run);
  for (const [index, questionId] of questionIds.entries()) {
    const attempt = { id: `a-${index}`, runId: "run-1", questionId, selected: "A", correct: index % 3 !== 0, elapsedMs: 100, createdAt: at, deviceId } satisfies Attempt;
    projection.attempts.push(attempt);
  }
  return projection;
}

// --- 1/4. 等价性 + 性能 -----------------------------------------------------
{
  const base = bigProjection(500);
  // 100 条混合 change：80 条作答提交（触发 runWithAnswer copy-on-write）、
  // 10 条 bulk.delete（每批 5 题）、10 条解析写入。
  const changes: ChangeSet[] = [];
  for (let index = 0; index < 80; index += 1) {
    const questionId = `q-${index}`;
    changes.push(await cs([
      {
        kind: "practice.answer.submitted", runId: "run-1", questionId,
        attempt: { id: `new-a-${index}`, runId: "run-1", questionId, selected: "A", correct: true, elapsedMs: 90, createdAt: at, deviceId },
        answer: { selected: ["A"], submitted: true, correct: true, updatedAt: at, deviceId, eventId: `evt-${index}` },
      },
    ]));
  }
  let deleted = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    const questionIds = Array.from({ length: 5 }, (_, offset) => `q-${400 + deleted + offset}`);
    deleted += 5;
    changes.push(await cs([{ kind: "question.bulk.delete" as const, questionIds, deletedAt: at, cascade: true }]));
  }
  for (let index = 0; index < 10; index += 1) {
    changes.push(await cs([{ kind: "note.upserted" as const, note: { questionId: `q-${index}`, content: `解析 ${index}`, revision: 1, updatedAt: at, deviceId } }]));
  }
  assert.equal(changes.length, 100);

  const sequentialStarted = performance.now();
  const sequential = reduceChangeSets(base, changes);
  const sequentialElapsed = performance.now() - sequentialStarted;
  const batchStarted = performance.now();
  const batch = replayChangeSetBatch(base, changes);
  const batchElapsed = performance.now() - batchStarted;

  assert.deepEqual(batch.skipped, [], "等价性场景中不应有跳过记录");
  assert.deepEqual(batch.projection, sequential);
  assert.equal((batch.projection.practiceRuns[0] as { revision: number }).revision, (sequential.practiceRuns[0] as { revision: number }).revision, "copy-on-write 答案写入的 revision 语义一致");
  assert.equal(batch.projection.tombstones.length, sequential.tombstones.length, "bulk.delete 的墓碑数量一致");
  assert.equal(batch.projection.questions.length, 500 - 50, "bulk.delete 共删除 50 题");
  assert.equal((batch.projection.banks[0] as { questionCount: number }).questionCount, 450, "派生 questionCount 重算正确");

  assert.ok(
    batchElapsed < sequentialElapsed * 0.75,
    `批量重放应明显快于逐条路径（batch ${batchElapsed.toFixed(0)}ms vs sequential ${sequentialElapsed.toFixed(0)}ms）`,
  );
  console.log(`replay perf passed: batch ${batchElapsed.toFixed(0)}ms vs sequential ${sequentialElapsed.toFixed(0)}ms（${(sequentialElapsed / batchElapsed).toFixed(1)}×）`);
}

// --- 2. Copy-on-write envelope：只复制真正被当前 change-set 修改的表 ---------
{
  const base = bigProjection(2_000);
  const noteChange = await cs([
    { kind: "note.upserted" as const, note: { questionId: "q-1999", content: "只改解析", revision: 1, updatedAt: at, deviceId } },
  ]);
  const noteResult = applyChangeSetToOwnedProjection(base, noteChange);
  assert.strictEqual(noteResult.questions, base.questions, "解析写入不得复制 questions");
  assert.strictEqual(noteResult.memberships, base.memberships, "解析写入不得复制 memberships");
  assert.strictEqual(noteResult.attempts, base.attempts, "解析写入不得复制 attempts");
  assert.strictEqual(noteResult.practiceRuns, base.practiceRuns, "解析写入不得复制 practiceRuns");
  assert.notStrictEqual(noteResult.notes, base.notes, "解析写入只允许复制 notes");
  assert.equal(base.notes.length, 0, "copy-on-write 不得突变基座 notes");
  assert.equal(noteResult.notes[0]?.content, "只改解析");

  const answerChange = await cs([
    {
      kind: "practice.answer.submitted" as const,
      runId: "run-1",
      questionId: "q-1999",
      attempt: { id: "cow-answer", runId: "run-1", questionId: "q-1999", selected: "A", correct: true, elapsedMs: 90, createdAt: at, deviceId },
      answer: { selected: ["A"], submitted: true, correct: true, updatedAt: at, deviceId, eventId: "cow-answer-event" },
    },
  ]);
  const answerResult = applyChangeSetToOwnedProjection(base, answerChange);
  assert.strictEqual(answerResult.questions, base.questions, "单题答案不得复制 questions");
  assert.strictEqual(answerResult.memberships, base.memberships, "单题答案不得复制 memberships");
  assert.strictEqual(answerResult.notes, base.notes, "单题答案不得复制 notes");
  assert.notStrictEqual(answerResult.attempts, base.attempts, "单题答案必须 copy-on-write attempts");
  assert.notStrictEqual(answerResult.practiceRuns, base.practiceRuns, "单题答案必须 copy-on-write practiceRuns");
  assert.equal(base.attempts.length, 2_000, "copy-on-write 不得向基座 attempts 追加记录");
  assert.equal(answerResult.attempts.length, 2_001);
}

// --- 3. 稳定表 lookup index：重复 change-set 不得反复线性扫描 questions ------
{
  const base = bigProjection(2_000);
  let questionElementReads = 0;
  const trackedQuestions = new Proxy(base.questions, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\\d+$/.test(property)) questionElementReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  base.questions = trackedQuestions;

  let indexed = base;
  for (let index = 0; index < 40; index += 1) {
    indexed = applyChangeSetToOwnedProjection(indexed, await cs([
      { kind: "note.upserted" as const, note: { questionId: "q-1999", content: `索引解析 ${index}`, revision: index + 1, updatedAt: at, deviceId } },
    ]));
  }
  assert.ok(
    questionElementReads <= 2_100,
    `稳定 questions lookup 应只建立一次索引并 O(1) 复用，实际读取 ${questionElementReads} 个元素`,
  );
  assert.equal(indexed.notes.find((note) => note.questionId === "q-1999")?.content, "索引解析 39");
}

// --- 4. poison-skip 与浅信封回滚安全 ---------------------------------------
{
  const base = bigProjection(50);
  const good = await cs([{ kind: "note.upserted" as const, note: { questionId: "q-1", content: "先写入", revision: 1, updatedAt: at, deviceId } }]);
  const poison = await cs([
    { kind: "note.upserted" as const, note: { questionId: "q-2", content: "毒记录部分写入", revision: 1, updatedAt: at, deviceId } },
    { kind: "question.delete" as const, questionId: "does-not-exist", cascade: true, deletedAt: at },
  ]);
  const after = await cs([{ kind: "note.upserted" as const, note: { questionId: "q-3", content: "毒后写入", revision: 1, updatedAt: at, deviceId } }]);

  const batch = replayChangeSetBatch(base, [good, poison, after]);
  assert.deepEqual(batch.skipped, [poison.id], "只有毒记录被跳过");
  assert.ok(batch.projection.notes.some((note) => note.questionId === "q-1" && note.content === "先写入"), "毒前的写入保留");
  assert.ok(!batch.projection.notes.some((note) => note.content === "毒记录部分写入"), "毒记录的部分写入必须整体回滚（信封丢弃）");
  assert.ok(batch.projection.notes.some((note) => note.questionId === "q-3"), "毒后的写入继续应用");
  assert.ok(!base.notes.some((note) => note.content === "毒后写入"), "基座投影不可被批量重放突变");
}

// --- 5. strict 模式 ---------------------------------------------------------
{
  const base = bigProjection(10);
  const poison = await cs([{ kind: "question.delete" as const, questionId: "missing", cascade: true, deletedAt: at }]);
  assert.throws(() => replayChangeSetBatch(base, [poison], undefined, { onConflict: "throw" }), /不存在/, "strict 模式应抛出首个失败");
}

// --- 6. 本地归并等价：owned 投影逐条 apply + 一次 finalize ≡ 逐条 reduce ----
// 编排器重写后的本地待上传归并路径：单次 caller-owned 投影上逐条浅信封应用，
// 循环后统一派生+校验一次。必须与基准逐条 reduce（每条全量克隆+派生）等价，
// 且毒记录失败时输入投影不被污染（信封丢弃回滚）。
{
  const base = bigProjection(50);
  const good: ChangeSet[] = [];
  for (let index = 0; index < 8; index += 1) {
    const questionId = `q-${index}`;
    good.push(await cs([
      {
        kind: "practice.answer.submitted" as const, runId: "run-1", questionId,
        attempt: { id: `owned-a-${index}`, runId: "run-1", questionId, selected: "A", correct: true, elapsedMs: 90, createdAt: at, deviceId },
        answer: { selected: ["A"], submitted: true, correct: true, updatedAt: at, deviceId, eventId: `owned-evt-${index}` },
      },
    ]));
  }
  good.push(await cs([{ kind: "question.bulk.delete" as const, questionIds: ["q-40", "q-41", "q-42"], deletedAt: at, cascade: true }]));
  for (let index = 0; index < 3; index += 1) {
    good.push(await cs([{ kind: "note.upserted" as const, note: { questionId: `q-${index + 10}`, content: `归并解析 ${index}`, revision: 1, updatedAt: at, deviceId } }]));
  }

  const sequential = reduceChangeSets(base, good);
  let owned = base as ChangeSetProjection;
  for (const change of good) owned = applyChangeSetToOwnedProjection(owned, change);
  owned = finalizeRebasedProjection(owned);
  assert.deepEqual(owned, sequential, "owned 逐条 apply + 一次 finalize 必须与逐条 reduce 等价");

  const poison = await cs([
    { kind: "note.upserted" as const, note: { questionId: "q-20", content: "毒记录部分写入", revision: 1, updatedAt: at, deviceId } },
    { kind: "question.delete" as const, questionId: "does-not-exist", cascade: true, deletedAt: at },
  ]);
  assert.throws(() => applyChangeSetToOwnedProjection(owned, poison), /不存在/, "毒记录应抛出而非静默");
  assert.ok(!owned.notes.some((note) => note.content === "毒记录部分写入"), "毒记录的部分写入必须整体回滚（owned 输入投影不受影响）");
  assert.equal(owned.questions.length, sequential.questions.length, "抛出后投影保持等价结果");
}

// --- 7. 队列删除（真实 IndexedDB + mock 后端）--------------------------------
const { startMockGitHubServer } = await import("../tools/mock-github-server.mjs");
const { syncWithGitHub } = await import("../../src/lib/sync/github-sync-engine");
const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "replay-perf-vault", branch: "main", apiBaseUrl: server.url };
await resetDatabase();
currentDeviceId = "device-a";
await syncWithGitHub(settings, "qa-token");
const queueBank = await createBank("队列删除题库");
for (let index = 0; index < 60; index += 1) {
  await createQuestion(queueBank.id, {
    type: "单选",
    content: [{ id: `s-${index}`, type: "text", text: `队列题 ${index}` }],
    options: [[{ id: "o1", type: "text", text: "甲" }], [{ id: "o2", type: "text", text: "乙" }]],
    optionIds: ["o1", "o2"],
    solution: { kind: "choice", correctOptionIds: ["o1"] },
    tags: [],
  });
}
await ensureChangeSetQueueBase();
const beforeCount = await studyDb.changeSets.count();
assert.ok(beforeCount >= 60, `应积累至少 60 条 pending（实际 ${beforeCount}，含建库事件）`);
const records = await studyDb.changeSets.toArray();
const discardTarget = records[30]!;
await discardManagedChangeSet(discardTarget.id, { cascadeDependents: true });
assert.equal(await studyDb.changeSets.count(), beforeCount - 1, "删除一条后队列恰好少一条");
const remaining = await studyDb.changeSets.toArray();
assert.ok(!remaining.some((record) => record.id === discardTarget.id), "目标记录已移除");
await server.close();
studyDb.close();

console.log("sync replay perf tests passed: 批量/逐条 deepEqual、poison-skip 回滚安全、strict 模式、60 条队列删除");