import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV6, createQuestionV6, dbV6, resetV6Database } from "../../src/lib/db/db-v6";
import type { AttemptV6, BankV6, PracticeRunV6, QuestionV6 } from "../../src/lib/db/v6-types";
import { createChangeSetV7, type ChangeSetV7 } from "../../src/lib/sync/change-set-v7";
import {
  reduceChangeSetsV7,
  replayChangeSetBatchV7,
  type ChangeSetProjectionV7,
} from "../../src/lib/sync/change-set-v7-projection";
import { discardManagedChangeSetV7, ensureChangeSetQueueBaseV7 } from "../../src/lib/sync/change-set-v7-queue";

// 批量重放提速套件（Part C 防回退）：
//   1. 等价性 —— 批量重放与逐条 reduce 的最终投影 deepEqual（含 bulk.delete、
//      作答、run 答案 copy-on-write、墓碑级联）；
//   2. poison-skip 语义 —— 单条失败只跳过该条，且失败条的部分写入不泄漏
//      （浅信封回滚安全）；
//   3. strict 模式 —— onConflict:"throw" 首个失败即抛；
//   4. 性能 —— 大投影 × 100 条 change 的批量重放明显快于逐条路径；
//   5. 队列删除 discardManagedChangeSetV7 在 60 条 pending 下正确。

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-v6-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-v6-device-id") currentDeviceId = value;
    },
  },
});

const at = "2026-08-01T00:00:00.000Z";
const deviceId = "device-perf";
let sequence = 0;

async function cs(mutations: Parameters<typeof createChangeSetV7>[0]["mutations"]): Promise<ChangeSetV7> {
  return createChangeSetV7({ deviceId, localSequence: ++sequence, createdAt: at, mutations });
}

function emptyProjection(): ChangeSetProjectionV7 {
  return { banks: [], bankFolders: [], questions: [], memberships: [], imageAssets: [], attempts: [], attemptStats: [], attemptDailyStats: [], notes: [], practiceRuns: [], practiceRunStats: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [] };
}

// 构造一个有分量的投影：500 题 + 一个进行中的 run（答案逐题提交会触发 copy-on-write）。
function bigProjection(seedQuestions: number): ChangeSetProjectionV7 {
  const projection = emptyProjection();
  const bank: BankV6 = { id: "bank-1", name: "性能题库", sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId };
  projection.banks.push(bank);
  const questionIds: string[] = [];
  for (let index = 0; index < seedQuestions; index += 1) {
    const id = `q-${index}`;
    questionIds.push(id);
    const question = {
      id, type: "单选" as const,
      content: [{ id: `${id}-stem`, type: "text" as const, text: `性能题 ${index}：`.padEnd(64, "细节") }],
      options: ["甲", "乙", "丙", "丁"].map((text, optionIndex) => [{ id: `${id}-${optionIndex}`, type: "text" as const, text }]),
      answer: "A", tags: ["性能"], favorite: false, contentFingerprint: `fp-${index}`, updatedAt: at, deviceId,
    } satisfies QuestionV6;
    projection.questions.push(question);
    projection.memberships.push({ key: `bank-1:${id}`, bankId: "bank-1", questionId: id, sortOrder: 0, addedAt: at, updatedAt: at, deviceId });
  }
  const questionTypes = Object.fromEntries(questionIds.map((id) => [id, "单选"]));
  const run = { id: "run-1", bankId: "bank-1", bankIds: ["bank-1"], bankName: "性能题库", mode: "sequential" as const, modeLabel: "练习", questionIds, questionTypes, answers: {}, shuffleOptions: false, optionOrders: {}, startedAt: at, updatedAt: at, status: "in_progress" as const, revision: 0 } satisfies PracticeRunV6;
  projection.practiceRuns.push(run);
  for (const [index, questionId] of questionIds.entries()) {
    const attempt = { id: `a-${index}`, runId: "run-1", questionId, selected: "A", correct: index % 3 !== 0, elapsedMs: 100, createdAt: at, deviceId } satisfies AttemptV6;
    projection.attempts.push(attempt);
  }
  return projection;
}

// --- 1/4. 等价性 + 性能 -----------------------------------------------------
{
  const base = bigProjection(500);
  // 100 条混合 change：80 条作答提交（触发 runWithAnswer copy-on-write）、
  // 10 条 bulk.delete（每批 5 题）、10 条解析写入。
  const changes: ChangeSetV7[] = [];
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
  const sequential = reduceChangeSetsV7(base, changes);
  const sequentialElapsed = performance.now() - sequentialStarted;
  const batchStarted = performance.now();
  const batch = replayChangeSetBatchV7(base, changes);
  const batchElapsed = performance.now() - batchStarted;

  assert.deepEqual(batch.skipped, [], "等价性场景中不应有跳过记录");
  // 逐条路径最终投影 = 批量路径（派生表、墓碑、run revision 全一致）。
  assert.deepEqual(batch.projection, sequential);
  assert.equal((batch.projection.practiceRuns[0] as { revision: number }).revision, (sequential.practiceRuns[0] as { revision: number }).revision, "copy-on-write 答案写入的 revision 语义一致");
  assert.equal(batch.projection.tombstones.length, sequential.tombstones.length, "bulk.delete 的墓碑数量一致");
  assert.equal(batch.projection.questions.length, 500 - 50, "bulk.delete 共删除 50 题");
  assert.equal((batch.projection.banks[0] as { questionCount: number }).questionCount, 450, "派生 questionCount 重算正确");

  // 性能：批量路径应显著快于逐条路径（宽松阈值防 CI 抖动，只防算法级回退）。
  assert.ok(
    batchElapsed < sequentialElapsed * 0.75,
    `批量重放应明显快于逐条路径（batch ${batchElapsed.toFixed(0)}ms vs sequential ${sequentialElapsed.toFixed(0)}ms）`,
  );
  console.log(`replay perf passed: batch ${batchElapsed.toFixed(0)}ms vs sequential ${sequentialElapsed.toFixed(0)}ms（${(sequentialElapsed / batchElapsed).toFixed(1)}×）`);
}

// --- 2. poison-skip 与浅信封回滚安全 ---------------------------------------
{
  const base = bigProjection(50);
  const good = await cs([{ kind: "note.upserted" as const, note: { questionId: "q-1", content: "先写入", revision: 1, updatedAt: at, deviceId } }]);
  // 毒记录：先成功写一条解析，再删除一个不存在的题目 —— applyMutation 中途 fail。
  const poison = await cs([
    { kind: "note.upserted" as const, note: { questionId: "q-2", content: "毒记录部分写入", revision: 1, updatedAt: at, deviceId } },
    { kind: "question.delete" as const, questionId: "does-not-exist", cascade: true, deletedAt: at },
  ]);
  const after = await cs([{ kind: "note.upserted" as const, note: { questionId: "q-3", content: "毒后写入", revision: 1, updatedAt: at, deviceId } }]);

  const batch = replayChangeSetBatchV7(base, [good, poison, after]);
  assert.deepEqual(batch.skipped, [poison.id], "只有毒记录被跳过");
  assert.ok(batch.projection.notes.some((note) => note.questionId === "q-1" && note.content === "先写入"), "毒前的写入保留");
  assert.ok(!batch.projection.notes.some((note) => note.content === "毒记录部分写入"), "毒记录的部分写入必须整体回滚（信封丢弃）");
  assert.ok(batch.projection.notes.some((note) => note.questionId === "q-3"), "毒后的写入继续应用");
  // 基座投影未被污染（共享实体只读）。
  assert.ok(!base.notes.some((note) => note.content === "毒后写入"), "基座投影不可被批量重放突变");
}

// --- 3. strict 模式 ---------------------------------------------------------
{
  const base = bigProjection(10);
  const poison = await cs([{ kind: "question.delete" as const, questionId: "missing", cascade: true, deletedAt: at }]);
  assert.throws(() => replayChangeSetBatchV7(base, [poison], undefined, { onConflict: "throw" }), /不存在/, "strict 模式应抛出首个失败");
}

// --- 5. 队列删除（真实 IndexedDB + mock 后端）--------------------------------
// 队列基线需要先完成一次同步建立（queueBase 要求 v7:queue-base 存在）。
const { startMockGitHubServer } = await import("../tools/mock-github-server.mjs");
const { syncWithGitHub } = await import("../../src/lib/sync/github-sync-v7");
const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "replay-perf-vault", branch: "main", apiBaseUrl: server.url };
await resetV6Database();
currentDeviceId = "device-a";
await syncWithGitHub(settings, "qa-token");
const queueBank = await createBankV6("队列删除题库");
for (let index = 0; index < 60; index += 1) {
  await createQuestionV6(queueBank.id, { type: "单选", content: [{ id: `s-${index}`, type: "text", text: `队列题 ${index}` }], options: [[{ id: "o1", type: "text", text: "甲" }], [{ id: "o2", type: "text", text: "乙" }]], answer: "A", tags: [] });
}
await ensureChangeSetQueueBaseV7();
const beforeCount = await dbV6.changeSets.count();
assert.ok(beforeCount >= 60, `应积累至少 60 条 pending（实际 ${beforeCount}，含建库事件）`);
const records = await dbV6.changeSets.toArray();
const discardTarget = records[30]!;
await discardManagedChangeSetV7(discardTarget.id, { cascadeDependents: true });
assert.equal(await dbV6.changeSets.count(), beforeCount - 1, "删除一条后队列恰好少一条");
const remaining = await dbV6.changeSets.toArray();
assert.ok(!remaining.some((record) => record.id === discardTarget.id), "目标记录已移除");
await server.close();
dbV6.close();

console.log("sync replay perf tests passed: 批量/逐条 deepEqual、poison-skip 回滚安全、strict 模式、60 条队列删除");
