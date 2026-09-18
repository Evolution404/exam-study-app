import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { readFile } from "node:fs/promises";
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
  practiceDrafts: { primaryKey: "[runId+questionId]", indexes: ["runId", "updatedAt"] },
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
  questionDailyProgress: { primaryKey: "[date+questionId]", indexes: ["date", "questionId", "[questionId+date]"] },
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
  bankQuestionStats: { primaryKey: "bankId", indexes: [] },
  bankPracticeStats: { primaryKey: "bankId", indexes: ["latestActivityAt"] },
  bankPracticeRunIndex: { primaryKey: "[bankId+runId]", indexes: ["runId", "[bankId+activityAt]"] },
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

const dbCoreSource = await readFile(new URL("../../src/lib/db/db-core.ts", import.meta.url), "utf8");
const dbTypesSource = await readFile(new URL("../../src/lib/db/types.ts", import.meta.url), "utf8");
const reducerCoreSource = await readFile(new URL("../../src/lib/sync/change-set-projection-core.ts", import.meta.url), "utf8");
const changeSetTypesSource = await readFile(new URL("../../src/lib/sync/change-set-types.ts", import.meta.url), "utf8");
const dirtyInstallSource = await readFile(new URL("../../src/lib/sync/sync-dirty-install.ts", import.meta.url), "utf8");
const projectionEngineSource = await readFile(new URL("../../src/lib/db/projection-engine.ts", import.meta.url), "utf8");
const canonicalValidationSource = await readFile(new URL("../../src/lib/sync/change-set-derived.ts", import.meta.url), "utf8");
const imageDbSource = await readFile(new URL("../../src/lib/db/db-images.ts", import.meta.url), "utf8");

assert.match(dbTypesSource, /export interface CanonicalState\s*\{/, "CanonicalState must be the single complete canonical fact envelope");
assert.doesNotMatch(dbCoreSource, /export interface RestoreState\s*\{/, "RestoreState must be retired instead of remaining a second complete canonical state");

const bankMatch = dbTypesSource.match(/export interface Bank\s+[^{]*[{]([\s\S]*?)\n[}]/);
assert.ok(bankMatch, "Bank interface must remain discoverable");
assert.doesNotMatch(bankMatch[1], /\bquestionCount\b/, "Bank.questionCount is derived and must not be canonical");

const runItemMatch = dbTypesSource.match(/export interface PracticeRunItem\s*\{([\s\S]*?)\n\}/);
assert.ok(runItemMatch, "PracticeRunItem interface must remain discoverable");
assert.doesNotMatch(runItemMatch[1], /\bdraftSelected\b|\bdraftResponse\b/, "practice drafts must not live in canonical PracticeRunItem rows");

for (const explicitRecord of ["PracticeRunRecord", "QuestionGroupRecord", "ReviewRoundRecord"]) {
  assert.doesNotMatch(
    dbTypesSource,
    new RegExp(`export type ${explicitRecord}\\s*=\\s*Omit<`),
    `${explicitRecord} must be an explicit persisted record type, not an Omit-derived aggregate`,
  );
}

assert.match(reducerCoreSource, /\bCanonicalState\b/, "reducer core must consume the single CanonicalState owner from db types");
assert.doesNotMatch(reducerCoreSource, /export interface ChangeSetProjection\s*\{/, "reducer must not define a second complete state envelope");
for (const derivedField of ["attemptStats", "attemptDailyStats", "practiceRunStats", "reviewRoundProgress"]) {
  assert.doesNotMatch(
    reducerCoreSource,
    new RegExp(`\\b${derivedField}\\b`),
    `reducer canonical state must not contain derived array ${derivedField}`,
  );
}

for (const forbiddenPayload of [
  /kind:\s*"practice\.run\.(?:saved|status\.changed)";\s*run:\s*PracticeRun\b/,
  /kind:\s*"questionGroup\.saved";\s*group:\s*QuestionGroup\b/,
  /kind:\s*"review\.round\.(?:saved|completed|archived)";\s*round:\s*ReviewRound\b/,
]) {
  assert.doesNotMatch(changeSetTypesSource, forbiddenPayload, "change-set relation mutations must carry normalized canonical records, not aggregate domain objects");
}

const dirtyKeysMatch = dirtyInstallSource.match(/export interface DirtyInstallKeys\s*\{([\s\S]*?)\n\}/);
assert.ok(dirtyKeysMatch, "DirtyInstallKeys interface must remain discoverable");
for (const derivedKey of ["attemptStats", "attemptDailyStats", "practiceRunStats", "reviewRoundProgress"]) {
  assert.doesNotMatch(dirtyKeysMatch[1], new RegExp(`\\b${derivedKey}\\b`), `DirtyInstallKeys must not expose derived projection key ${derivedKey}`);
}

assert.match(projectionEngineSource, /PROJECTION_MODEL_REVISION/, "local projections need a model revision so algorithm changes force deterministic rebuilds");
assert.doesNotMatch(projectionEngineSource, /assemblePracticeRunRecords/, "full projection rebuild must consume normalized run facts without aggregate PracticeRun bounce");
assert.doesNotMatch(projectionEngineSource, /practiceRunItems\.toArray\(\)/, "projection rebuild must not read run items when no projection depends on them");
assert.match(canonicalValidationSource, /row\.key\s*!==\s*membershipKey\(row\.bankId,row\.questionId\)/, "persisted membership key must remain a strictly validated derivative of its compound identity");

const canonicalStateMatch = dbTypesSource.match(/export interface CanonicalState\s*\{([\s\S]*?)\n\}/);
assert.ok(canonicalStateMatch, "CanonicalState body must remain discoverable");
for (const localOnly of ["practiceDrafts", "imageBlobs", "bankQuestionStats", "bankPracticeStats", "bankPracticeRunIndex", "questionProgress", "questionDailyProgress", "reviewRoundProgress"]) {
  assert.doesNotMatch(canonicalStateMatch[1], new RegExp(`\\b${localOnly}\\b`), `${localOnly} is device-local and must never become a canonical fact`);
}
assert.doesNotMatch(imageDbSource, /clearImageCache[\s\S]{0,1600}imageAssets\.(?:clear|delete|bulkDelete)/, "clearing the image cache must not mutate canonical imageAssets");

const checkpointStoreSource = await readFile(new URL("../../src/lib/sync/sync-checkpoint-store.ts", import.meta.url), "utf8");
assert.doesNotMatch(checkpointStoreSource, /assemblePracticeRunRecords/, "checkpoint restore must not assemble normalized runs into aggregate PracticeRun objects");
const restoreSource = await readFile(new URL("../../src/lib/db/db-restore.ts", import.meta.url), "utf8");
assert.doesNotMatch(restoreSource, /decomposePracticeRuns/, "DB restore must write normalized PracticeRun facts directly");

const wireSources = await Promise.all([
  "../../src/lib/sync/change-set-types.ts",
  "../../src/lib/sync/sync-checkpoint-types.ts",
  "../../src/lib/sync/sync-history-state.ts",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
assert.doesNotMatch(wireSources.join("\n"), /\bdraftSelected\b|\bdraftResponse\b/, "draft state must never enter change-set/checkpoint/history wire types");
for (const localOnly of ["practiceDrafts", "imageBlobs", "bankQuestionStats", "bankPracticeStats", "bankPracticeRunIndex", "questionProgress", "questionDailyProgress", "reviewRoundProgress"]) {
  assert.doesNotMatch(wireSources.join("\n"), new RegExp(`\\b${localOnly}\\b`), `${localOnly} must never enter sync wire types`);
}

console.log("database hardening schema and ownership contracts passed");
