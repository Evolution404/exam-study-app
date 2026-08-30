import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import type { BankV7, QuestionV7 } from "../../src/lib/db/v7-types";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7-codec";
import type { ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import { installProjection } from "../../src/lib/sync/sync-v7-checkpoint-bridge";
import { deriveDirtyInstallKeysV7 } from "../../src/lib/sync/sync-v7-dirty-install";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => "device-dirty-import",
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

const at = "2026-08-30T00:00:00.000Z";
const bank: BankV7 = {
  id: "bank-import",
  name: "恢复关系题库",
  sortOrder: 0,
  questionCount: 0,
  importedAt: at,
  updatedAt: at,
  deviceId: "device-a",
};
const question: QuestionV7 = {
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

function targetProjection(): ChangeSetProjectionV7 {
  return {
    banks: [{ ...bank, questionCount: 1, deviceId: "device-remote" }],
    bankFolders: [],
    questions: [question],
    memberships: [membership],
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
try {
  await dbV7.banks.put(bank);
  await dbV7.questions.put(question);
  await dbV7.tombstones.put({
    key: tombstoneKey,
    entityType: "membership",
    entityId: membership.key,
    deletedAt: at,
    deviceId: "device-a",
    eventId: "removed-before-import",
    sequence: 1,
  });

  const imported = await createChangeSetV7({
    id: "reimport-membership",
    deviceId: "device-remote",
    localSequence: 2,
    createdAt: "2026-08-30T00:00:01.000Z",
    mutation: {
      kind: "question.import",
      bank: { ...bank, questionCount: 1, deviceId: "device-remote" },
      questions: [question],
      memberships: [membership],
    },
  });
  const target = targetProjection();
  const dirtyKeys = await deriveDirtyInstallKeysV7(target, [imported]);

  assert.ok(dirtyKeys, "question.import should remain eligible for dirty install");
  assert.deepEqual(dirtyKeys.memberships, [membership.key]);
  assert.ok(
    dirtyKeys.tombstones.includes(tombstoneKey),
    "question.import must dirty the matching membership tombstone because the reducer clears it when restoring the relation",
  );

  assert.equal(await installProjection(target, { dirtyKeys }), true);
  assert.equal((await dbV7.bankQuestionMemberships.get(membership.key))?.questionId, question.id);
  assert.equal(await dbV7.tombstones.get(tombstoneKey), undefined, "restored membership must not retain its old removal tombstone");
  assert.equal((await dbV7.banks.get(bank.id))?.questionCount, 1, "restored membership must update the derived bank question count");
} finally {
  await resetV7Database();
  dbV7.close();
}

console.log("dirty question.import membership tombstone regression passed");
