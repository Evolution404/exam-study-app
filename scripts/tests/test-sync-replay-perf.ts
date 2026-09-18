import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBank, createQuestion, studyDb, resetDatabase } from "../../src/lib/db/db";
import type {
  Attempt,
  Bank,
  CanonicalState,
  PracticeRunItem,
  PracticeRunRecord,
  Question,
} from "../../src/lib/db/types";
import type { ChangeSet } from "../../src/lib/sync/change-set-types";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import {
  applyChangeSetToOwnedState,
  finalizeRebasedState,
  reduceChangeSet,
  replayChangeSetBatch,
} from "../../src/lib/sync/change-set-projection";
import { discardManagedChangeSet, ensureChangeSetQueueBase } from "../../src/lib/sync/change-set-queue";

// Canonical replay performance/regression suite:
// 1. batch replay == sequential single-change reducer;
// 2. shallow envelope copies only canonical arrays actually modified;
// 3. cached id/key lookup avoids repeated full scans;
// 4. poison records roll back atomically;
// 5. strict replay throws;
// 6. caller-owned rebase + one finalize == sequential reducer;
// 7. managed queue deletion still rebuilds from canonical queue base.

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

function emptyState(): CanonicalState {
  return {
    banks: [],
    bankFolders: [],
    questions: [],
    memberships: [],
    imageAssets: [],
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
  };
}

function bigState(seedQuestions: number): CanonicalState {
  const state = emptyState();
  const bank: Bank = {
    id: "bank-1",
    name: "性能题库",
    sortOrder: 0,
    questionCount: seedQuestions,
    importedAt: at,
    updatedAt: at,
    deviceId,
  };
  state.banks.push(bank);

  const questionIds: string[] = [];
  for (let index = 0; index < seedQuestions; index += 1) {
    const id = `q-${index}`;
    questionIds.push(id);
    const optionIds = [0, 1, 2, 3].map((optionIndex) => `${id}-${optionIndex}`);
    const question = {
      id,
      type: "单选" as const,
      content: [{ id: `${id}-stem`, type: "text" as const, text: `性能题 ${index}：`.padEnd(64, "细节") }],
      options: ["甲", "乙", "丙", "丁"].map((text, optionIndex) => [{ id: `${id}-${optionIndex}`, type: "text" as const, text }]),
      optionIds,
      solution: { kind: "choice" as const, correctOptionIds: [optionIds[0]!] },
      tags: ["性能"],
      favorite: false,
      contentFingerprint: `fp-${index}`,
      updatedAt: at,
      deviceId,
    } satisfies Question;
    state.questions.push(question);
    state.memberships.push({
      key: `bank-1:${id}`,
      bankId: "bank-1",
      questionId: id,
      sortOrder: index,
      addedAt: at,
      updatedAt: at,
      deviceId,
    });
  }

  const record: PracticeRunRecord = {
    id: "run-1",
    mode: "sequential",
    modeLabel: "练习",
    shuffleOptions: false,
    startedAt: at,
    updatedAt: at,
    status: "in_progress",
    revision: 0,
    bankNameSnapshot: "性能题库",
    activityAt: at,
  };
  state.practiceRuns.push(record);
  state.practiceRunSources.push({
    runId: record.id,
    bankId: bank.id,
    bankNameSnapshot: bank.name,
    position: 0,
  });
  state.practiceRunItems.push(...questionIds.map((questionId, position): PracticeRunItem => ({
    runId: record.id,
    questionId,
    position,
    questionTypeSnapshot: "单选",
    optionOrder: [],
  })));

  for (const [index, questionId] of questionIds.entries()) {
    state.attempts.push({
      id: `a-${index}`,
      runId: record.id,
      questionId,
      selected: "A",
      correct: index % 3 !== 0,
      elapsedMs: 100,
      createdAt: at,
      deviceId,
    } satisfies Attempt);
  }
  return state;
}

function submittedMutation(
  base: CanonicalState,
  index: number,
  idPrefix = "new-a",
): Extract<Parameters<typeof createChangeSet>[0]["mutation"], { kind: "practice.answer.submitted" }> {
  const questionId = `q-${index}`;
  const item = base.practiceRunItems.find((row) => row.questionId === questionId)!;
  const attempt: Attempt = {
    id: `${idPrefix}-${index}`,
    runId: "run-1",
    questionId,
    selected: "A",
    correct: true,
    elapsedMs: 90,
    createdAt: at,
    deviceId,
  };
  return {
    kind: "practice.answer.submitted",
    attempt,
    runRecord: { ...base.practiceRuns[0], revision: index + 1, updatedAt: at },
    item: { ...item, submittedAttemptId: attempt.id },
  };
}

// --- 1. Batch replay equivalence + performance ------------------------------
{
  const base = bigState(500);
  const changes: ChangeSet[] = [];
  for (let index = 0; index < 80; index += 1) {
    changes.push(await cs([submittedMutation(base, index)]));
  }
  let deleted = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    const questionIds = Array.from({ length: 5 }, (_, offset) => `q-${400 + deleted + offset}`);
    deleted += 5;
    changes.push(await cs([{ kind: "question.bulk.delete", questionIds, deletedAt: at, cascade: true }]));
  }
  for (let index = 0; index < 10; index += 1) {
    changes.push(await cs([{
      kind: "note.upserted",
      note: { questionId: `q-${index}`, content: `解析 ${index}`, revision: 1, updatedAt: at, deviceId },
    }]));
  }
  assert.equal(changes.length, 100);

  const sequentialStarted = performance.now();
  let sequential = structuredClone(base);
  for (const change of changes) sequential = reduceChangeSet(sequential, change);
  const sequentialElapsed = performance.now() - sequentialStarted;

  const batchStarted = performance.now();
  const batch = replayChangeSetBatch(base, changes);
  const batchElapsed = performance.now() - batchStarted;

  assert.deepEqual(batch.skipped, []);
  assert.deepEqual(batch.state, sequential);
  assert.equal(batch.state.practiceRuns[0]?.revision, 80);
  assert.equal(batch.state.questions.length, 450);
  assert.equal(batch.state.banks[0]?.questionCount, 450);
  assert.ok(
    batchElapsed < sequentialElapsed,
    `批量 replay 应少于逐条 finalize 开销（batch ${batchElapsed.toFixed(0)}ms vs sequential ${sequentialElapsed.toFixed(0)}ms）`,
  );
  console.log(`canonical replay perf: batch ${batchElapsed.toFixed(0)}ms vs sequential ${sequentialElapsed.toFixed(0)}ms`);
}

// --- 2. Copy-on-write only clones touched canonical arrays -----------------
{
  const base = bigState(2_000);
  const noteChange = await cs([{
    kind: "note.upserted",
    note: { questionId: "q-1999", content: "只改解析", revision: 1, updatedAt: at, deviceId },
  }]);
  const noteResult = applyChangeSetToOwnedState(base, noteChange);
  assert.strictEqual(noteResult.questions, base.questions);
  assert.strictEqual(noteResult.memberships, base.memberships);
  assert.strictEqual(noteResult.attempts, base.attempts);
  assert.strictEqual(noteResult.practiceRuns, base.practiceRuns);
  assert.strictEqual(noteResult.practiceRunItems, base.practiceRunItems);
  assert.notStrictEqual(noteResult.notes, base.notes);
  assert.equal(base.notes.length, 0);

  const answerChange = await cs([submittedMutation(base, 1_999, "cow-answer")]);
  const answerResult = applyChangeSetToOwnedState(base, answerChange);
  assert.strictEqual(answerResult.questions, base.questions);
  assert.strictEqual(answerResult.memberships, base.memberships);
  assert.strictEqual(answerResult.notes, base.notes);
  assert.strictEqual(answerResult.practiceRunSources, base.practiceRunSources);
  assert.notStrictEqual(answerResult.attempts, base.attempts);
  assert.notStrictEqual(answerResult.practiceRuns, base.practiceRuns);
  assert.notStrictEqual(answerResult.practiceRunItems, base.practiceRunItems);
  assert.equal(base.attempts.length, 2_000);
  assert.equal(answerResult.attempts.length, 2_001);
}

// --- 3. Stable question lookup index is reused -----------------------------
{
  const base = bigState(2_000);
  let questionElementReads = 0;
  base.questions = new Proxy(base.questions, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) questionElementReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  let indexed = base;
  for (let index = 0; index < 40; index += 1) {
    indexed = applyChangeSetToOwnedState(indexed, await cs([{
      kind: "note.upserted",
      note: { questionId: "q-1999", content: `索引解析 ${index}`, revision: index + 1, updatedAt: at, deviceId },
    }]));
  }
  assert.ok(questionElementReads <= 2_100, `稳定 question lookup 不应反复全扫，实际读取 ${questionElementReads}`);
  assert.equal(indexed.notes.find((note) => note.questionId === "q-1999")?.content, "索引解析 39");
}

// --- 4. Stable tombstone key lookup is reused ------------------------------
{
  const base = bigState(2_000);
  base.tombstones = Array.from({ length: 2_000 }, (_, index) => ({
    key: `question:deleted-${index}`,
    entityType: "question" as const,
    entityId: `deleted-${index}`,
    deletedAt: at,
    deviceId,
    eventId: `tombstone-${index}`,
    sequence: index + 1,
  }));
  let tombstoneElementReads = 0;
  base.tombstones = new Proxy(base.tombstones, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) tombstoneElementReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  let indexed = base;
  for (let index = 0; index < 40; index += 1) {
    const original = indexed.questions.find((row) => row.id === "q-1999")!;
    indexed = applyChangeSetToOwnedState(indexed, await cs([{
      kind: "question.upsert",
      question: { ...original, updatedAt: `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z` },
    }]));
  }
  assert.ok(tombstoneElementReads <= 2_100, `稳定 tombstone lookup 不应反复全扫，实际读取 ${tombstoneElementReads}`);
}

// --- 5. Poison skip + shallow envelope rollback ----------------------------
{
  const base = bigState(50);
  const good = await cs([{ kind: "note.upserted", note: { questionId: "q-1", content: "先写入", revision: 1, updatedAt: at, deviceId } }]);
  const poison = await cs([
    { kind: "note.upserted", note: { questionId: "q-2", content: "毒记录部分写入", revision: 1, updatedAt: at, deviceId } },
    { kind: "question.delete", questionId: "does-not-exist", cascade: true, deletedAt: at },
  ]);
  const after = await cs([{ kind: "note.upserted", note: { questionId: "q-3", content: "毒后写入", revision: 1, updatedAt: at, deviceId } }]);

  const batch = replayChangeSetBatch(base, [good, poison, after]);
  assert.deepEqual(batch.skipped, [poison.id]);
  assert.ok(batch.state.notes.some((note) => note.questionId === "q-1"));
  assert.ok(!batch.state.notes.some((note) => note.content === "毒记录部分写入"));
  assert.ok(batch.state.notes.some((note) => note.questionId === "q-3"));
  assert.ok(!base.notes.some((note) => note.content === "毒后写入"));
}

// --- 6. Strict replay -------------------------------------------------------
{
  const base = bigState(10);
  const poison = await cs([{ kind: "question.delete", questionId: "missing", cascade: true, deletedAt: at }]);
  assert.throws(() => replayChangeSetBatch(base, [poison], undefined, { onConflict: "throw" }), /不存在/);
}

// --- 7. Owned rebase + one finalize == sequential reducer -----------------
{
  const base = bigState(50);
  const changes: ChangeSet[] = [];
  for (let index = 0; index < 8; index += 1) changes.push(await cs([submittedMutation(base, index, "owned-a")]));
  changes.push(await cs([{ kind: "question.bulk.delete", questionIds: ["q-40", "q-41", "q-42"], deletedAt: at, cascade: true }]));
  for (let index = 0; index < 3; index += 1) {
    changes.push(await cs([{
      kind: "note.upserted",
      note: { questionId: `q-${index + 10}`, content: `归并解析 ${index}`, revision: 1, updatedAt: at, deviceId },
    }]));
  }

  let sequential = structuredClone(base);
  for (const change of changes) sequential = reduceChangeSet(sequential, change);

  let owned = base;
  for (const change of changes) owned = applyChangeSetToOwnedState(owned, change);
  owned = finalizeRebasedState(owned);
  assert.deepEqual(owned, sequential);

  const poison = await cs([
    { kind: "note.upserted", note: { questionId: "q-20", content: "毒记录部分写入", revision: 1, updatedAt: at, deviceId } },
    { kind: "question.delete", questionId: "does-not-exist", cascade: true, deletedAt: at },
  ]);
  assert.throws(() => applyChangeSetToOwnedState(owned, poison), /不存在/);
  assert.ok(!owned.notes.some((note) => note.content === "毒记录部分写入"));
}

// --- 8. Managed queue deletion on real IndexedDB + mock remote -------------
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
assert.equal(await studyDb.changeSets.count(), beforeCount - 1);
assert.ok(!(await studyDb.changeSets.toArray()).some((record) => record.id === discardTarget.id));
await server.close();
studyDb.close();

console.log("sync canonical replay perf tests passed");
