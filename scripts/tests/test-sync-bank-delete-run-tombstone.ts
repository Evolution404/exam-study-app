import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7-codec";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { BankV7 } from "../../src/lib/db/v7-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV7 = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId: "seed" };
const run = {
  id: "run-1", bankId: bank.id, bankIds: [bank.id], bankName: bank.name, mode: "sequential" as const, modeLabel: "全量顺序练习",
  questionIds: [], questionTypes: {}, answers: {}, shuffleOptions: false, optionOrders: {}, startedAt: at, updatedAt: at, status: "in_progress" as const, revision: 1,
};

const base: ChangeSetProjectionV7 = {
  banks: [bank], bankFolders: [], questions: [], memberships: [], imageAssets: [], attempts: [], attemptStats: [],
  attemptDailyStats: [], notes: [], practiceRuns: [run], practiceRunStats: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [],
};

const deleteBank = await createChangeSetV7({ id: "delete-bank", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "bank.delete.cascade", bankId: bank.id, deletedAt: at } });
const afterDelete = reduceChangeSetV7(base, deleteBank);
const staleRunSave = await createChangeSetV7({ id: "stale-run", deviceId: "device-b", localSequence: 1, createdAt: at, mutation: { kind: "practice.run.saved", run: { ...run, deviceId: "device-b" } } });
assert.throws(() => reduceChangeSetV7(afterDelete, staleRunSave), /已被删除|conflict|墓碑|不存在/, "题库级联删除后，陈旧 run.saved 不得复活练习记录");

console.log("sync bank delete run tombstone tests passed");
