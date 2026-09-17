import assert from "node:assert/strict";
import { validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";
import {
  applySyncShadowPlan,
  buildSyncV10ShadowPlan,
  convertLegacySyncCheckpoint,
  verifyLegacySyncConversion,
  type LegacySyncCheckpoint,
  type SyncShadowStore,
} from "../tools/sync-v9-to-v10-converter";

const timestamp = "2026-09-17T00:00:00.000Z";
const imageAssetId = "b".repeat(64);

const legacy = {
  formatVersion: 7,
  generatedAt: timestamp,
  cursors: { "device-a": 42 },
  counts: {
    banks: 1,
    bankFolders: 0,
    questions: 1,
    memberships: 1,
    imageAssets: 1,
    attempts: 1,
    attemptStats: 1,
    attemptDailyStats: 1,
    notes: 1,
    practiceRuns: 1,
    practiceRunStats: 1,
    questionGroups: 1,
    reviewRounds: 1,
    reviewRoundProgress: 1,
    tombstones: 0,
    totalAttempts: 1,
    totalPracticeRuns: 1,
  },
  state: {
    banks: [{ id: "bank-1", name: "题库", questionCount: 1, sortOrder: 0, importedAt: timestamp, updatedAt: timestamp, deviceId: "device-a" }],
    bankFolders: [],
    questions: [{
      id: "question-1",
      type: "单选",
      content: [{ id: "stem-1", type: "text", text: "题目" }],
      options: [[{ id: "option-a", type: "text", text: "A" }]],
      optionIds: ["option-a"],
      solution: { kind: "choice", correctOptionIds: ["option-a"] },
      tags: [],
      contentFingerprint: "fingerprint-question-1",
      updatedAt: timestamp,
      deviceId: "device-a",
    }],
    memberships: [{
      key: "bank-1:question-1",
      bankId: "bank-1",
      questionId: "question-1",
      sortOrder: 0,
      addedAt: timestamp,
      updatedAt: timestamp,
      deviceId: "device-a",
    }],
    imageAssets: [{ id: imageAssetId, mimeType: "image/png", size: 123, width: 10, height: 10 }],
    attempts: [{
      id: "attempt-1",
      runId: "run-1",
      questionId: "question-1",
      reviewRoundId: "round-1",
      sourceBankId: "bank-1",
      selected: "option-a",
      correct: true,
      elapsedMs: 1200,
      createdAt: timestamp,
      deviceId: "device-a",
    }],
    attemptStats: [{
      questionId: "question-1",
      total: 1,
      correct: 1,
      wrong: 0,
      giveUps: 0,
      totalElapsedMs: 1200,
      firstAttemptAt: timestamp,
      firstAttemptCorrect: true,
      latestAttemptAt: timestamp,
      hasBeenWrong: false,
      correctStreakAfterWrong: 0,
      currentCorrectStreak: 1,
      recentOutcomes: [{ id: "attempt-1", createdAt: timestamp, correct: true, elapsedMs: 1200 }],
    }],
    attemptDailyStats: [{ key: "2026-09-17:question-1", date: "2026-09-17", questionId: "question-1", total: 1, correct: 1, wrong: 0, giveUps: 0, totalElapsedMs: 1200 }],
    notes: [{ questionId: "question-1", content: "解析", revision: 1, updatedAt: timestamp, deviceId: "device-a" }],
    practiceRuns: [{
      id: "run-1",
      bankId: "bank-1",
      bankIds: ["bank-1"],
      bankName: "题库",
      mode: "sequential",
      modeLabel: "练习",
      questionIds: ["question-1"],
      questionTypes: { "question-1": "单选" },
      answers: {
        "question-1": {
          selected: ["option-a"],
          submitted: true,
          correct: true,
          updatedAt: timestamp,
          deviceId: "device-a",
          eventId: "attempt-1",
        },
      },
      shuffleOptions: false,
      optionOrders: { "question-1": [0] },
      startedAt: timestamp,
      updatedAt: timestamp,
      status: "completed",
      revision: 1,
      completedAt: timestamp,
      reviewRoundId: "round-1",
    }],
    practiceRunStats: [{ key: "bank-1", bankId: "bank-1", total: 1, completed: 1, inProgress: 0, abandoned: 0, latestUpdatedAt: timestamp }],
    questionGroups: [{
      id: "group-1",
      name: "题组",
      type: "manual",
      description: "",
      items: [{ questionId: "question-1", note: "重点" }],
      createdAt: timestamp,
      updatedAt: timestamp,
      deviceId: "device-a",
    }],
    reviewRounds: [{
      id: "round-1",
      name: "复习轮次",
      bankIds: ["bank-1"],
      startedAt: timestamp,
      status: "completed",
      completedAt: timestamp,
      finalQuestionIds: ["question-1"],
      createdAt: timestamp,
      updatedAt: timestamp,
      deviceId: "device-a",
    }],
    reviewRoundProgress: [{
      key: "round-1:question-1",
      roundId: "round-1",
      questionId: "question-1",
      attempts: 1,
      correct: 1,
      wrong: 0,
      firstAttemptAt: timestamp,
      latestAttemptAt: timestamp,
      giveUps: 0,
      totalElapsedMs: 1200,
      firstAttemptCorrect: true,
      hasBeenWrong: false,
      currentCorrectStreak: 1,
      correctStreakAfterWrong: 0,
      recentOutcomes: [{ id: "attempt-1", createdAt: timestamp, correct: true, elapsedMs: 1200 }],
    }],
    tombstones: [],
  },
} as unknown as LegacySyncCheckpoint;

const converted = convertLegacySyncCheckpoint(legacy);
validateSyncCheckpoint(converted);

for (const retired of ["attemptStats", "attemptDailyStats", "practiceRunStats", "reviewRoundProgress", "imageBlobs"]) {
  assert.equal(retired in (converted.state as unknown as Record<string, unknown>), false, `v10 canonical checkpoint must exclude ${retired}`);
}

assert.deepEqual(converted.state.practiceRuns.map((row) => row.id), ["run-1"]);
assert.deepEqual(converted.state.practiceRunSources, [{ runId: "run-1", bankId: "bank-1", bankNameSnapshot: "题库", position: 0 }]);
assert.equal(converted.state.practiceRunItems[0]?.submittedAttemptId, "attempt-1");
assert.equal(converted.state.practiceRunItems[0]?.questionId, "question-1");
assert.deepEqual(converted.state.questionGroupItems, [{ groupId: "group-1", questionId: "question-1", position: 0, note: "重点" }]);
assert.deepEqual(converted.state.reviewRoundBanks, [{ roundId: "round-1", bankId: "bank-1", position: 0 }]);
assert.deepEqual(converted.state.reviewRoundItems, [{ roundId: "round-1", questionId: "question-1", position: 0 }]);

const report = verifyLegacySyncConversion(legacy, converted);
assert.equal(report.ok, true, report.errors.join("\n"));
assert.deepEqual(report.errors, []);
assert.equal(report.counts.attempts, 1);
assert.equal(report.counts.practiceRuns, 1);
assert.equal(report.counts.questions, 1);

const repeated = convertLegacySyncCheckpoint(structuredClone(legacy));
assert.deepEqual(repeated, converted, "conversion must be deterministic and rerunnable");

const shadow = buildSyncV10ShadowPlan({
  vaultId: "qa/converter@main",
  sourceHeadSha: "a".repeat(40),
  checkpoint: converted,
});
assert.equal(shadow.sourceFormatVersion, 9);
assert.equal(shadow.targetFormatVersion, 10);
assert.ok(shadow.files.length > 0);
assert.ok(shadow.files.every((file) => file.path.startsWith("sync/v10/")), "shadow plan may only target v10 namespace");
assert.ok(shadow.files.every((file) => !file.path.startsWith("sync/v9/")), "converter must never plan writes into production v9 namespace");
assert.ok(shadow.files.every((file) => file.path !== "sync/v10/head.json"), "dry-run/shadow plan must not publish the cutover head");
assert.equal(shadow.cutoverHead.path, "sync/v10/head.json");
assert.equal(shadow.cutoverHead.authorized, false, "head publication remains separately authorized");

class MemoryShadowStore implements SyncShadowStore {
  readonly files = new Map<string, string>();
  writes = 0;

  async read(path: string) {
    return this.files.get(path);
  }

  async writeImmutable(path: string, content: string) {
    this.writes += 1;
    this.files.set(path, content);
  }
}

const shadowStore = new MemoryShadowStore();
const firstApply = await applySyncShadowPlan(shadow, shadowStore);
assert.deepEqual(firstApply, { created: shadow.files.length, reused: 0 });
assert.equal(shadowStore.files.has(shadow.cutoverHead.path), false, "shadow application must never publish the cutover head");
const writesAfterFirstApply = shadowStore.writes;
const secondApply = await applySyncShadowPlan(shadow, shadowStore);
assert.deepEqual(secondApply, { created: 0, reused: shadow.files.length }, "rerun must reuse byte-identical shadow files");
assert.equal(shadowStore.writes, writesAfterFirstApply, "rerun must not rewrite immutable shadow files");

const conflictingStore = new MemoryShadowStore();
conflictingStore.files.set(shadow.files[0].path, "tampered");
await assert.rejects(() => applySyncShadowPlan(shadow, conflictingStore), /immutable shadow conflict/);
assert.equal(conflictingStore.files.has(shadow.cutoverHead.path), false, "conflict must fail closed before head publication");

console.log("sync converter contract passed: canonical facts, deterministic conversion, invariant checks, idempotent shadow writes and no implicit cutover");
