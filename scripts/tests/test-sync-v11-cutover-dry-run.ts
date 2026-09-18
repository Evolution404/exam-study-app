import assert from "node:assert/strict";
import { convertHydratedV10CheckpointToV11 } from "../tools/sync-v10-to-v11-dry-run";
import { CHANGE_SET_FORMAT } from "../../src/lib/sync/change-set-types";
import { SYNC_CHECKPOINT_FORMAT } from "../../src/lib/sync/sync-checkpoint-types";
import {
  SYNC_ASSET_PREFIX,
  SYNC_CHECKPOINT_PREFIX,
  SYNC_FORMAT_VERSION,
  SYNC_HEAD_PATH,
  SYNC_HISTORY_PREFIX,
  SYNC_OBJECT_PREFIX,
  SYNC_SEGMENT_PREFIX,
} from "../../src/lib/sync/sync-head-types";

const AT = "2026-09-18T00:00:00.000Z";
const legacy = {
  formatVersion: 7,
  generatedAt: AT,
  cursors: { "device-v10": 42 },
  state: {
    banks: [{ id: "b1", name: "旧题库", sortOrder: 0, questionCount: 1, importedAt: AT, updatedAt: AT, deviceId: "device-v10" }],
    bankFolders: [],
    questions: [{
      id: "q1",
      type: "单选",
      content: [{ id: "stem", type: "text", text: "v11 cutover" }],
      options: [
        [{ id: "a", type: "text", text: "A" }],
        [{ id: "b", type: "text", text: "B" }],
      ],
      optionIds: ["a", "b"],
      solution: { kind: "choice", correctOptionIds: ["a"] },
      tags: [],
      contentFingerprint: "fp-v11-cutover",
      updatedAt: AT,
      deviceId: "device-v10",
    }],
    memberships: [{ key: "b1:q1", bankId: "b1", questionId: "q1", sortOrder: 0, addedAt: AT, updatedAt: AT, deviceId: "device-v10" }],
    imageAssets: [],
    attempts: [],
    notes: [],
    practiceRuns: [{
      id: "r1",
      mode: "sequential",
      modeLabel: "顺序练习",
      shuffleOptions: false,
      startedAt: AT,
      updatedAt: AT,
      status: "in_progress",
      revision: 0,
      bankNameSnapshot: "旧题库",
      activityAt: AT,
    }],
    practiceRunSources: [{ runId: "r1", bankId: "b1", bankNameSnapshot: "旧题库", position: 0 }],
    practiceRunItems: [{
      runId: "r1",
      questionId: "q1",
      position: 0,
      questionTypeSnapshot: "单选",
      optionOrder: [0, 1],
      draftSelected: ["a"],
      draftResponse: { kind: "choice", selectedOptionIds: ["a"] },
    }],
    questionGroups: [],
    questionGroupItems: [],
    reviewRounds: [],
    reviewRoundBanks: [],
    reviewRoundItems: [],
    tombstones: [],
    attemptStats: [{ questionId: "q1", total: 99 }],
    bankPracticeStats: [{ bankId: "b1", total: 99 }],
  },
};
const legacySnapshot = structuredClone(legacy);
const converted = convertHydratedV10CheckpointToV11(legacy);

assert.equal(SYNC_FORMAT_VERSION, 11);
assert.equal(SYNC_CHECKPOINT_FORMAT, 8);
assert.equal(CHANGE_SET_FORMAT, 8);
for (const path of [
  SYNC_HEAD_PATH,
  SYNC_CHECKPOINT_PREFIX,
  SYNC_OBJECT_PREFIX,
  SYNC_HISTORY_PREFIX,
  SYNC_SEGMENT_PREFIX,
  SYNC_ASSET_PREFIX,
]) {
  assert.match(path, /^sync\/v11\//, "current runtime wire paths must live only in sync/v11");
  assert.doesNotMatch(path, /sync\/v10\//);
}

assert.equal(converted.formatVersion, 8);
assert.deepEqual(converted.cursors, { "device-v10": 42 });
assert.equal(converted.counts.banks, 1);
assert.equal(converted.counts.questions, 1);
assert.equal(converted.counts.memberships, 1);
assert.equal(converted.counts.practiceRuns, 1);
assert.equal(converted.counts.practiceRunItems, 1);
assert.equal("questionCount" in converted.state.banks[0]!, false, "v11 canonical bank must strip derived questionCount");
assert.equal("draftSelected" in converted.state.practiceRunItems[0]!, false, "v11 run item must strip local draft selection");
assert.equal("draftResponse" in converted.state.practiceRunItems[0]!, false, "v11 run item must strip local draft response");
for (const localOnly of ["attemptStats", "attemptDailyStats", "bankQuestionStats", "bankPracticeStats", "bankPracticeRunIndex", "reviewRoundProgress", "practiceDrafts", "imageBlobs"]) {
  assert.equal(localOnly in (converted.state as unknown as Record<string, unknown>), false, `${localOnly} must not survive v11 conversion`);
}
assert.deepEqual(legacy, legacySnapshot, "dry-run conversion must not mutate the immutable v10 source snapshot");

const encoded = JSON.stringify(converted);
assert.doesNotMatch(encoded, /questionCount|draftSelected|draftResponse|attemptStats|bankPracticeStats|practiceDrafts|imageBlobs/);

console.log("sync v11 cutover dry-run passed: v10 hydrated facts convert to canonical-only v11 without runtime dual-stack");
