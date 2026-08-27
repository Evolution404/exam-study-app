import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { readAttemptsForQuestionIdsV7, readNotesForQuestionIdsV7 } from "../../src/lib/db/search-read-v7";
import { buildSearchIndexQuestion } from "../../src/lib/question/search-read-model";
import { emptySearchFilterProjection, filterSearchIndex } from "../../src/lib/question/search-matching";
import type { AttemptV7, NoteV7, QuestionV7 } from "../../src/lib/db/v7-types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetV7Database();
const at = "2026-08-27T00:00:00.000Z";

const questions: QuestionV7[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `q-${index}`,
  type: "简答",
  content: [{ id: `stem-${index}`, type: "text", text: index % 1000 === 0 ? `性能命中 ${index}` : `普通题目 ${index}` }],
  options: [],
  solution: { kind: "short", referenceText: `参考答案 ${index}` },
  tags: index % 2 ? ["线路"] : ["安全"],
  contentFingerprint: `fp-${index}`,
  updatedAt: at,
  deviceId: "perf-test",
}));
const index = questions.map((question) => buildSearchIndexQuestion(question));
const indexResult = filterSearchIndex(index, {
  query: "性能命中",
  filters: { ...emptySearchFilterProjection("stem"), keywordMode: "plain" },
});
assert.equal(index.length, 10_000, "10,000 questions 必须完整构建 search read-model");
assert.equal(indexResult.total, 10, "10,000 questions 查询必须返回稳定完整结果");

const truncatedField = buildSearchIndexQuestion({
  id: "field-limit",
  type: "简答",
  content: [{ id: "stem", type: "text", text: `${"x".repeat(20_000)}FIELD_LIMIT_SENTINEL` }],
  options: [],
  solution: { kind: "short", referenceText: "" },
  tags: [],
  contentFingerprint: "field-limit",
  updatedAt: at,
  deviceId: "perf-test",
});
assert.equal(filterSearchIndex([truncatedField], {
  query: "FIELD_LIMIT_SENTINEL",
  filters: { ...emptySearchFilterProjection("stem"), keywordMode: "plain" },
}).total, 0, "MAX_SEARCH_FIELD_LENGTH 边界必须继续截断超长字段");

const targetNoteIds = ["target-note-1", "target-note-2", "target-note-3"];
const unrelatedNotes: NoteV7[] = Array.from({ length: 20_000 }, (_, index) => ({
  questionId: `unrelated-note-${index}`,
  content: `unrelated ${index}`,
  revision: 1,
  updatedAt: at,
  deviceId: "perf-test",
}));
const targetNotes: NoteV7[] = targetNoteIds.map((questionId) => ({ questionId, content: `target ${questionId}`, revision: 1, updatedAt: at, deviceId: "perf-test" }));
await dbV7.notes.bulkPut([...unrelatedNotes, ...targetNotes]);
let noteReadCount = 0;
const noteReadingHook = (row: NoteV7) => { noteReadCount += 1; return row; };
dbV7.notes.hook("reading", noteReadingHook);
const notes = await readNotesForQuestionIdsV7([...targetNoteIds, targetNoteIds[0], "missing-note"]);
dbV7.notes.hook("reading").unsubscribe(noteReadingHook);
assert.deepEqual(notes.map((row) => row.questionId).sort(), [...targetNoteIds].sort(), "Quick Search note reader 只能返回当前题目 notes");
assert.equal(noteReadCount, targetNoteIds.length + 1, "大量无关 notes 不得让读取 cardinality 超过去重后的当前题目请求键数");

const targetAttemptIds = ["target-attempt-q1", "target-attempt-q2"];
const attempts: AttemptV7[] = Array.from({ length: 100_000 }, (_, index) => ({
  id: `attempt-${index}`,
  runId: "perf-run",
  questionId: `unrelated-attempt-q-${index % 1000}`,
  selected: "A",
  correct: true,
  elapsedMs: 1,
  createdAt: at,
  deviceId: "perf-test",
}));
const targetAttempts: AttemptV7[] = Array.from({ length: 7 }, (_, index) => ({
  id: `target-attempt-${index}`,
  runId: "perf-run",
  questionId: targetAttemptIds[index % targetAttemptIds.length],
  selected: "A",
  correct: index % 2 === 0,
  elapsedMs: 1,
  createdAt: at,
  deviceId: "perf-test",
}));
await dbV7.attempts.bulkPut([...attempts, ...targetAttempts]);
let attemptReadCount = 0;
const attemptReadingHook = (row: AttemptV7) => { attemptReadCount += 1; return row; };
dbV7.attempts.hook("reading", attemptReadingHook);
const targetedAttempts = await readAttemptsForQuestionIdsV7(targetAttemptIds);
dbV7.attempts.hook("reading").unsubscribe(attemptReadingHook);
assert.equal(targetedAttempts.length, targetAttempts.length, "100,000 attempts 场景必须完整读取当前小题集历史");
assert.equal(attemptReadCount, targetAttempts.length, "100,000 unrelated attempts 不得被 Search View materialize");
assert.ok(targetedAttempts.every((row) => targetAttemptIds.includes(row.questionId)), "targeted attempt query 不得混入无关题目");

await dbV7.close();
console.log("search performance tests passed: 10k index, note cardinality, 100k attempt cardinality and field-length guard");
