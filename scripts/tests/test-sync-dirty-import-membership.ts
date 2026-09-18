import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { studyDb, resetDatabase } from "../../src/lib/db/db";
import type { Bank, CanonicalState, Question } from "../../src/lib/db/types";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import { installCanonicalState } from "../../src/lib/sync/sync-checkpoint-bridge";
import { deriveDirtyInstallKeys } from "../../src/lib/sync/sync-dirty-install";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => "device-dirty-import",
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

const at = "2026-08-30T00:00:00.000Z";
const bank: Bank = {
  id: "bank-import",
  name: "恢复关系题库",
  sortOrder: 0,
  importedAt: at,
  updatedAt: at,
  deviceId: "device-a",
};
const question: Question = {
  id: "question-import",
  type: "单选",
  content: [{ id: "stem", type: "text", text: "重新导入后应恢复题库关系" }],
  options: [
    [{ id: "a", type: "text", text: "A" }],
    [{ id: "b", type: "text", text: "B" }],
  ],
  answer: "A",
  tags: [],
  contentFingerprint: "dirty-import-membership",
  updatedAt: at,
  deviceId: "device-a",
};
const membership = {
  key: `${bank.id}:${question.id}`,
  bankId: bank.id,
  questionId: question.id,
  sortOrder: 0,
  addedAt: at,
  updatedAt: at,
  deviceId: "device-remote",
};
const tombstoneKey = `membership:${membership.key}`;

function targetState(): CanonicalState {
  return {
    banks: [{ ...bank, deviceId: "device-remote" }],
    bankFolders: [],
    questions: [question],
    memberships: [membership],
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

await resetDatabase();
try {
  await studyDb.banks.put(bank);
  await studyDb.questions.put(question);
  await studyDb.tombstones.put({
    key: tombstoneKey,
    entityType: "membership",
    entityId: membership.key,
    deletedAt: at,
    deviceId: "device-a",
    eventId: "removed-before-import",
    sequence: 1,
  });

  const imported = await createChangeSet({
    id: "reimport-membership",
    deviceId: "device-remote",
    localSequence: 2,
    createdAt: "2026-08-30T00:00:01.000Z",
    mutation: {
      kind: "question.import",
      bank: { ...bank, deviceId: "device-remote" },
      questions: [question],
      memberships: [membership],
    },
  });
  const target = targetState();
  const dirtyKeys = await deriveDirtyInstallKeys(target, [imported]);

  assert.ok(dirtyKeys, "question.import should remain eligible for dirty install");
  assert.deepEqual(dirtyKeys.memberships, [membership.key]);
  assert.ok(
    dirtyKeys.tombstones.includes(tombstoneKey),
    "question.import must dirty the matching membership tombstone because the reducer clears it when restoring the relation",
  );

  assert.equal(await installCanonicalState(target, { dirtyKeys }), true);
  assert.equal((await studyDb.bankQuestionMemberships.get([membership.bankId, membership.questionId]))?.questionId, question.id);
  assert.equal(await studyDb.tombstones.get(tombstoneKey), undefined, "restored membership must not retain its old removal tombstone");
  assert.equal((await studyDb.bankQuestionStats.get(bank.id))?.questionCount, 1, "restored membership must update the derived bank question count");
} finally {
  await resetDatabase();
  studyDb.close();
}

console.log("dirty question.import membership tombstone regression passed");
