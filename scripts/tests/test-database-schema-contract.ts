import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { studyDb } from "../../src/lib/db/db";

type StoreContract = {
  primaryKey: string;
  indexes: readonly string[];
};

const NEXT_SCHEMA: Record<string, StoreContract> = {
  banks: { primaryKey: "id", indexes: ["sortOrder", "folderId", "importedAt", "updatedAt"] },
  bankFolders: { primaryKey: "id", indexes: ["sortOrder", "updatedAt"] },
  questions: { primaryKey: "id", indexes: ["contentFingerprint", "type", "updatedAt", "*tags"] },
  bankQuestionMemberships: {
    primaryKey: "[bankId+questionId]",
    indexes: ["bankId", "questionId", "sortOrder", "updatedAt", "[bankId+sortOrder]"],
  },
  imageAssets: { primaryKey: "id", indexes: ["mimeType", "size"] },
  imageBlobs: { primaryKey: "assetId", indexes: ["cachedAt", "lastUsedAt"] },
  attempts: {
    primaryKey: "id",
    indexes: [
      "runId",
      "questionId",
      "reviewRoundId",
      "sourceBankId",
      "createdAt",
      "deviceId",
      "[questionId+createdAt]",
      "[runId+createdAt]",
      "[reviewRoundId+createdAt]",
      "[reviewRoundId+questionId+createdAt]",
    ],
  },
  questionProgress: { primaryKey: "questionId", indexes: ["latestAttemptAt"] },
  questionDailyProgress: { primaryKey: "[date+questionId]", indexes: ["date", "questionId"] },
  notes: { primaryKey: "questionId", indexes: ["updatedAt"] },
  practiceRuns: {
    primaryKey: "id",
    indexes: ["status", "startedAt", "updatedAt", "activityAt", "reviewRoundId", "[status+activityAt]"],
  },
  practiceRunSources: {
    primaryKey: "[runId+bankId]",
    indexes: ["runId", "bankId", "[runId+position]"],
  },
  practiceRunItems: {
    primaryKey: "[runId+questionId]",
    indexes: ["runId", "questionId", "submittedAttemptId", "[runId+position]"],
  },
  bankPracticeStats: { primaryKey: "bankId", indexes: ["latestActivityAt"] },
  questionGroups: { primaryKey: "id", indexes: ["type", "updatedAt"] },
  questionGroupItems: {
    primaryKey: "[groupId+questionId]",
    indexes: ["groupId", "questionId", "[groupId+position]"],
  },
  reviewRounds: { primaryKey: "id", indexes: ["status", "updatedAt", "startedAt"] },
  reviewRoundBanks: {
    primaryKey: "[roundId+bankId]",
    indexes: ["roundId", "bankId", "[roundId+position]"],
  },
  reviewRoundItems: {
    primaryKey: "[roundId+questionId]",
    indexes: ["roundId", "questionId", "[roundId+position]"],
  },
  reviewRoundProgress: {
    primaryKey: "[roundId+questionId]",
    indexes: ["roundId", "questionId", "latestAttemptAt"],
  },
  changeSets: {
    primaryKey: "id",
    indexes: ["state", "createdAt", "deviceId", "localSequence", "claimId", "committedAt", "[state+createdAt]"],
  },
  syncFiles: { primaryKey: "path", indexes: ["sha", "appliedAt"] },
  tombstones: { primaryKey: "key", indexes: ["entityType", "entityId", "deletedAt"] },
  syncMeta: { primaryKey: "key", indexes: ["updatedAt"] },
};

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

const actualStores = sorted(studyDb.tables.map((table) => table.name));
const expectedStores = sorted(Object.keys(NEXT_SCHEMA));
assert.deepEqual(actualStores, expectedStores, "Dexie version(1) store set must match the facts + local projections contract");

for (const [storeName, contract] of Object.entries(NEXT_SCHEMA)) {
  const table = studyDb.table(storeName);
  assert.equal(table.schema.primKey.src, contract.primaryKey, `${storeName} primary key must match the new schema contract`);
  assert.deepEqual(
    sorted(table.schema.indexes.map((index) => index.src)),
    sorted(contract.indexes),
    `${storeName} indexes must match the new schema contract`,
  );
}

for (const retiredStore of ["attemptStats", "attemptDailyStats", "practiceRunActivity", "practiceRunStats"] as const) {
  assert.equal(studyDb.tables.some((table) => table.name === retiredStore), false, `${retiredStore} must not survive the schema cutover`);
}

console.log("database next-schema contract passed");
