import assert from "node:assert/strict";
import type {
  Attempt,
  Bank,
  BankFolder,
  BankQuestionMembership,
  CanonicalState,
  PracticeRunItem,
  PracticeRunRecord,
  PracticeRunSource,
  Question,
  ReviewRoundBank,
  ReviewRoundRecord,
} from "../../src/lib/db/types";
import { type ChangeSet } from "../../src/lib/sync/change-set-types";
import { createChangeSet, digestChangeSet, validateChangeSet, verifyChangeSetDigest } from "../../src/lib/sync/change-set-codec";
import { assertClaimedBatchDigest, createClaimedBatch, planChangeSetQueue, summarizeChangeSet } from "../../src/lib/sync/change-set-planning";
import { normalizeCanonicalStateForReplay, reduceChangeSet } from "../../src/lib/sync/change-set-projection";

const at = "2026-08-01T00:00:00.000Z";
const deviceId = "device-test";
const bank = (id: string, name = id): Bank => ({ id, name, sortOrder: 0, importedAt: at, updatedAt: at, deviceId });
const question = (id: string): Question => ({
  id,
  type: "单选",
  content: [{ id: `${id}-stem`, type: "text", text: `题目 ${id}` }],
  options: [[{ id: `${id}-a`, type: "text", text: "A" }]],
  solution: { kind: "choice", correctOptionIds: [`${id}-a`] },
  tags: [],
  favorite: false,
  contentFingerprint: id,
  updatedAt: at,
  deviceId,
});
const membership = (bankId: string, questionId: string): BankQuestionMembership => ({
  key: `${bankId}:${questionId}`,
  bankId,
  questionId,
  sortOrder: 0,
  addedAt: at,
  updatedAt: at,
  deviceId,
});
const folder: BankFolder = { id: "folder-1", name: "文件夹", description: "", sortOrder: 0, createdAt: at, updatedAt: at, deviceId };

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

function runBundle(id: string, bankId: string, questionId: string, reviewRoundId?: string): {
  record: PracticeRunRecord;
  sources: PracticeRunSource[];
  items: PracticeRunItem[];
} {
  return {
    record: {
      id,
      mode: "sequential",
      modeLabel: "练习",
      shuffleOptions: false,
      startedAt: at,
      updatedAt: at,
      status: "in_progress",
      revision: 0,
      bankNameSnapshot: "题库",
      activityAt: at,
      ...(reviewRoundId ? { reviewRoundId } : {}),
    },
    sources: [{ runId: id, bankId, bankNameSnapshot: "题库", position: 0 }],
    items: [{ runId: id, questionId, position: 0, questionTypeSnapshot: "单选", optionOrder: [] }],
  };
}

function roundBundle(id: string, bankId: string, status: ReviewRoundRecord["status"] = "active") {
  const record: ReviewRoundRecord = {
    id,
    name: "第一轮",
    startedAt: at,
    status,
    ...(status === "completed" ? { completedAt: at } : {}),
    createdAt: at,
    updatedAt: at,
    deviceId,
  };
  const banks: ReviewRoundBank[] = [{ roundId: id, bankId, position: 0 }];
  return { record, banks, items: [] };
}

let sequence = 0;
async function cs(mutations: Parameters<typeof createChangeSet>[0]["mutations"]): Promise<ChangeSet> {
  return createChangeSet({ deviceId, localSequence: ++sequence, createdAt: at, mutations });
}

let state = emptyState();
const base = await cs([
  { kind: "bank.create", bank: bank("bank-1", "题库") },
  { kind: "question.upsert", question: question("question-1") },
  { kind: "membership.save", membership: membership("bank-1", "question-1") },
]);
assert.equal(base.kind, "batch");
assert.equal(validateChangeSet(base), true);
assert.equal(await verifyChangeSetDigest(base), true);
assert.match(summarizeChangeSet(base), /批量操作/);
state = reduceChangeSet(state, base);
assert.equal(state.memberships.filter((item) => item.bankId === "bank-1").length, 1);

let imported = emptyState();
imported = reduceChangeSet(imported, await cs([{
  kind: "question.import",
  bank: bank("import-bank", "导入题库"),
  questions: [question("shared-question")],
  memberships: [membership("import-bank", "shared-question")],
}]));
imported = reduceChangeSet(imported, await cs([{
  kind: "question.import",
  bank: bank("import-bank", "导入题库（更新）"),
  questions: [question("shared-question"), question("new-question")],
  memberships: [membership("import-bank", "shared-question"), membership("import-bank", "new-question")],
}]));
assert.equal(imported.banks.length, 1);
assert.equal(imported.questions.length, 2);
assert.equal(imported.memberships.length, 2);
assert.equal(imported.memberships.filter((item) => item.bankId === "import-bank").length, 2);

state = reduceChangeSet(state, await cs([
  { kind: "bankFolder.save", folder },
  { kind: "bank.update", bank: { ...state.banks[0], folderId: folder.id, updatedAt: at } },
  { kind: "image.asset.save", asset: { id: "a".repeat(64), mimeType: "image/png", size: 3, width: 1, height: 1 } },
  { kind: "note.upserted", note: { questionId: "question-1", content: "解析", revision: 1, updatedAt: at, deviceId } },
  {
    kind: "questionGroup.saved",
    record: { id: "group-1", name: "组", type: "专题", description: "", createdAt: at, updatedAt: at, deviceId },
    items: [{ groupId: "group-1", questionId: "question-1", position: 0 }],
  },
]));

const round = roundBundle("round-1", "bank-1");
const run = runBundle("run-1", "bank-1", "question-1", round.record.id);
state = reduceChangeSet(state, await cs([
  { kind: "review.round.saved", ...round },
  { kind: "practice.run.saved", ...run },
]));
assert.equal(state.practiceRunSources[0]?.bankId, "bank-1");
assert.equal(state.practiceRunItems[0]?.questionId, "question-1");
const runStateBeforeAnswers = structuredClone(state);

const attempt = (id: string, correct: boolean): Attempt => ({
  id,
  runId: run.record.id,
  questionId: "question-1",
  reviewRoundId: round.record.id,
  selected: correct ? "A" : "B",
  correct,
  elapsedMs: 10,
  createdAt: at,
  deviceId,
});

const reorderedAttempt = attempt("attempt-reordered", true);
const reorderedRunRecord = { ...run.record, revision: 1 };
const reorderedItem = { ...run.items[0], submittedAttemptId: reorderedAttempt.id };
const completedRecord = { ...run.record, status: "completed" as const, completedAt: at, revision: 2 };
let reordered = reduceChangeSet(runStateBeforeAnswers, await cs([{ kind: "practice.run.status.changed", record: completedRecord }]));
reordered = reduceChangeSet(reordered, await cs([{
  kind: "practice.answer.submitted",
  attempt: reorderedAttempt,
  runRecord: reorderedRunRecord,
  item: reorderedItem,
}]));
assert.equal(reordered.practiceRuns[0]?.status, "completed", "older answer replay must not regress a completed run");
assert.equal(reordered.practiceRuns[0]?.revision, 2, "older answer replay must not lower run revision");
assert.equal(reordered.attempts.some((item) => item.id === reorderedAttempt.id), true, "answer fact still applies when run metadata is stale");

const firstAttempt = attempt("attempt-1", false);
const firstRunRecord = { ...run.record, revision: 1 };
const firstItem = { ...run.items[0], submittedAttemptId: firstAttempt.id };
state = reduceChangeSet(state, await cs([{
  kind: "practice.answer.submitted",
  attempt: firstAttempt,
  runRecord: firstRunRecord,
  item: firstItem,
}]));
assert.equal(state.attempts.length, 1);
assert.equal(state.practiceRunItems[0]?.submittedAttemptId, firstAttempt.id);

const secondAttempt = attempt("attempt-2", true);
const secondRunRecord = { ...firstRunRecord, revision: 2 };
const secondItem = { ...firstItem, submittedAttemptId: secondAttempt.id };
state = reduceChangeSet(state, await cs([{
  kind: "practice.answer.submitted",
  attempt: secondAttempt,
  runRecord: secondRunRecord,
  item: secondItem,
}]));
assert.equal(state.attempts.length, 2);
assert.equal(state.attempts.find((item) => item.id === "attempt-1")?.correct, false);
assert.equal(state.attempts.find((item) => item.id === "attempt-2")?.correct, true);
assert.equal(state.practiceRunItems[0]?.submittedAttemptId, "attempt-2");

state = reduceChangeSet(state, await cs([
  { kind: "practice.answer.deleted", attemptId: "attempt-2", runRecord: { ...secondRunRecord, revision: 3 }, item: { ...secondItem, submittedAttemptId: undefined } },
  { kind: "practice.answer.deleted", attemptId: "attempt-1", runRecord: { ...secondRunRecord, revision: 4 }, item: { ...secondItem, submittedAttemptId: undefined } },
]));
assert.equal(state.attempts.length, 0);
assert.equal(state.practiceRunItems[0]?.submittedAttemptId, undefined);

const cloneQuestion = question("question-2");
state = reduceChangeSet(state, await cs([{
  kind: "question.split",
  originalQuestionId: "question-1",
  clone: cloneQuestion,
  memberships: [membership("bank-1", "question-2")],
  deletedMembershipKeys: ["bank-1:question-1"],
}]));
const conflictingSplit = await cs([{ kind: "question.split", originalQuestionId: "question-1", clone: cloneQuestion, memberships: [] }]);
await assert.rejects(async () => reduceChangeSet(state, conflictingSplit), /已存在/);
const blockedDelete = await cs([{ kind: "question.delete", questionId: "question-2" }]);
await assert.rejects(async () => reduceChangeSet(state, blockedDelete), /cascade/);
state = reduceChangeSet(state, await cs([{ kind: "question.delete.cascade", questionId: "question-2" }]));
assert.equal(state.questions.some((item) => item.id === "question-2"), false);

const unorderedA = await cs([{ kind: "question.bulk.upsert", questions: [question("z"), question("a")] }]);
const unorderedB = await cs([{ kind: "question.bulk.upsert", questions: [question("a"), question("z")] }]);
assert.equal(
  await digestChangeSet({ ...unorderedA, id: "same", localSequence: 99 }),
  await digestChangeSet({ ...unorderedB, id: "same", localSequence: 99 }),
  "bulk ordering is canonical",
);
const plan = await planChangeSetQueue([base]);
assert.equal(plan.blockers.length, 0);
const danglingMembership = await cs([{ kind: "membership.save", membership: membership("missing-bank", "missing-question") }]);
const danglingPlan = await planChangeSetQueue([danglingMembership]);
assert.equal(danglingPlan.blockers.some((blocker) => blocker.code === "missing-dependency"), true);

const claim = await createClaimedBatch("claim-1", [base]);
await assert.rejects(() => assertClaimedBatchDigest({ ...claim, digest: "0".repeat(64) }, [base]), /mismatch/);
assert.equal(await verifyChangeSetDigest({ ...base, digest: "0".repeat(64) }), false, "digest tamper rejected");
assert.deepEqual(normalizeCanonicalStateForReplay(state).banks, state.banks);

console.log("change-set tests passed: normalized mutations, canonical replay, conflicts, dependencies and digest claims");
