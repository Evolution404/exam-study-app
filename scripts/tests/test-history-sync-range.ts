import assert from "node:assert/strict";
import type { CanonicalState, PracticeRunRecord } from "../../src/lib/db/types";
import {
  changeSetOutsideHistoryRange,
  filterCanonicalHistory,
  normalizeHistorySyncStart,
} from "../../src/lib/sync/history-sync-range";

const run = (id: string, startedAt: string, status: PracticeRunRecord["status"]): PracticeRunRecord => ({
  id,
  mode: "sequential",
  modeLabel: "练习",
  shuffleOptions: false,
  startedAt,
  updatedAt: startedAt,
  status,
  revision: 1,
  bankNameSnapshot: "题库",
  activityAt: startedAt,
});
const attempt = (id: string, runId: string, createdAt: string) => ({
  id,
  runId,
  questionId: "q",
  selected: "A",
  correct: true,
  elapsedMs: 1000,
  createdAt,
  deviceId: "d",
});
const practiceRuns = [
  run("active-old", "2025-01-01T00:00:00.000Z", "in_progress"),
  run("done-old", "2025-01-02T00:00:00.000Z", "completed"),
  run("done-new", "2026-02-01T00:00:00.000Z", "completed"),
];
const state: CanonicalState = {
  banks: [{ id: "b", name: "题库", sortOrder: 0, importedAt: "2025-01-01T00:00:00.000Z" }],
  bankFolders: [],
  questions: [{
    id: "q",
    type: "单选",
    content: [{ id: "stem", type: "text", text: "题目" }],
    options: [[{ id: "a", type: "text", text: "A" }]],
    solution: { kind: "choice", correctOptionIds: ["a"] },
    tags: [],
    contentFingerprint: "q",
    updatedAt: "2025-01-01T00:00:00.000Z",
    deviceId: "d",
  }],
  memberships: [],
  imageAssets: [],
  attempts: [
    attempt("a-active", "active-old", "2025-01-01T01:00:00.000Z"),
    attempt("a-old", "done-old", "2025-01-02T01:00:00.000Z"),
    attempt("a-new", "done-new", "2026-02-01T01:00:00.000Z"),
  ],
  notes: [],
  practiceRuns,
  practiceRunSources: practiceRuns.map((item) => ({
    runId: item.id,
    bankId: "b",
    bankNameSnapshot: "题库",
    position: 0,
  })),
  practiceRunItems: practiceRuns.map((item) => ({
    runId: item.id,
    questionId: "q",
    position: 0,
    questionTypeSnapshot: "单选",
    optionOrder: [],
  })),
  questionGroups: [],
  questionGroupItems: [],
  reviewRounds: [],
  reviewRoundBanks: [],
  reviewRoundItems: [],
  tombstones: [],
};

assert.equal(normalizeHistorySyncStart("2026-02-01"), "2026-02-01");
assert.equal(normalizeHistorySyncStart("2026-02-31"), undefined);
assert.equal(normalizeHistorySyncStart("all"), undefined);

const filtered = filterCanonicalHistory(state, "2026-01-01");
assert.deepEqual(filtered.practiceRuns.map((item) => item.id), ["active-old", "done-new"], "old active run stays resumable while old completed history is removed");
assert.deepEqual(filtered.practiceRunSources.map((item) => item.runId), ["active-old", "done-new"], "normalized source rows stay aligned with retained runs");
assert.deepEqual(filtered.practiceRunItems.map((item) => item.runId), ["active-old", "done-new"], "normalized item rows stay aligned with retained runs");
assert.deepEqual(filtered.attempts.map((item) => item.id), ["a-active", "a-new"], "attempts for the preserved active run stay with it");

const oldAnswer = { createdAt: "2025-01-01T00:00:00.000Z", mutations: [{ kind: "attempt.create", attempt: attempt("a", "r", "2025-01-01T00:00:00.000Z") }] };
const oldContent = { createdAt: "2025-01-01T00:00:00.000Z", mutations: [{ kind: "note.deleted", questionId: "q", deletedAt: "2025-01-01T00:00:00.000Z" }] };
const currentDelete = { createdAt: "2026-03-01T00:00:00.000Z", mutations: [{ kind: "attempt.delete", attemptId: "a", deletedAt: "2026-03-01T00:00:00.000Z" }] };
assert.equal(changeSetOutsideHistoryRange(oldAnswer as never, "2026-01-01"), true, "unsent old history-only change is excluded");
assert.equal(changeSetOutsideHistoryRange(oldContent as never, "2026-01-01"), false, "content changes are never suppressed by the history range");
assert.equal(changeSetOutsideHistoryRange(currentDelete as never, "2026-01-01"), false, "explicit current deletes retain their normal synchronization semantics");

console.log("history sync range tests passed: validation, normalized pruning, active-run preservation and old queue filtering");
