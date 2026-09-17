import assert from "node:assert/strict";
import { sha256DigestHex } from "../../src/lib/crypto/sha256";
import { canonicalSerialize } from "../../src/lib/sync/change-set-codec";
import { encodeSyncSegment } from "../../src/lib/sync/sync-head-operations";
import { validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";
import type { SyncDescriptor, SyncHead, SyncImmutableRef, SyncSegmentDescriptor } from "../../src/lib/sync/sync-head-types";
import {
  hydrateLegacyRemoteSnapshot,
  type LegacySyncRemoteSource,
} from "../tools/sync-remote-reader";
import type { LegacySyncCheckpoint } from "../tools/sync-v9-to-v10-converter";

const encoder = new TextEncoder();
const vaultId = "qa/converter@main";
const archivedAt = "2026-08-01T00:00:00.000Z";
const recentAt = "2026-09-17T00:00:00.000Z";
const hotAt = "2026-09-17T00:01:00.000Z";

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

async function immutableDescriptor(prefix: string, value: unknown): Promise<{ descriptor: SyncDescriptor; bytes: Uint8Array }> {
  const body = bytes(value);
  const sha256 = await sha256DigestHex(body);
  return {
    descriptor: {
      path: `${prefix}${sha256}.json`,
      blobSha: "1".repeat(40),
      sha256,
      size: body.byteLength,
      storedSize: body.byteLength,
    },
    bytes: body,
  };
}

function attempt(id: string, runId: string, createdAt: string, correct = true, elapsedMs = 1000) {
  return {
    id,
    runId,
    questionId: "question-1",
    sourceBankId: "bank-1",
    selected: "option-a",
    correct,
    elapsedMs,
    createdAt,
    deviceId: "device-a",
  };
}

function run(id: string, attemptId: string, at: string) {
  return {
    id,
    bankId: "bank-1",
    bankIds: ["bank-1"],
    bankName: "题库",
    mode: "sequential" as const,
    modeLabel: "练习",
    questionIds: ["question-1"],
    questionTypes: { "question-1": "单选" as const },
    answers: {
      "question-1": {
        selected: ["option-a"],
        submitted: true as const,
        correct: true,
        updatedAt: at,
        deviceId: "device-a",
        eventId: attemptId,
      },
    },
    shuffleOptions: false,
    optionOrders: { "question-1": [0] },
    startedAt: at,
    updatedAt: at,
    completedAt: at,
    status: "completed" as const,
    revision: 1,
  };
}

const archivedAttempt = attempt("attempt-old", "run-old", archivedAt);
const recentAttempt = attempt("attempt-1", "run-1", recentAt);
const archivedRun = run("run-old", archivedAttempt.id, archivedAt);
const recentRun = run("run-1", recentAttempt.id, recentAt);

const baseState = {
  banks: [{ id: "bank-1", name: "题库", questionCount: 1, sortOrder: 0, importedAt: archivedAt, updatedAt: recentAt, deviceId: "device-a" }],
  bankFolders: [],
  questions: [{
    id: "question-1",
    type: "单选" as const,
    content: [{ id: "stem-1", type: "text" as const, text: "题目" }],
    options: [[{ id: "option-a-block", type: "text" as const, text: "A" }]],
    optionIds: ["option-a"],
    solution: { kind: "choice" as const, correctOptionIds: ["option-a"] },
    tags: [],
    contentFingerprint: "fingerprint-question-1",
    updatedAt: recentAt,
    deviceId: "device-a",
  }],
  memberships: [{ key: "bank-1:question-1", bankId: "bank-1", questionId: "question-1", sortOrder: 0, addedAt: archivedAt, updatedAt: recentAt, deviceId: "device-a" }],
  imageAssets: [],
  attempts: [recentAttempt],
  attemptStats: [],
  attemptDailyStats: [],
  notes: [{ questionId: "question-1", content: "原解析", revision: 1, updatedAt: recentAt, deviceId: "device-a" }],
  practiceRuns: [recentRun],
  practiceRunStats: [],
  questionGroups: [],
  reviewRounds: [],
  reviewRoundProgress: [],
  tombstones: [],
} as unknown as LegacySyncCheckpoint["state"];

const attemptHistory = await immutableDescriptor("sync/v9/history/", {
  formatVersion: 9,
  kind: "attempts",
  generatedAt: recentAt,
  items: [archivedAttempt],
});
const runHistory = await immutableDescriptor("sync/v9/history/", {
  formatVersion: 9,
  kind: "practiceRuns",
  generatedAt: recentAt,
  items: [archivedRun],
});
const historyIndex = await immutableDescriptor("sync/v9/history/", {
  formatVersion: 9,
  generatedAt: recentAt,
  attempts: [{ ...attemptHistory.descriptor, kind: "attempts", count: 1, firstAt: archivedAt, lastAt: archivedAt }],
  practiceRuns: [{ ...runHistory.descriptor, kind: "practiceRuns", count: 1, firstAt: archivedAt, lastAt: archivedAt }],
  counts: { attempts: 1, practiceRuns: 1 },
});

const remoteCheckpoint = {
  formatVersion: 9,
  generatedAt: recentAt,
  state: baseState,
  cursors: { "device-a": 42 },
  counts: {
    banks: 1,
    bankFolders: 0,
    questions: 1,
    memberships: 1,
    imageAssets: 0,
    attempts: 1,
    attemptStats: 0,
    attemptDailyStats: 0,
    notes: 1,
    practiceRuns: 1,
    practiceRunStats: 0,
    questionGroups: 0,
    reviewRounds: 0,
    reviewRoundProgress: 0,
    tombstones: 0,
    totalAttempts: 2,
    totalPracticeRuns: 2,
  },
  retention: {
    recentAttemptLimit: 1,
    recentPracticeRunLimit: 1,
    oldestRecentAttemptAt: recentAt,
  },
  history: {
    index: historyIndex.descriptor,
    archivedAttempts: 1,
    archivedPracticeRuns: 1,
  },
};
const checkpoint = await immutableDescriptor("sync/v9/checkpoints/", remoteCheckpoint);

const updatedAttempt = attempt("attempt-1", "run-1", recentAt, false, 2222);
const legacyChangeBase = {
  formatVersion: 7,
  id: "change-hot-1",
  deviceId: "device-a",
  localSequence: 43,
  createdAt: hotAt,
  kind: "batch",
  mutations: [
    { kind: "attempt.update", attempt: updatedAttempt },
    { kind: "note.upserted", note: { questionId: "question-1", content: "热分段解析", revision: 2, updatedAt: hotAt, deviceId: "device-a" } },
  ],
  entityRefs: [
    { type: "attempt", id: "attempt-1" },
    { type: "note", id: "question-1" },
  ],
};
const legacyDigest = await sha256DigestHex(encoder.encode(canonicalSerialize(legacyChangeBase)));
const legacyChange = { ...legacyChangeBase, digest: legacyDigest };
const offloadedBody = bytes(legacyChange);
const offloadedSha = await sha256DigestHex(offloadedBody);
const offloadedRef: SyncImmutableRef = {
  path: `sync/v9/objects/${offloadedSha}.json`,
  sha256: offloadedSha,
  size: offloadedBody.byteLength,
  kind: "object",
};
const segmentBytes = encodeSyncSegment({
  formatVersion: 9,
  vaultId,
  generation: 1,
  ordinal: 0,
  metadata: { vaultId, createdAt: hotAt, deviceId: "device-a" },
  cursors: { "device-a": 43 },
  events: [{
    payloadRef: offloadedRef,
    formatVersion: 7,
    id: legacyChange.id,
    deviceId: legacyChange.deviceId,
    localSequence: legacyChange.localSequence,
    createdAt: legacyChange.createdAt,
    kind: legacyChange.kind,
    digest: legacyChange.digest,
  }],
});
const segmentSha = await sha256DigestHex(segmentBytes);
const segmentDescriptor: SyncSegmentDescriptor = {
  path: `sync/v9/segments/${segmentSha}.json`,
  blobSha: "2".repeat(40),
  sha256: segmentSha,
  size: segmentBytes.byteLength,
  storedSize: segmentBytes.byteLength,
  generation: 1,
  ordinal: 0,
  count: 1,
  cursors: { "device-a": 43 },
  metadata: { vaultId, createdAt: hotAt, deviceId: "device-a" },
};

const head: SyncHead = {
  formatVersion: 9,
  vaultId,
  generatedAt: hotAt,
  generation: 1,
  metadata: { vaultId, deviceId: "device-a" },
  checkpoint: checkpoint.descriptor,
  segments: [segmentDescriptor],
  cursors: { "device-a": 43 },
};

class MemoryLegacySource implements LegacySyncRemoteSource {
  readonly files = new Map<string, Uint8Array>();

  constructor(readonly head: SyncHead, readonly headSha: string) {}

  async readHead() {
    return { head: structuredClone(this.head), headSha: this.headSha };
  }

  async readDescriptor(descriptor: SyncDescriptor) {
    const value = this.files.get(descriptor.path);
    if (!value) throw new Error(`missing descriptor ${descriptor.path}`);
    return value.slice();
  }

  async readImmutable(ref: SyncImmutableRef) {
    const value = this.files.get(ref.path);
    if (!value) throw new Error(`missing immutable object ${ref.path}`);
    return value.slice();
  }
}

const source = new MemoryLegacySource(head, "c".repeat(40));
source.files.set(checkpoint.descriptor.path, checkpoint.bytes);
source.files.set(historyIndex.descriptor.path, historyIndex.bytes);
source.files.set(attemptHistory.descriptor.path, attemptHistory.bytes);
source.files.set(runHistory.descriptor.path, runHistory.bytes);
source.files.set(segmentDescriptor.path, segmentBytes);
source.files.set(offloadedRef.path, offloadedBody);

const dryRun = await hydrateLegacyRemoteSnapshot(source);
validateSyncCheckpoint(dryRun.checkpoint);
assert.equal(dryRun.sourceHeadSha, "c".repeat(40));
assert.deepEqual(dryRun.checkpoint.cursors, { "device-a": 43 }, "target cursor must include the hot segment");
assert.equal(dryRun.checkpoint.state.attempts.length, 2, "archived + recent attempts must both survive");
assert.equal(dryRun.checkpoint.state.practiceRuns.length, 2, "archived + recent runs must both survive");
assert.deepEqual(dryRun.checkpoint.state.practiceRuns.map((item) => item.id).sort(), ["run-1", "run-old"]);
const convertedRecent = dryRun.checkpoint.state.attempts.find((item) => item.id === "attempt-1");
assert.equal(convertedRecent?.correct, false, "retired attempt.update must be folded into the canonical target");
assert.equal(convertedRecent?.elapsedMs, 2222);
assert.equal(dryRun.checkpoint.state.notes[0]?.content, "热分段解析", "ordinary hot-segment mutations must also replay");
assert.equal(dryRun.archivedAttempts, 1);
assert.equal(dryRun.archivedPracticeRuns, 1);
assert.equal(dryRun.hotChangeSets, 1);

const repeatedDryRun = await hydrateLegacyRemoteSnapshot(source);
assert.deepEqual(repeatedDryRun, dryRun, "read-only dry-run must be deterministic and rerunnable");

const corrupted = new MemoryLegacySource(head, "c".repeat(40));
for (const [path, value] of source.files) corrupted.files.set(path, value.slice());
corrupted.files.set(offloadedRef.path, encoder.encode("tampered"));
await assert.rejects(() => hydrateLegacyRemoteSnapshot(corrupted), /integrity|sha256|size/i, "offloaded object corruption must fail closed");

console.log("legacy remote snapshot conversion passed: history + hot segments + offloaded object + retired mutation replay");
