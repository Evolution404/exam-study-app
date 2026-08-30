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

function projection(questions: QuestionV7[], imageAssets: ChangeSetProjectionV7["imageAssets"] = []): ChangeSetProjectionV7 {
  return {
    banks: [],
    bankFolders: [],
    questions,
    memberships: [],
    imageAssets,
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

function benchmarkProjection(questionCount: number, attemptCount: number): ChangeSetProjectionV7 {
  const questions = Array.from({ length: questionCount }, (_, index) => question(`bench-q-${index}`, `同步性能基准题目 ${index}：${"输电线路运行维护".repeat(4)}`));
  const attempts = Array.from({ length: attemptCount }, (_, index) => ({
    id: `bench-a-${index}`,
    runId: `bench-run-${Math.floor(index / 50)}`,
    questionId: questions[index % questions.length].id,
    selected: index % 5 === 0 ? "" : "A",
    correct: index % 3 !== 0,
    elapsedMs: 1_000 + index % 30_000,
    createdAt: new Date(Date.UTC(2026, 6, 1) + index * 1_000).toISOString(),
    deviceId: "device-benchmark",
  }));
  return { ...projection(questions), attempts } as ChangeSetProjectionV7;
}

function elapsedMs(started: number): number {
  return Math.max(0, performance.now() - started);
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

  const imageDescriptor = { id: "a".repeat(64), mimeType: "image/webp" as const, size: 4, width: 1, height: 1 };
  await dbV7.imageAssets.put({ ...imageDescriptor, blob: new Blob(["img"], { type: "image/webp" }) });
  let imageBulkUpdateRows = 0;
  const originalImageBulkUpdate = dbV7.imageAssets.bulkUpdate.bind(dbV7.imageAssets);
  dbV7.imageAssets.bulkUpdate = ((updates) => {
    imageBulkUpdateRows += updates.length;
    return originalImageBulkUpdate(updates);
  }) as typeof dbV7.imageAssets.bulkUpdate;
  try {
    let imageNoOpLabel = "";
    const imageNoOp = await installProjection(projection([reorderedFirst], [imageDescriptor]), {
      onProgress: (progress) => { imageNoOpLabel = progress.label; },
    });
    assert.equal(imageNoOp, true);
    assert.equal(imageBulkUpdateRows, 0, "unchanged image descriptors must not generate IndexedDB writes");
    assert.equal(imageNoOpLabel, "本机数据无需改写", "unchanged image descriptors must remain a true no-op");
    assert.ok((await dbV7.imageAssets.get(imageDescriptor.id))?.blob instanceof Blob, "no-op reconcile must preserve the cached Blob");

    const changedDescriptor = { ...imageDescriptor, width: 2 };
    await installProjection(projection([reorderedFirst], [changedDescriptor]));
    assert.equal(imageBulkUpdateRows, 1, "a genuinely changed image descriptor must update exactly once");
    const changedImage = await dbV7.imageAssets.get(imageDescriptor.id);
    assert.equal(changedImage?.width, 2);
    assert.ok(changedImage?.blob instanceof Blob, "descriptor updates must preserve the cached Blob bytes");
  } finally {
    dbV7.imageAssets.bulkUpdate = originalImageBulkUpdate;
  }

  const manyQuestions = Array.from({ length: 501 }, (_, index) => question(`bulk-${index}`, `分块比较 ${index}`));
  let questionBulkGetCalls = 0;
  const originalQuestionBulkGet = dbV7.questions.bulkGet.bind(dbV7.questions);
  dbV7.questions.bulkGet = ((keys) => {
    questionBulkGetCalls += 1;
    return originalQuestionBulkGet(keys);
  }) as typeof dbV7.questions.bulkGet;
  try {
    await installProjection(projection(manyQuestions));
  } finally {
    dbV7.questions.bulkGet = originalQuestionBulkGet;
  }
  assert.ok(questionBulkGetCalls >= 2, "large projection planning must compare rows in bounded bulkGet chunks rather than materializing the whole table");

  // Representative local-install benchmark. Current production v9 checkpoints
  // are multi-megabyte projections; use enough nested questions + attempts here
  // to expose full-dataset planning cost without turning CI into a wall-clock
  // benchmark. Deterministic row-I/O assertions are the regression gate; the
  // timings are diagnostic output for comparing phases/commits.
  await resetV7Database();
  const benchmark = benchmarkProjection(2_000, 10_000);
  const firstTimings: Array<Parameters<NonNullable<NonNullable<Parameters<typeof installProjection>[1]>["onTiming"]>>[0]> = [];
  let started = performance.now();
  const firstBenchmarkInstall = await installProjection(benchmark, { onTiming: (timing) => firstTimings.push(timing) });
  const firstDurationMs = elapsedMs(started);
  assert.equal(firstBenchmarkInstall, true);

  const noOpTimings: typeof firstTimings = [];
  started = performance.now();
  const benchmarkNoOp = await installProjection(benchmark, { onTiming: (timing) => noOpTimings.push(timing) });
  const noOpDurationMs = elapsedMs(started);
  assert.equal(benchmarkNoOp, true);
  const noOpPlanRows = noOpTimings.filter((entry) => entry.phase === "plan").reduce((sum, entry) => sum + entry.scannedRows, 0);
  const noOpWriteRows = noOpTimings.filter((entry) => entry.phase === "write").reduce((sum, entry) => sum + entry.putRows + entry.deleteRows, 0);
  assert.ok(noOpPlanRows >= 2 * (benchmark.questions.length + benchmark.attempts.length), "baseline benchmark must expose the full-table read/compare cost even when no rows are rewritten");
  assert.equal(noOpWriteRows, 0, "semantic no-op benchmark must perform zero IndexedDB mutations");

  const deltaQuestions = [...benchmark.questions];
  deltaQuestions[deltaQuestions.length - 1] = question(deltaQuestions[deltaQuestions.length - 1].id, "仅修改一道题，用于测量全量 planning 放大效应");
  const deltaProjection = { ...benchmark, questions: deltaQuestions };
  const deltaTimings: typeof firstTimings = [];
  started = performance.now();
  const deltaInstalled = await installProjection(deltaProjection, { onTiming: (timing) => deltaTimings.push(timing) });
  const deltaDurationMs = elapsedMs(started);
  assert.equal(deltaInstalled, true);
  const deltaPlanRows = deltaTimings.filter((entry) => entry.phase === "plan").reduce((sum, entry) => sum + entry.scannedRows, 0);
  const deltaWriteRows = deltaTimings.filter((entry) => entry.phase === "write").reduce((sum, entry) => sum + entry.putRows + entry.deleteRows, 0);
  assert.ok(deltaPlanRows >= 2 * (benchmark.questions.length + benchmark.attempts.length), "single-row delta currently still scans the large installed projection; later phases must deliberately reduce this metric");
  assert.equal(deltaWriteRows, 1, "single-question delta should mutate exactly one persisted row");

  const phaseDuration = (entries: typeof firstTimings, phase: "plan" | "write") => entries
    .filter((entry) => entry.phase === phase)
    .reduce((sum, entry) => sum + entry.durationMs, 0);
  console.log("sync install benchmark", JSON.stringify({
    scale: { questions: benchmark.questions.length, attempts: benchmark.attempts.length },
    first: { totalMs: Math.round(firstDurationMs), planMs: Math.round(phaseDuration(firstTimings, "plan")), writeMs: Math.round(phaseDuration(firstTimings, "write")) },
    noOp: { totalMs: Math.round(noOpDurationMs), planMs: Math.round(phaseDuration(noOpTimings, "plan")), writeMs: Math.round(phaseDuration(noOpTimings, "write")), scannedRows: noOpPlanRows, writtenRows: noOpWriteRows },
    oneQuestionDelta: { totalMs: Math.round(deltaDurationMs), planMs: Math.round(phaseDuration(deltaTimings, "plan")), writeMs: Math.round(phaseDuration(deltaTimings, "write")), scannedRows: deltaPlanRows, writtenRows: deltaWriteRows },
  }));
} finally {
  dbV7.questions.clear = originalQuestionClear;
  await resetV7Database();
  dbV7.close();
}

console.log("iOS incremental install regression tests passed: add/update/delete without clear, semantic no-op without rewrite, install timing benchmark");
