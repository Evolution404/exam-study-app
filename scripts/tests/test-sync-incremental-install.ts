import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { studyDb, resetDatabase } from "../../src/lib/db/db";
import { decomposePracticeRun } from "../../src/lib/db/practice-run-store";
import { installProjection } from "../../src/lib/sync/sync-checkpoint-bridge";
import { deriveDirtyInstallKeys } from "../../src/lib/sync/sync-dirty-install";
import type { ChangeSetProjection } from "../../src/lib/sync/change-set-projection";
import type { ChangeSetMutation, ChangeSet } from "../../src/lib/sync/change-set-types";
import type { Question } from "../../src/lib/db/types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => "device-ios-regression",
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

function question(id: string, stem: string): Question {
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

function projection(questions: Question[], imageAssets: ChangeSetProjection["imageAssets"] = []): ChangeSetProjection {
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

function benchmarkProjection(questionCount: number, attemptCount: number): ChangeSetProjection {
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
  return { ...projection(questions), attempts } as ChangeSetProjection;
}

function changeSet(mutations: ChangeSetMutation[], sequence = 1): ChangeSet {
  return {
    formatVersion: 7,
    id: `dirty-${sequence}`,
    deviceId: "device-remote",
    localSequence: sequence,
    createdAt: "2026-08-30T00:00:00.000Z",
    kind: mutations.length === 1 ? mutations[0].kind : "batch",
    mutations,
    entityRefs: [],
    digest: "0".repeat(64),
  };
}

function elapsedMs(started: number): number {
  return Math.max(0, performance.now() - started);
}

await resetDatabase();
const first = question("q-1", "已有本地题目");
const second = question("q-2", "远端仅新增的一道题");
await studyDb.questions.put(first);

let questionClearCalls = 0;
const originalQuestionClear = studyDb.questions.clear.bind(studyDb.questions);
studyDb.questions.clear = () => {
  questionClearCalls += 1;
  return originalQuestionClear();
};

try {
  const installed = await installProjection(projection([first, second]));
  assert.equal(installed, true, "ordinary projection update should complete");
  assert.equal(await studyDb.questions.count(), 2, "incremental install should persist the unseen question");
  assert.equal(
    questionClearCalls,
    0,
    "existing local projection must be reconciled in place; ordinary unseen delta must not clear and rebuild the questions store",
  );

  const updatedFirst = question("q-1", "远端更新后的题目");
  const reconciled = await installProjection(projection([updatedFirst]));
  assert.equal(reconciled, true, "ordinary projection update/delete should complete");
  assert.equal(await studyDb.questions.count(), 1, "incremental reconciliation should delete rows absent from the target projection");
  assert.equal(await studyDb.questions.get("q-2"), undefined, "incremental reconciliation should delete the removed remote question");
  assert.deepEqual((await studyDb.questions.get("q-1"))?.content, updatedFirst.content, "incremental reconciliation should update changed rows");
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
  } as Question;
  let finalProgressLabel = "";
  const noOp = await installProjection(projection([reorderedFirst]), {
    onProgress: (progress) => { finalProgressLabel = progress.label; },
  });
  assert.equal(noOp, true, "semantically identical projection should complete");
  assert.equal(finalProgressLabel, "本机数据无需改写", "property-order-only differences must not create needless IndexedDB writes");

  const imageDescriptor = { id: "a".repeat(64), mimeType: "image/webp" as const, size: 4, width: 1, height: 1 };
  await studyDb.transaction("rw", [studyDb.imageAssets, studyDb.imageBlobs], async () => {
    await studyDb.imageAssets.put(imageDescriptor);
    await studyDb.imageBlobs.put({ assetId: imageDescriptor.id, blob: new Blob(["img!"], { type: "image/webp" }) });
  });
  let imageBulkUpdateRows = 0;
  const originalImageBulkUpdate = studyDb.imageAssets.bulkUpdate.bind(studyDb.imageAssets);
  studyDb.imageAssets.bulkUpdate = ((updates) => {
    imageBulkUpdateRows += updates.length;
    return originalImageBulkUpdate(updates);
  }) as typeof studyDb.imageAssets.bulkUpdate;
  try {
    let imageNoOpLabel = "";
    const imageNoOp = await installProjection(projection([reorderedFirst], [imageDescriptor]), {
      onProgress: (progress) => { imageNoOpLabel = progress.label; },
    });
    assert.equal(imageNoOp, true);
    assert.equal(imageBulkUpdateRows, 0, "unchanged image descriptors must not generate IndexedDB writes");
    assert.equal(imageNoOpLabel, "本机数据无需改写", "unchanged image descriptors must remain a true no-op");
    assert.ok((await studyDb.imageBlobs.get(imageDescriptor.id))?.blob instanceof Blob, "no-op reconcile must preserve the cached Blob");

    const changedDescriptor = { ...imageDescriptor, width: 2 };
    await installProjection(projection([reorderedFirst], [changedDescriptor]));
    assert.equal(imageBulkUpdateRows, 1, "a genuinely changed image descriptor must update exactly once");
    const changedImage = await studyDb.imageAssets.get(imageDescriptor.id);
    assert.equal(changedImage?.width, 2);
    assert.ok((await studyDb.imageBlobs.get(imageDescriptor.id))?.blob instanceof Blob, "descriptor updates must preserve the cached Blob bytes");
    assert.equal("blob" in (changedImage as Record<string, unknown>), false, "reconcile must never copy cache bytes back into imageAssets");
  } finally {
    studyDb.imageAssets.bulkUpdate = originalImageBulkUpdate;
  }

  const manyQuestions = Array.from({ length: 501 }, (_, index) => question(`bulk-${index}`, `分块比较 ${index}`));
  let questionBulkGetCalls = 0;
  const originalQuestionBulkGet = studyDb.questions.bulkGet.bind(studyDb.questions);
  studyDb.questions.bulkGet = ((keys) => {
    questionBulkGetCalls += 1;
    return originalQuestionBulkGet(keys);
  }) as typeof studyDb.questions.bulkGet;
  try {
    await installProjection(projection(manyQuestions));
  } finally {
    studyDb.questions.bulkGet = originalQuestionBulkGet;
  }
  assert.ok(questionBulkGetCalls >= 2, "large projection planning must compare rows in bounded bulkGet chunks rather than materializing the whole table");

  // Representative local-install benchmark. Deterministic row-I/O assertions
  // are the regression gate; timings remain diagnostic so CI runner variance
  // cannot create false performance failures.
  await resetDatabase();
  const benchmark = benchmarkProjection(2_000, 10_000);
  const firstTimings: Array<Parameters<NonNullable<NonNullable<Parameters<typeof installProjection>[1]>["onTiming"]>>[0]> = [];
  let started = performance.now();
  const firstBenchmarkInstall = await installProjection(benchmark, { onTiming: (timing) => firstTimings.push(timing) });
  const firstDurationMs = elapsedMs(started);
  assert.equal(firstBenchmarkInstall, true);
  assert.ok(firstTimings.every((entry) => entry.mode === "fresh"), "empty database benchmark must use fresh-install mode");

  const noOpTimings: typeof firstTimings = [];
  started = performance.now();
  const benchmarkNoOp = await installProjection(benchmark, { onTiming: (timing) => noOpTimings.push(timing) });
  const noOpDurationMs = elapsedMs(started);
  assert.equal(benchmarkNoOp, true);
  const noOpPlanRows = noOpTimings.filter((entry) => entry.phase === "plan").reduce((sum, entry) => sum + entry.scannedRows, 0);
  const noOpWriteRows = noOpTimings.filter((entry) => entry.phase === "write").reduce((sum, entry) => sum + entry.putRows + entry.deleteRows, 0);
  assert.ok(noOpPlanRows >= 2 * (benchmark.questions.length + benchmark.attempts.length), "full no-op baseline must expose the installed-table read/compare cost");
  assert.equal(noOpWriteRows, 0, "semantic no-op benchmark must perform zero IndexedDB mutations");

  const deltaQuestions = [...benchmark.questions];
  deltaQuestions[deltaQuestions.length - 1] = question(deltaQuestions[deltaQuestions.length - 1].id, "仅修改一道题，用于验证 dirty-key 安装");
  const deltaProjection = { ...benchmark, questions: deltaQuestions };
  const changedQuestion = deltaQuestions[deltaQuestions.length - 1];
  const deltaKeys = await deriveDirtyInstallKeys(deltaProjection, [changeSet([{ kind: "question.upsert", question: changedQuestion }])]);
  assert.ok(deltaKeys, "simple question upsert must be eligible for dirty install");
  assert.deepEqual(deltaKeys.questions, [changedQuestion.id]);

  let dirtyQuestionBulkGetCalls = 0;
  let dirtyAttemptBulkGetCalls = 0;
  const originalDirtyQuestionBulkGet = studyDb.questions.bulkGet.bind(studyDb.questions);
  const originalDirtyAttemptBulkGet = studyDb.attempts.bulkGet.bind(studyDb.attempts);
  studyDb.questions.bulkGet = ((keys) => {
    dirtyQuestionBulkGetCalls += 1;
    return originalDirtyQuestionBulkGet(keys);
  }) as typeof studyDb.questions.bulkGet;
  studyDb.attempts.bulkGet = ((keys) => {
    dirtyAttemptBulkGetCalls += 1;
    return originalDirtyAttemptBulkGet(keys);
  }) as typeof studyDb.attempts.bulkGet;
  const deltaTimings: typeof firstTimings = [];
  started = performance.now();
  try {
    const deltaInstalled = await installProjection(deltaProjection, { dirtyKeys: deltaKeys, onTiming: (timing) => deltaTimings.push(timing) });
    assert.equal(deltaInstalled, true);
  } finally {
    studyDb.questions.bulkGet = originalDirtyQuestionBulkGet;
    studyDb.attempts.bulkGet = originalDirtyAttemptBulkGet;
  }
  const deltaDurationMs = elapsedMs(started);
  const deltaPlanRows = deltaTimings.filter((entry) => entry.phase === "plan").reduce((sum, entry) => sum + entry.scannedRows, 0);
  const deltaWriteRows = deltaTimings.filter((entry) => entry.phase === "write").reduce((sum, entry) => sum + entry.putRows + entry.deleteRows, 0);
  const dirtyQuestionWriteRows = deltaTimings.filter((entry) => entry.phase === "write" && entry.table === studyDb.questions.name).reduce((sum, entry) => sum + entry.putRows + entry.deleteRows, 0);
  const dirtyTombstoneDeleteRows = deltaTimings.filter((entry) => entry.phase === "write" && entry.table === studyDb.tombstones.name).reduce((sum, entry) => sum + entry.deleteRows, 0);
  assert.ok(deltaTimings.every((entry) => entry.mode === "dirty"), "single-question delta must stay on dirty install mode");
  assert.equal(deltaPlanRows, 0, "dirty installer must not scan installed IndexedDB tables");
  assert.equal(dirtyQuestionBulkGetCalls, 0, "dirty question install must not bulkGet the full questions table");
  assert.equal(dirtyAttemptBulkGetCalls, 0, "unrelated attempts must not be read for a question-only delta");
  assert.equal(dirtyQuestionWriteRows, 1, "single-question dirty delta must write exactly one question row");
  assert.equal(dirtyTombstoneDeleteRows, 1, "question upsert must explicitly mirror the reducer's tombstone clear");
  assert.equal(deltaWriteRows, 2, "single-question dirty delta is one question put plus one idempotent tombstone clear");
  assert.deepEqual((await studyDb.questions.get(changedQuestion.id))?.content, changedQuestion.content);

  const phaseDuration = (entries: typeof firstTimings, phase: "plan" | "write") => entries
    .filter((entry) => entry.phase === phase)
    .reduce((sum, entry) => sum + entry.durationMs, 0);
  console.log("sync install benchmark", JSON.stringify({
    scale: { questions: benchmark.questions.length, attempts: benchmark.attempts.length },
    first: { totalMs: Math.round(firstDurationMs), planMs: Math.round(phaseDuration(firstTimings, "plan")), writeMs: Math.round(phaseDuration(firstTimings, "write")) },
    noOpFull: { totalMs: Math.round(noOpDurationMs), planMs: Math.round(phaseDuration(noOpTimings, "plan")), writeMs: Math.round(phaseDuration(noOpTimings, "write")), scannedRows: noOpPlanRows, writtenRows: noOpWriteRows },
    oneQuestionDirty: { totalMs: Math.round(deltaDurationMs), planMs: Math.round(phaseDuration(deltaTimings, "plan")), writeMs: Math.round(phaseDuration(deltaTimings, "write")), scannedRows: deltaPlanRows, writtenRows: deltaWriteRows },
  }));

  // Membership closure: moving one membership must include both affected bank
  // rows so derived questionCount stays exact without a full table reconcile.
  await resetDatabase();
  const relationQuestion = question("rel-q", "题库关系闭包");
  const bankA = { id: "bank-a", name: "A", description: "", color: "#000000", folderId: undefined, sortOrder: 0, questionCount: 1, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", deviceId: "device-a" };
  const bankB = { ...bankA, id: "bank-b", name: "B", sortOrder: 1, questionCount: 0 };
  const oldMembership = { key: "bank-a:rel-q", bankId: "bank-a", questionId: "rel-q", sortOrder: 0, addedAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", deviceId: "device-a" };
  const newMembership = { ...oldMembership, key: "bank-b:rel-q", bankId: "bank-b", deviceId: "device-remote" };
  await studyDb.banks.bulkPut([bankA, bankB]);
  await studyDb.questions.put(relationQuestion);
  await studyDb.bankQuestionMemberships.put(oldMembership);
  const relationTarget: ChangeSetProjection = {
    ...projection([relationQuestion]),
    banks: [{ ...bankA, questionCount: 0 }, { ...bankB, questionCount: 1 }],
    memberships: [newMembership],
    tombstones: [{ key: oldMembership.key.startsWith("membership:") ? oldMembership.key : `membership:${oldMembership.key}`, entityType: "membership", entityId: oldMembership.key, deletedAt: "2026-08-30T00:00:01.000Z", deviceId: "device-remote", eventId: "dirty-rel", sequence: 2 }],
  };
  const relationKeys = await deriveDirtyInstallKeys(relationTarget, [changeSet([
    { kind: "membership.remove", bankId: "bank-a", questionId: "rel-q", key: oldMembership.key, removedAt: "2026-08-30T00:00:01.000Z" },
    { kind: "membership.save", membership: newMembership },
  ], 2)]);
  assert.ok(relationKeys);
  assert.deepEqual(relationKeys.banks, ["bank-a", "bank-b"]);
  assert.deepEqual(relationKeys.memberships, ["bank-a:rel-q", "bank-b:rel-q"]);
  assert.equal(await installProjection(relationTarget, { dirtyKeys: relationKeys }), true);
  assert.equal((await studyDb.banks.get("bank-a"))?.questionCount, 0);
  assert.equal((await studyDb.banks.get("bank-b"))?.questionCount, 1);
  assert.equal(await studyDb.bankQuestionMemberships.get([oldMembership.bankId, oldMembership.questionId]), undefined);
  assert.equal((await studyDb.bankQuestionMemberships.get([newMembership.bankId, newMembership.questionId]))?.bankId, "bank-b");

  // Attempt closure: moving an attempt between questions must clean the old and
  // install the new per-question stats, daily stats and round progress keys.
  await resetDatabase();
  const attemptQ1 = question("attempt-q1", "作答闭包旧题");
  const attemptQ2 = question("attempt-q2", "作答闭包新题");
  const attemptBank = { ...bankA, id: "attempt-bank", name: "Attempt", questionCount: 2 };
  const round = { id: "round-1", name: "R", bankIds: [attemptBank.id], startedAt: "2026-08-30T00:00:00.000Z", status: "active" as const, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", deviceId: "device-a" };
  const run = { id: "run-1", bankId: attemptBank.id, bankIds: [attemptBank.id], bankName: "Attempt", mode: "sequential" as const, modeLabel: "练习", questionIds: [attemptQ1.id, attemptQ2.id], questionTypes: { [attemptQ1.id]: attemptQ1.type, [attemptQ2.id]: attemptQ2.type }, answers: {}, shuffleOptions: false, optionOrders: {}, startedAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", status: "in_progress" as const, revision: 0, reviewRoundId: round.id };
  const oldAttempt = { id: "attempt-1", runId: run.id, questionId: attemptQ1.id, selected: "A", correct: false, elapsedMs: 1000, createdAt: "2026-08-30T00:00:01.000Z", deviceId: "device-a" };
  const newAttempt = { ...oldAttempt, questionId: attemptQ2.id, correct: true, deviceId: "device-remote" };
  const oldStats = { questionId: attemptQ1.id, total: 1, correct: 0, wrong: 1, giveUps: 0, totalElapsedMs: 1000, firstAttemptAt: oldAttempt.createdAt, firstAttemptCorrect: false, latestAttemptAt: oldAttempt.createdAt, hasBeenWrong: true, correctStreakAfterWrong: 0, currentCorrectStreak: 0, recentOutcomes: [{ id: oldAttempt.id, createdAt: oldAttempt.createdAt, correct: false, elapsedMs: 1000 }] };
  const newStats = { ...oldStats, questionId: attemptQ2.id, correct: 1, wrong: 0, firstAttemptCorrect: true, hasBeenWrong: false, currentCorrectStreak: 1, recentOutcomes: [{ id: newAttempt.id, createdAt: newAttempt.createdAt, correct: true, elapsedMs: 1000 }] };
  const oldDaily = { key: `2026-08-30:${attemptQ1.id}`, date: "2026-08-30", questionId: attemptQ1.id, total: 1, correct: 0, wrong: 1, giveUps: 0, totalElapsedMs: 1000 };
  const newDaily = { ...oldDaily, key: `2026-08-30:${attemptQ2.id}`, questionId: attemptQ2.id, correct: 1, wrong: 0 };
  const oldRoundProgress = { key: `${round.id}:${attemptQ1.id}`, roundId: round.id, questionId: attemptQ1.id, attempts: 1, correct: 0, wrong: 1, firstAttemptAt: oldAttempt.createdAt, latestAttemptAt: oldAttempt.createdAt, giveUps: 0, totalElapsedMs: 1000, firstAttemptCorrect: false, hasBeenWrong: true, currentCorrectStreak: 0, correctStreakAfterWrong: 0, recentOutcomes: oldStats.recentOutcomes };
  const newRoundProgress = { ...oldRoundProgress, key: `${round.id}:${attemptQ2.id}`, questionId: attemptQ2.id, correct: 1, wrong: 0, firstAttemptCorrect: true, hasBeenWrong: false, currentCorrectStreak: 1, recentOutcomes: newStats.recentOutcomes };
  await studyDb.banks.put(attemptBank);
  await studyDb.questions.bulkPut([attemptQ1, attemptQ2]);
  const runBundle = decomposePracticeRun(run, []);
  await studyDb.practiceRuns.put(runBundle.record);
  await studyDb.practiceRunSources.bulkPut(runBundle.sources);
  await studyDb.practiceRunItems.bulkPut(runBundle.items);
  const { bankIds: _roundBankIds, finalQuestionIds: _roundItems, ...roundRecord } = round;
  void _roundBankIds;
  void _roundItems;
  await studyDb.reviewRounds.put(roundRecord);
  await studyDb.reviewRoundBanks.put({ roundId: round.id, bankId: attemptBank.id, position: 0 });
  await studyDb.attempts.put(oldAttempt);
  await studyDb.questionProgress.put(oldStats);
  await studyDb.questionDailyProgress.put(oldDaily);
  await studyDb.reviewRoundProgress.put(oldRoundProgress);
  const attemptTarget: ChangeSetProjection = {
    ...projection([attemptQ1, attemptQ2]),
    banks: [attemptBank],
    attempts: [newAttempt],
    attemptStats: [newStats],
    attemptDailyStats: [newDaily],
    practiceRuns: [run],
    reviewRounds: [round],
    reviewRoundProgress: [newRoundProgress],
  } as ChangeSetProjection;
  const attemptKeys = await deriveDirtyInstallKeys(attemptTarget, [changeSet([{ kind: "attempt.update", attempt: newAttempt, reviewRoundId: round.id }], 3)]);
  assert.ok(attemptKeys);
  assert.deepEqual(attemptKeys.attemptStats, [attemptQ1.id, attemptQ2.id].sort());
  assert.deepEqual(attemptKeys.attemptDailyStats, [oldDaily.key, newDaily.key].sort());
  assert.deepEqual(attemptKeys.reviewRoundProgress, [oldRoundProgress.key, newRoundProgress.key].sort());
  assert.equal(await installProjection(attemptTarget, { dirtyKeys: attemptKeys }), true);
  assert.equal((await studyDb.attempts.get(oldAttempt.id))?.questionId, attemptQ2.id);
  assert.equal(await studyDb.questionProgress.get(attemptQ1.id), undefined);
  assert.equal((await studyDb.questionProgress.get(attemptQ2.id))?.correct, 1);
  assert.equal(await studyDb.questionDailyProgress.get([oldDaily.date, oldDaily.questionId]), undefined);
  assert.equal((await studyDb.questionDailyProgress.get([newDaily.date, newDaily.questionId]))?.questionId, attemptQ2.id);
  assert.equal(await studyDb.reviewRoundProgress.get([oldRoundProgress.roundId, oldRoundProgress.questionId]), undefined);
  assert.equal((await studyDb.reviewRoundProgress.get([newRoundProgress.roundId, newRoundProgress.questionId]))?.questionId, attemptQ2.id);

  const cascadeKeys = await deriveDirtyInstallKeys(projection([]), [changeSet([{ kind: "question.delete.cascade", questionId: "unsafe-cascade", deletedAt: "2026-08-30T00:00:02.000Z" }], 4)]);
  assert.equal(cascadeKeys, null, "question cascade must force the orchestrator back to full reconcile");
} finally {
  studyDb.questions.clear = originalQuestionClear;
  await resetDatabase();
  studyDb.close();
}

console.log("iOS incremental install regression tests passed: full/fresh/dirty install modes, dirty closures and cascade fallback");
