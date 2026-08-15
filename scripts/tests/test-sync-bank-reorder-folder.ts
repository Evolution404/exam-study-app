import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import type { BankV6 } from "../../src/lib/db/v6-types";

const at = "2026-08-13T00:00:00.000Z";
const bankA: BankV6 = { id: "bank-a", name: "题库 A", sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId: "seed" };
const bankB: BankV6 = { id: "bank-b", name: "题库 B", sortOrder: 1, questionCount: 0, importedAt: at, updatedAt: at, deviceId: "seed" };

const base: ChangeSetProjectionV7 = {
  banks: [bankA, bankB],
  bankFolders: [],
  questions: [],
  memberships: [],
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

const reorder = await createChangeSetV7({ id: "reorder", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "bank.reorder", bankIds: ["bank-a", "bank-b"], folderId: "missing-folder" } });
assert.throws(() => reduceChangeSetV7(base, reorder), /不存在|文件夹|folder/, "bank.reorder 将题库放入不存在的文件夹时必须失败");

console.log("sync bank reorder folder tests passed");
