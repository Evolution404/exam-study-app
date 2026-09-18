import assert from "node:assert/strict";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import { reduceChangeSet } from "../../src/lib/sync/change-set-projection";
import type { Bank, CanonicalState, PracticeRunRecord, PracticeRunSource } from "../../src/lib/db/types";

const at = "2026-08-13T00:00:00.000Z";
const bank: Bank = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId: "seed" };
const record: PracticeRunRecord = {
  id: "run-1",
  mode: "sequential",
  modeLabel: "全量顺序练习",
  shuffleOptions: false,
  startedAt: at,
  updatedAt: at,
  status: "in_progress",
  revision: 1,
  bankNameSnapshot: bank.name,
  activityAt: at,
};
const source: PracticeRunSource = { runId: record.id, bankId: bank.id, bankNameSnapshot: bank.name, position: 0 };

const base: CanonicalState = {
  banks: [bank],
  bankFolders: [],
  questions: [],
  memberships: [],
  imageAssets: [],
  attempts: [],
  notes: [],
  practiceRuns: [record],
  practiceRunSources: [source],
  practiceRunItems: [],
  questionGroups: [],
  questionGroupItems: [],
  reviewRounds: [],
  reviewRoundBanks: [],
  reviewRoundItems: [],
  tombstones: [],
};

const deleteBank = await createChangeSet({
  id: "delete-bank",
  deviceId: "device-a",
  localSequence: 1,
  createdAt: at,
  mutation: { kind: "bank.delete.cascade", bankId: bank.id, deletedAt: at },
});
const afterDelete = reduceChangeSet(base, deleteBank);
const staleRecord = { ...record };
const staleRunSave = await createChangeSet({
  id: "stale-run",
  deviceId: "device-b",
  localSequence: 1,
  createdAt: at,
  mutation: { kind: "practice.run.saved", record: staleRecord, sources: [{ ...source }], items: [] },
});
assert.throws(() => reduceChangeSet(afterDelete, staleRunSave), /已被删除|conflict|墓碑|不存在/, "题库级联删除后，陈旧 run.saved 不得复活练习记录");

console.log("sync bank delete run tombstone tests passed");
