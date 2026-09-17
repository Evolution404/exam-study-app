import assert from "node:assert/strict";
import { createChangeSet } from "../../src/lib/sync/change-set-codec";
import { reduceChangeSet, type ChangeSetProjection } from "../../src/lib/sync/change-set-projection";
import type { Bank } from "../../src/lib/db/types";

const at = "2026-08-13T00:00:00.000Z";
const bankA: Bank = { id: "bank-a", name: "题库 A", sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId: "seed" };
const bankB: Bank = { id: "bank-b", name: "题库 B", sortOrder: 1, questionCount: 0, importedAt: at, updatedAt: at, deviceId: "seed" };

const base: ChangeSetProjection = {
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

const reorder = await createChangeSet({ id: "reorder", deviceId: "device-a", localSequence: 1, createdAt: at, mutation: { kind: "bank.reorder", bankIds: ["bank-a", "bank-b"], folderId: "missing-folder" } });
assert.throws(() => reduceChangeSet(base, reorder), /不存在|文件夹|folder/, "bank.reorder 将题库放入不存在的文件夹时必须失败");

console.log("sync bank reorder folder tests passed");
