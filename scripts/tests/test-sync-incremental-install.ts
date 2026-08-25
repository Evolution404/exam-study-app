import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { installProjection } from "../../src/lib/sync/sync-v7-checkpoint-bridge";
import type { ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { QuestionV7 } from "../../src/lib/db/v7-types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => "device-ios-regression",
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

function question(id: string, stem: string): QuestionV7 {
  return {
    id,
    type: "单选",
    content: [{ id: `${id}-stem`, type: "text", text: stem }],
    options: ["甲", "乙"].map((text, index) => [{ id: `${id}-opt-${index}`, type: "text", text }]),
    answer: "A",
    tags: [],
    contentFingerprint: `fp-${id}-${stem}`,
    updatedAt: "2026-08-25T00:00:00.000Z",
    deviceId: "device-a",
  };
}

function projection(questions: QuestionV7[]): ChangeSetProjectionV7 {
  return {
    banks: [],
    bankFolders: [],
    questions,
    memberships: [],
    imageAssets: [],
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
  };
}

await resetV7Database();
const first = question("q-1", "已有本地题目");
const second = question("q-2", "远端仅新增的一道题");
await dbV7.questions.put(first);

let questionClearCalls = 0;
const originalQuestionClear = dbV7.questions.clear.bind(dbV7.questions);
dbV7.questions.clear = () => {
  questionClearCalls += 1;
  return originalQuestionClear();
};

try {
  const installed = await installProjection(projection([first, second]));
  assert.equal(installed, true, "ordinary projection update should complete");
  assert.equal(await dbV7.questions.count(), 2, "incremental install should persist the unseen question");
  assert.equal(
    questionClearCalls,
    0,
    "existing local projection must be reconciled in place; ordinary unseen delta must not clear and rebuild the questions store",
  );

  const updatedFirst = question("q-1", "远端更新后的题目");
  const reconciled = await installProjection(projection([updatedFirst]));
  assert.equal(reconciled, true, "ordinary projection update/delete should complete");
  assert.equal(await dbV7.questions.count(), 1, "incremental reconciliation should delete rows absent from the target projection");
  assert.equal(await dbV7.questions.get("q-2"), undefined, "incremental reconciliation should delete the removed remote question");
  assert.deepEqual((await dbV7.questions.get("q-1"))?.content, updatedFirst.content, "incremental reconciliation should update changed rows");
  assert.equal(questionClearCalls, 0, "update/delete reconciliation must also avoid table.clear()");

  const reorderedFirst = {
    deviceId: updatedFirst.deviceId,
    updatedAt: updatedFirst.updatedAt,
    contentFingerprint: updatedFirst.contentFingerprint,
    tags: [...updatedFirst.tags],
    answer: updatedFirst.answer,
    options: updatedFirst.options.map((option) => option.map((block) => ({ ...block }))),
    content: updatedFirst.content.map((block) => ({ ...block })),
    type: updatedFirst.type,
    id: updatedFirst.id,
  } as QuestionV7;
  let finalProgressLabel = "";
  const noOp = await installProjection(projection([reorderedFirst]), {
    onProgress: (progress) => { finalProgressLabel = progress.label; },
  });
  assert.equal(noOp, true, "semantically identical projection should complete");
  assert.equal(finalProgressLabel, "本机数据无需改写", "property-order-only differences must not create needless IndexedDB writes");
} finally {
  dbV7.questions.clear = originalQuestionClear;
  await resetV7Database();
  dbV7.close();
}

console.log("iOS incremental install regression tests passed: add/update/delete without clear, semantic no-op without rewrite");
