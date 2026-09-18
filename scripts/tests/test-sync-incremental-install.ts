import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { studyDb, resetDatabase } from "../../src/lib/db/db";
import { installCanonicalState } from "../../src/lib/sync/sync-checkpoint-bridge";
import { deriveDirtyInstallKeys } from "../../src/lib/sync/sync-dirty-install";
import type { ChangeSetMutation, ChangeSet } from "../../src/lib/sync/change-set-types";
import type {
  Bank,
  CanonicalState,
  ImageAssetDescriptor,
  PracticeRunItem,
  PracticeRunRecord,
  PracticeRunSource,
  Question,
  ReviewRoundRecord,
} from "../../src/lib/db/types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => "device-ios-regression",
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

const AT = "2026-08-30T00:00:00.000Z";

function question(id: string, stem: string): Question {
  return {
    id,
    type: "单选",
    content: [{ id: `${id}-stem`, type: "text", text: stem }],
    options: ["甲", "乙"].map((text, index) => [{ id: `${id}-opt-${index}`, type: "text", text }]),
    solution: { kind: "choice", correctOptionIds: [`${id}-opt-0`] },
    tags: [],
    contentFingerprint: `fp-${id}-${stem}`,
    updatedAt: "2026-08-25T00:00:00.000Z",
    deviceId: "device-a",
  };
}

function state(questions: Question[], imageAssets: ImageAssetDescriptor[] = []): CanonicalState {
  return {
    banks: [],
    bankFolders: [],
    questions,
    memberships: [],
    imageAssets,
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

function benchmarkState(questionCount: number, attemptCount: number): CanonicalState {
  const questions = Array.from(
    { length: questionCount },
    (_, index) => question(`bench-q-${index}`, `同步性能基准题目 ${index}：${"输电线路运行维护".repeat(4)}`),
  );
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
  return { ...state(questions), attempts };
}

function changeSet(mutations: ChangeSetMutation[], sequence = 1): ChangeSet {
  return {
    formatVersion: 7,
    id: `dirty-${sequence}`,
    deviceId: "device-remote",
    localSequence: sequence,
    createdAt: AT,
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
  const installed = await installCanonicalState(state([first, second]));
  assert.equal(installed, true);
  assert.equal(await studyDb.questions.count(), 2);
  assert.equal(questionClearCalls, 0, "ordinary canonical install must reconcile in place");

  const updatedFirst = question("q-1", "远端更新后的题目");
  const reconciled = await installCanonicalState(state([updatedFirst]));
  assert.equal(reconciled, true);
  assert.equal(await studyDb.questions.count(), 1);
  assert.equal(await studyDb.questions.get("q-2"), undefined);
  assert.deepEqual((await studyDb.questions.get("q-1"))?.content, updatedFirst.content);
  assert.equal(questionClearCalls, 0);

  const reorderedFirst = {
    deviceId: updatedFirst.deviceId,
    updatedAt: updatedFirst.updatedAt,
    contentFingerprint: updatedFirst.contentFingerprint,
    tags: [...updatedFirst.tags],
    solution: structuredClone(updatedFirst.solution),
    options: updatedFirst.options.map((option) => option.map((block) => ({ ...block }))),
    content: updatedFirst.content.map((block) => ({ ...block })),
    type: updatedFirst.type,
    id: updatedFirst.id,
  } as Question;

  let finalProgressLabel = "";
  const noOp = await installCanonicalState(state([reorderedFirst]), {
    onProgress: (progress) => { finalProgressLabel = progress.label; },
  });
  assert.equal(noOp, true);
  assert.equal(finalProgressLabel, "本机数据无需改写", "property order must not generate writes");

  const imageDescriptor: ImageAssetDescriptor = {
    id: "a".repeat(64),
    mimeType: "image/webp",
    size: 4,
    width: 1,
    height: 1,
  };
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
    const imageNoOp = await installCanonicalState(state([reorderedFirst], [imageDescriptor]), {
      onProgress: (progress) => { imageNoOpLabel = progress.label; },
    });
    assert.equal(imageNoOp, true);
    assert.equal(imageBulkUpdateRows, 0);
    assert.equal(imageNoOpLabel, "本机数据无需改写");
    assert.ok((await studyDb.imageBlobs.get(imageDescriptor.id))?.blob instanceof Blob);

    const changedDescriptor = { ...imageDescriptor, width: 2 };
    await installCanonicalState(state([reorderedFirst], [changedDescriptor]));
    assert.equal(imageBulkUpdateRows, 1);
    const changedImage = await studyDb.imageAssets.get(imageDescriptor.id);
    assert.equal(changedImage?.width, 2);
    assert.ok((await studyDb.imageBlobs.get(imageDescriptor.id))?.blob instanceof Blob);
    assert.equal("blob" in (changedImage as Record<string, unknown>), false);
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
    await installCanonicalState(state(manyQuestions));
  } finally {
    studyDb.questions.bulkGet = originalQuestionBulkGet;
  }
  assert.ok(questionBulkGetCalls >= 2, "full reconcile must compare large tables in bounded chunks");

  // Representative full/fresh/dirty install benchmark.
  await resetDatabase();
  const benchmark = benchmarkState(2_000, 10_000);
  type Timing = Parameters<NonNullable<NonNullable<Parameters<typeof installCanonicalState>[1]>["onTiming"]>>[0];
  const firstTimings: Timing[] = [];
  let started = performance.now();
  assert.equal(await installCanonicalState(benchmark, { onTiming: (timing) => firstTimings.push(timing) }), true);
  const firstDurationMs = elapsedMs(started);
  assert.ok(firstTimings.every((entry) => entry.mode === "fresh"));

  const noOpTimings: Timing[] = [];
  started = performance.now();
  assert.equal(await installCanonicalState(benchmark, { onTiming: (timing) => noOpTimings.push(timing) }), true);
  const noOpDurationMs = elapsedMs(started);
  const noOpPlanRows = noOpTimings.filter((entry) => entry.phase === "plan").reduce((sum, entry) => sum + entry.scannedRows, 0);
  const noOpWriteRows = noOpTimings.filter((entry) => entry.phase === "write").reduce((sum, entry) => sum + entry.putRows + entry.deleteRows, 0);
  assert.ok(noOpPlanRows >= 2 * (benchmark.questions.length + benchmark.attempts.length));
  assert.equal(noOpWriteRows, 0);

  const deltaQuestions = [...benchmark.questions];
  deltaQuestions[deltaQuestions.length - 1] = question(deltaQuestions[deltaQuestions.length - 1].id, "仅修改一道题，用于验证 dirty-key 安装");
  const deltaState = { ...benchmark, questions: deltaQuestions };
  const changedQuestion = deltaQuestions[deltaQuestions.length - 1];
  const deltaKeys = await deriveDirtyInstallKeys(deltaState, [changeSet([{ kind: "question.upsert", question: changedQuestion }])]);
  assert.ok(deltaKeys);
  assert.deepEqual(deltaKeys.questions, [changedQuestion.id]);
  assert.equal("attemptStats" in deltaKeys, false);
  assert.equal("attemptDailyStats" in deltaKeys, false);
  assert.equal("reviewRoundProgress" in deltaKeys, false);

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

  const deltaTimings: Timing[] = [];
  started = performance.now();
  try {
    assert.equal(await installCanonicalState(deltaState, {
      dirtyKeys: deltaKeys,
      onTiming: (timing) => deltaTimings.push(timing),
    }), true);
  } finally {
    studyDb.questions.bulkGet = originalDirtyQuestionBulkGet;
    studyDb.attempts.bulkGet = originalDirtyAttemptBulkGet;
  }
  const deltaDurationMs = elapsedMs(started);
  const deltaPlanRows = deltaTimings.filter((entry) => entry.phase === "plan").reduce((sum, entry) => sum + entry.scannedRows, 0);
  const deltaWriteRows = deltaTimings.filter((entry) => entry.phase === "write").reduce((sum, entry) => sum + entry.putRows + entry.deleteRows, 0);
  const dirtyQuestionWriteRows = deltaTimings
    .filter((entry) => entry.phase === "write" && entry.table === studyDb.questions.name)
    .reduce((sum, entry) => sum + entry.putRows + entry.deleteRows, 0);
  assert.ok(deltaTimings.every((entry) => entry.mode === "dirty"));
  assert.equal(deltaPlanRows, 0);
  assert.equal(dirtyQuestionBulkGetCalls, 0);
  assert.equal(dirtyAttemptBulkGetCalls, 0);
  assert.equal(dirtyQuestionWriteRows, 1);
  assert.equal(deltaWriteRows, 2, "question put + idempotent question tombstone clear");
  assert.deepEqual((await studyDb.questions.get(changedQuestion.id))?.content, changedQuestion.content);

  const phaseDuration = (entries: Timing[], phase: "plan" | "write") => entries
    .filter((entry) => entry.phase === phase)
    .reduce((sum, entry) => sum + entry.durationMs, 0);
  console.log("sync install benchmark", JSON.stringify({
    scale: { questions: benchmark.questions.length, attempts: benchmark.attempts.length },
    first: { totalMs: Math.round(firstDurationMs), planMs: Math.round(phaseDuration(firstTimings, "plan")), writeMs: Math.round(phaseDuration(firstTimings, "write")) },
    noOpFull: { totalMs: Math.round(noOpDurationMs), planMs: Math.round(phaseDuration(noOpTimings, "plan")), writeMs: Math.round(phaseDuration(noOpTimings, "write")), scannedRows: noOpPlanRows, writtenRows: noOpWriteRows },
    oneQuestionDirty: { totalMs: Math.round(deltaDurationMs), planMs: Math.round(phaseDuration(deltaTimings, "plan")), writeMs: Math.round(phaseDuration(deltaTimings, "write")), scannedRows: deltaPlanRows, writtenRows: deltaWriteRows },
  }));

  // Membership closure remains canonical-only. Bank question counts are a
  // device-local projection and must not expand relation dirtiness into banks.
  await resetDatabase();
  const relationQuestion = question("rel-q", "题库关系闭包");
  const bankA: Bank = { id: "bank-a", name: "A", sortOrder: 0, importedAt: AT, updatedAt: AT, deviceId: "device-a" };
  const bankB: Bank = { ...bankA, id: "bank-b", name: "B", sortOrder: 1 };
  const oldMembership = { key: "bank-a:rel-q", bankId: "bank-a", questionId: "rel-q", sortOrder: 0, addedAt: AT, updatedAt: AT, deviceId: "device-a" };
  const newMembership = { ...oldMembership, key: "bank-b:rel-q", bankId: "bank-b", deviceId: "device-remote" };
  await studyDb.banks.bulkPut([bankA, bankB]);
  await studyDb.questions.put(relationQuestion);
  await studyDb.bankQuestionMemberships.put(oldMembership);

  const relationTarget: CanonicalState = {
    ...state([relationQuestion]),
    banks: [bankA, bankB],
    memberships: [newMembership],
    tombstones: [{
      key: `membership:${oldMembership.key}`,
      entityType: "membership",
      entityId: oldMembership.key,
      deletedAt: "2026-08-30T00:00:01.000Z",
      deviceId: "device-remote",
      eventId: "dirty-rel",
      sequence: 2,
    }],
  };
  const relationKeys = await deriveDirtyInstallKeys(relationTarget, [changeSet([
    { kind: "membership.remove", bankId: "bank-a", questionId: "rel-q", key: oldMembership.key, removedAt: "2026-08-30T00:00:01.000Z" },
    { kind: "membership.save", membership: newMembership },
  ], 2)]);
  assert.ok(relationKeys);
  assert.deepEqual(relationKeys.banks, []);
  assert.deepEqual(relationKeys.memberships, ["bank-a:rel-q", "bank-b:rel-q"]);
  assert.equal(await installCanonicalState(relationTarget, { dirtyKeys: relationKeys }), true);
  assert.equal((await studyDb.bankQuestionStats.get("bank-a"))?.questionCount ?? 0, 0);
  assert.equal((await studyDb.bankQuestionStats.get("bank-b"))?.questionCount, 1);
  assert.equal(await studyDb.bankQuestionMemberships.get(["bank-a", "rel-q"]), undefined);
  assert.equal((await studyDb.bankQuestionMemberships.get(["bank-b", "rel-q"]))?.bankId, "bank-b");

  // Attempt closure: dirty keys contain only the new canonical Attempt.
  // question/daily/round projections are rebuilt after canonical install.
  await resetDatabase();
  const attemptQ1 = question("attempt-q1", "作答闭包旧题");
  const attemptQ2 = question("attempt-q2", "作答闭包新题");
  const attemptBank: Bank = { ...bankA, id: "attempt-bank", name: "Attempt" };
  const roundRecord: ReviewRoundRecord = {
    id: "round-1",
    name: "R",
    startedAt: AT,
    status: "active",
    createdAt: AT,
    updatedAt: AT,
    deviceId: "device-a",
  };
  const runRecord: PracticeRunRecord = {
    id: "run-1",
    mode: "sequential",
    modeLabel: "练习",
    shuffleOptions: false,
    startedAt: AT,
    updatedAt: AT,
    status: "in_progress",
    revision: 0,
    bankNameSnapshot: "Attempt",
    activityAt: AT,
    reviewRoundId: roundRecord.id,
  };
  const runSource: PracticeRunSource = {
    runId: runRecord.id,
    bankId: attemptBank.id,
    bankNameSnapshot: "Attempt",
    position: 0,
  };
  const runItems: PracticeRunItem[] = [
    { runId: runRecord.id, questionId: attemptQ1.id, position: 0, questionTypeSnapshot: attemptQ1.type, optionOrder: [] },
    { runId: runRecord.id, questionId: attemptQ2.id, position: 1, questionTypeSnapshot: attemptQ2.type, optionOrder: [] },
  ];
  const oldAttempt = {
    id: "attempt-1",
    runId: runRecord.id,
    questionId: attemptQ1.id,
    reviewRoundId: roundRecord.id,
    selected: "A",
    correct: false,
    elapsedMs: 1000,
    createdAt: "2026-08-30T00:00:01.000Z",
    deviceId: "device-a",
  };
  const newAttempt = {
    ...oldAttempt,
    id: "attempt-2",
    questionId: attemptQ2.id,
    correct: true,
    createdAt: "2026-08-30T00:00:02.000Z",
    deviceId: "device-remote",
  };

  await studyDb.banks.put(attemptBank);
  await studyDb.questions.bulkPut([attemptQ1, attemptQ2]);
  await studyDb.practiceRuns.put(runRecord);
  await studyDb.practiceRunSources.put(runSource);
  await studyDb.practiceRunItems.bulkPut(runItems);
  await studyDb.reviewRounds.put(roundRecord);
  await studyDb.reviewRoundBanks.put({ roundId: roundRecord.id, bankId: attemptBank.id, position: 0 });
  await studyDb.attempts.put(oldAttempt);

  // Seed local projections from the old canonical facts.
  const initialTarget: CanonicalState = {
    ...state([attemptQ1, attemptQ2]),
    banks: [attemptBank],
    attempts: [oldAttempt],
    practiceRuns: [runRecord],
    practiceRunSources: [runSource],
    practiceRunItems: runItems,
    reviewRounds: [roundRecord],
    reviewRoundBanks: [{ roundId: roundRecord.id, bankId: attemptBank.id, position: 0 }],
  };
  await installCanonicalState(initialTarget);
  assert.equal((await studyDb.questionProgress.get(attemptQ1.id))?.wrong, 1);

  const attemptTarget: CanonicalState = { ...initialTarget, attempts: [oldAttempt, newAttempt] };
  const attemptKeys = await deriveDirtyInstallKeys(attemptTarget, [changeSet([{ kind: "attempt.create", attempt: newAttempt }], 3)]);
  assert.ok(attemptKeys);
  assert.deepEqual(attemptKeys.attempts, [newAttempt.id]);
  assert.equal("attemptStats" in attemptKeys, false);
  assert.equal("attemptDailyStats" in attemptKeys, false);
  assert.equal("reviewRoundProgress" in attemptKeys, false);

  assert.equal(await installCanonicalState(attemptTarget, { dirtyKeys: attemptKeys }), true);
  assert.equal((await studyDb.attempts.get(oldAttempt.id))?.questionId, attemptQ1.id);
  assert.equal((await studyDb.attempts.get(newAttempt.id))?.questionId, attemptQ2.id);
  assert.equal((await studyDb.questionProgress.get(attemptQ1.id))?.wrong, 1);
  assert.equal((await studyDb.questionProgress.get(attemptQ2.id))?.correct, 1);
  assert.equal((await studyDb.questionDailyProgress.get(["2026-08-30", attemptQ1.id]))?.questionId, attemptQ1.id);
  assert.equal((await studyDb.questionDailyProgress.get(["2026-08-30", attemptQ2.id]))?.questionId, attemptQ2.id);
  assert.equal((await studyDb.reviewRoundProgress.get([roundRecord.id, attemptQ1.id]))?.questionId, attemptQ1.id);
  assert.equal((await studyDb.reviewRoundProgress.get([roundRecord.id, attemptQ2.id]))?.questionId, attemptQ2.id);

  const cascadeKeys = await deriveDirtyInstallKeys(state([]), [changeSet([{
    kind: "question.delete.cascade",
    questionId: "unsafe-cascade",
    deletedAt: "2026-08-30T00:00:02.000Z",
  }], 4)]);
  assert.equal(cascadeKeys, null, "question cascade must fall back to full canonical reconcile");
} finally {
  studyDb.questions.clear = originalQuestionClear;
  await resetDatabase();
  studyDb.close();
}

console.log("iOS incremental canonical install regression tests passed");
