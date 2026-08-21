import assert from "node:assert/strict";
import type { PracticeRunV7 } from "../../src/lib/db/v7-types";
import type { ChangeSetProjectionV7 } from "../../src/lib/sync/change-set-v7-projection";
import {
  changeSetOutsideHistoryRange,
  filterProjectionHistoryV7,
  normalizeHistorySyncStart,
} from "../../src/lib/sync/history-sync-range";

const run = (id: string, startedAt: string, status: PracticeRunV7["status"]): PracticeRunV7 => ({
  id, bankId: "b", bankIds: ["b"], bankName: "题库", mode: "sequential", modeLabel: "练习",
  questionIds: ["q"], questionTypes: { q: "单选" }, answers: {}, shuffleOptions: false,
  optionOrders: {}, startedAt, updatedAt: startedAt, status, revision: 1,
});
const attempt = (id: string, runId: string, createdAt: string) => ({ id, runId, questionId: "q", selected: "A", correct: true, elapsedMs: 1000, createdAt, deviceId: "d" });
const projection = {
  banks: [], bankFolders: [], questions: [], memberships: [], bankQuestionMemberships: [], imageAssets: [], notes: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [],
  practiceRuns: [run("active-old", "2025-01-01T00:00:00.000Z", "in_progress"), run("done-old", "2025-01-02T00:00:00.000Z", "completed"), run("done-new", "2026-02-01T00:00:00.000Z", "completed")],
  attempts: [attempt("a-active", "active-old", "2025-01-01T01:00:00.000Z"), attempt("a-old", "done-old", "2025-01-02T01:00:00.000Z"), attempt("a-new", "done-new", "2026-02-01T01:00:00.000Z")],
  attemptStats: [], attemptDailyStats: [], practiceRunStats: [],
} as unknown as ChangeSetProjectionV7;

assert.equal(normalizeHistorySyncStart("2026-02-01"), "2026-02-01");
assert.equal(normalizeHistorySyncStart("2026-02-31"), undefined);
assert.equal(normalizeHistorySyncStart("all"), undefined);

const filtered = filterProjectionHistoryV7(projection, "2026-01-01");
assert.deepEqual(filtered.practiceRuns.map((item) => item.id), ["active-old", "done-new"], "old active run stays resumable while old completed history is removed");
assert.deepEqual(filtered.attempts.map((item) => item.id), ["a-active", "a-new"], "attempts for the preserved active run stay with it");
assert.equal(filtered.attemptStats[0]?.total, 2, "derived statistics rebuild from the retained history only");

const oldAnswer = { createdAt: "2025-01-01T00:00:00.000Z", mutations: [{ kind: "attempt.create", attempt: attempt("a", "r", "2025-01-01T00:00:00.000Z") }] };
const oldContent = { createdAt: "2025-01-01T00:00:00.000Z", mutations: [{ kind: "note.deleted", questionId: "q", deletedAt: "2025-01-01T00:00:00.000Z" }] };
const currentDelete = { createdAt: "2026-03-01T00:00:00.000Z", mutations: [{ kind: "attempt.delete", attemptId: "a", deletedAt: "2026-03-01T00:00:00.000Z" }] };
assert.equal(changeSetOutsideHistoryRange(oldAnswer as never, "2026-01-01"), true, "unsent old history-only change is excluded");
assert.equal(changeSetOutsideHistoryRange(oldContent as never, "2026-01-01"), false, "content changes are never suppressed by the history range");
assert.equal(changeSetOutsideHistoryRange(currentDelete as never, "2026-01-01"), false, "explicit current deletes retain their normal synchronization semantics");

console.log("history sync range tests passed: validation, local pruning, active-run preservation and old queue filtering");
