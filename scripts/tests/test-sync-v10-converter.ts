import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";
import { SYNC_HEAD_PATH, type SyncDescriptor, type SyncDescriptorKind } from "../../src/lib/sync/sync-head-types";
import { validateSyncHead } from "../../src/lib/sync/sync-head-validation";
import {
  convertLegacySyncCheckpoint,
  verifyLegacySyncConversion,
  type LegacySyncCheckpoint,
} from "../tools/sync-remote-converter";
import {
  buildSyncShadowPlan,
  publishSyncCutover,
  stageSyncShadow,
  verifyStagedSyncShadow,
  type SyncShadowRemote,
} from "../tools/sync-shadow-cutover";

const timestamp = "2026-09-17T00:00:00.000Z";
const imageAssetId = "b".repeat(64);
const sourceHeadSha = "a".repeat(40);

const legacy = {
  formatVersion: 7,
  generatedAt: timestamp,
  cursors: { "device-a": 42 },
  counts: {
    banks: 1, bankFolders: 0, questions: 1, memberships: 1, imageAssets: 1,
    attempts: 1, attemptStats: 1, attemptDailyStats: 1, notes: 1,
    practiceRuns: 1, practiceRunStats: 1, questionGroups: 1, reviewRounds: 1,
    reviewRoundProgress: 1, tombstones: 0, totalAttempts: 1, totalPracticeRuns: 1,
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
    memberships: [{ key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: timestamp, updatedAt: timestamp, deviceId: "device-a" }],
    imageAssets: [{ id: imageAssetId, mimeType: "image/png", size: 123, width: 10, height: 10 }],
    attempts: [{
      id: "attempt-1", runId: "run-1", questionId: "question-1", reviewRoundId: "round-1",
      sourceBankId: "bank-1", selected: "option-a", correct: true, elapsedMs: 1200,
      createdAt: timestamp, deviceId: "device-a",
    }],
    attemptStats: [{ questionId: "question-1", total: 1, correct: 1 }],
    attemptDailyStats: [{ key: "2026-09-17:question-1", date: "2026-09-17", questionId: "question-1", total: 1, correct: 1 }],
    notes: [{ questionId: "question-1", content: "解析", revision: 1, updatedAt: timestamp, deviceId: "device-a" }],
    practiceRuns: [{
      id: "run-1", bankId: "bank-1", bankIds: ["bank-1"], bankName: "题库",
      mode: "sequential", modeLabel: "练习", questionIds: ["question-1"], questionTypes: { "question-1": "单选" },
      answers: { "question-1": { selected: ["option-a"], submitted: true, correct: true, updatedAt: timestamp, deviceId: "device-a", eventId: "attempt-1" } },
      shuffleOptions: false, optionOrders: { "question-1": [0] }, startedAt: timestamp, updatedAt: timestamp,
      status: "completed", revision: 1, completedAt: timestamp, reviewRoundId: "round-1",
    }],
    practiceRunStats: [{ key: "bank-1", total: 1 }],
    questionGroups: [{
      id: "group-1", name: "题组", type: "manual", description: "",
      items: [{ questionId: "question-1", note: "重点" }], createdAt: timestamp, updatedAt: timestamp, deviceId: "device-a",
    }],
    reviewRounds: [{
      id: "round-1", name: "复习轮次", bankIds: ["bank-1"], startedAt: timestamp,
      status: "completed", completedAt: timestamp, finalQuestionIds: ["question-1"],
      createdAt: timestamp, updatedAt: timestamp, deviceId: "device-a",
    }],
    reviewRoundProgress: [{ key: "round-1:question-1", roundId: "round-1", questionId: "question-1", attempts: 1, correct: 1 }],
    tombstones: [],
  },
} as unknown as LegacySyncCheckpoint;

const converted = convertLegacySyncCheckpoint(legacy);
validateSyncCheckpoint(converted);
for (const retired of ["attemptStats", "attemptDailyStats", "practiceRunStats", "reviewRoundProgress", "imageBlobs"]) {
  assert.equal(retired in (converted.state as unknown as Record<string, unknown>), false, `canonical checkpoint must exclude ${retired}`);
}
assert.deepEqual(converted.state.practiceRuns.map((row) => row.id), ["run-1"]);
assert.deepEqual(converted.state.practiceRunSources, [{ runId: "run-1", bankId: "bank-1", bankNameSnapshot: "题库", position: 0 }]);
assert.equal(converted.state.practiceRunItems[0]?.submittedAttemptId, "attempt-1");
assert.deepEqual(converted.state.questionGroupItems, [{ groupId: "group-1", questionId: "question-1", position: 0, note: "重点" }]);
assert.deepEqual(converted.state.reviewRoundBanks, [{ roundId: "round-1", bankId: "bank-1", position: 0 }]);
assert.deepEqual(converted.state.reviewRoundItems, [{ roundId: "round-1", questionId: "question-1", position: 0 }]);

const report = verifyLegacySyncConversion(legacy, converted);
assert.equal(report.ok, true, report.errors.join("\n"));
assert.deepEqual(report.errors, []);
assert.equal(report.counts.attempts, 1);
assert.equal(report.counts.practiceRuns, 1);
assert.equal(report.counts.questions, 1);
assert.deepEqual(convertLegacySyncCheckpoint(structuredClone(legacy)), converted, "conversion must be deterministic and rerunnable");

class MemoryShadowRemote implements SyncShadowRemote {
  readonly blobs = new Map<string, Uint8Array>();
  writes = 0;

  async putImmutable(input: { path: string; bytes: Uint8Array; kind: SyncDescriptorKind }): Promise<SyncDescriptor> {
    const existing = this.blobs.get(input.path);
    if (existing) {
      if (!Buffer.from(existing).equals(Buffer.from(input.bytes))) throw new Error(`immutable shadow conflict at ${input.path}`);
    } else {
      this.blobs.set(input.path, input.bytes.slice());
      this.writes += 1;
    }
    return {
      path: input.path,
      blobSha: createHash("sha1").update(input.bytes).digest("hex"),
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      size: input.bytes.byteLength,
      storedSize: input.bytes.byteLength,
    };
  }

  async readBlob(descriptor: SyncDescriptor): Promise<Uint8Array> {
    const value = this.blobs.get(descriptor.path);
    if (!value) throw new Error(`missing shadow blob ${descriptor.path}`);
    return value.slice();
  }
}

const plan = buildSyncShadowPlan({ vaultId: "qa/converter@main", sourceHeadSha, checkpoint: converted });
assert.equal(plan.sourceFormatVersion, 9);
assert.equal(plan.targetFormatVersion, 10);
assert.equal(plan.cutoverHead.path, SYNC_HEAD_PATH);
assert.equal(plan.cutoverHead.authorized, false);

const remote = new MemoryShadowRemote();
const staged = await stageSyncShadow(plan, remote, { recentAttemptLimit: 0, recentPracticeRunLimit: 0, chunkCount: 1 });
validateSyncHead(staged.head);
assert.equal(staged.head.formatVersion, 10);
assert.ok(staged.checkpointDescriptor.path.startsWith("sync/v10/checkpoints/"));
assert.ok(staged.historyObjects.length >= 3, "forced archive must stage attempt chunk, run chunk and history index");
assert.ok(staged.historyObjects.every((item) => item.path.startsWith("sync/v10/history/")));
assert.ok([...remote.blobs.keys()].every((path) => path.startsWith("sync/v10/")));
assert.equal(remote.blobs.has(SYNC_HEAD_PATH), false, "shadow staging must never publish the mutable head");
await verifyStagedSyncShadow(converted, staged, remote);

const writesAfterFirstStage = remote.writes;
const stagedAgain = await stageSyncShadow(plan, remote, { recentAttemptLimit: 0, recentPracticeRunLimit: 0, chunkCount: 1 });
assert.equal(remote.writes, writesAfterFirstStage, "rerun must reuse identical immutable objects");
assert.deepEqual(stagedAgain.checkpointDescriptor, staged.checkpointDescriptor);
assert.deepEqual(stagedAgain.head, staged.head);

const conflictRemote = new MemoryShadowRemote();
const initial = await stageSyncShadow(plan, conflictRemote, { recentAttemptLimit: 0, recentPracticeRunLimit: 0, chunkCount: 1 });
const firstPath = initial.historyObjects[0]?.path ?? initial.checkpointDescriptor.path;
conflictRemote.blobs.set(firstPath, new TextEncoder().encode("tampered"));
await assert.rejects(
  () => stageSyncShadow(plan, conflictRemote, { recentAttemptLimit: 0, recentPracticeRunLimit: 0, chunkCount: 1 }),
  /immutable shadow conflict/,
);
assert.equal(conflictRemote.blobs.has(SYNC_HEAD_PATH), false, "conflict must fail closed before head publication");

const published: Array<{ path: string; content: string }> = [];
await publishSyncCutover(staged, {
  async readSourceHeadSha() { return sourceHeadSha; },
  async publishHead(path, content) { published.push({ path, content }); },
});
assert.equal(published.length, 1);
assert.equal(published[0]?.path, SYNC_HEAD_PATH);
const publishedHead = JSON.parse(published[0]?.content ?? "null") as unknown;
validateSyncHead(publishedHead);

let stalePublishes = 0;
await assert.rejects(() => publishSyncCutover(staged, {
  async readSourceHeadSha() { return "f".repeat(40); },
  async publishHead() { stalePublishes += 1; },
}), /source sync head changed/);
assert.equal(stalePublishes, 0, "changed source head must abort before cutover write");

console.log("sync converter contract passed: canonical conversion, runtime-readable v10 shadow, idempotent immutable staging and head-last cutover guard");
