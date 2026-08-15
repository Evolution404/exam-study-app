import assert from "node:assert/strict";
import type { AttemptStats } from "../../src/types/types";
import {
  calculateProgressCompletion,
  buildScopedQuestionStats,
  isQuestionDoneInScope,
  normalizeProgressScope,
  progressScopeCutoff,
  progressScopeKey,
  progressScopeLabel,
  summarizeScopedQuestionStats,
} from "../../src/lib/practice/progress-scope";
import {
  deleteContentBlock,
  deriveContentText,
  deriveSearchText,
  insertImageAtSelection,
  moveContentBlock,
  normalizeContentText,
  plainTextToContentBlocks,
  questionContentFingerprint,
  replaceContentBlock,
  summarizeContent,
} from "../../src/lib/question/question-content";
import type { AttemptV6, ContentBlock, QuestionV6, ReviewRoundProgress } from "../../src/lib/db/v6-types";

const reference = "2026-01-01T00:00:00.000Z";
const day = 24 * 60 * 60 * 1000;
const attempt = (questionId: string, latestAttemptAt: string, total = 1): AttemptStats => ({
  questionId,
  bankId: "bank-a",
  total,
  correct: 1,
  wrong: Math.max(0, total - 1),
  giveUps: 0,
  totalElapsedMs: 10,
  firstAttemptAt: latestAttemptAt,
  firstAttemptCorrect: true,
  latestAttemptAt,
  hasBeenWrong: false,
  correctStreakAfterWrong: 0,
  currentCorrectStreak: 1,
  recentOutcomes: [],
});

const roundProgress = (roundId: string, questionId: string, attempts = 1): ReviewRoundProgress => ({
  key: `${roundId}:${questionId}`,
  roundId,
  questionId,
  attempts,
  correct: attempts,
  wrong: 0,
  firstAttemptAt: reference,
  latestAttemptAt: reference,
});

const stats = [
  attempt("boundary", new Date(Date.parse(reference) - 90 * day).toISOString()),
  attempt("recent", new Date(Date.parse(reference) - 2 * day).toISOString()),
  attempt("old", new Date(Date.parse(reference) - 91 * day).toISOString()),
];

assert.deepEqual(normalizeProgressScope(undefined), { type: "rolling", days: 90 });
assert.deepEqual(normalizeProgressScope({ type: "rolling", days: 0 }), { type: "rolling", days: 90 });
assert.deepEqual(normalizeProgressScope({ type: "round", roundId: " round-1 " }), { type: "round", roundId: "round-1" });
assert.equal(progressScopeKey({ type: "lifetime" }), "lifetime");
assert.equal(progressScopeKey({ type: "rolling", days: 90 }), "rolling:90");
assert.equal(progressScopeKey({ type: "round", roundId: "round-1" }), "round:round-1");
assert.equal(progressScopeLabel({ type: "rolling", days: 90 }), "近 90 天");
assert.equal(progressScopeCutoff({ type: "rolling", days: 90 }, reference), Date.parse(reference) - 90 * day);
assert.equal(progressScopeCutoff({ type: "lifetime" }, reference), null);

assert.equal(isQuestionDoneInScope("boundary", { type: "rolling", days: 90 }, stats, [], reference), true, "cutoff is inclusive");
assert.equal(isQuestionDoneInScope("old", { type: "rolling", days: 90 }, stats, [], reference), false);
assert.equal(isQuestionDoneInScope("old", { type: "lifetime" }, stats, [], reference), true);
assert.equal(isQuestionDoneInScope("missing", { type: "lifetime" }, stats, [], reference), false, "no attempt is incomplete");
assert.equal(isQuestionDoneInScope("round-question", { type: "round", roundId: "round-1" }, [], [roundProgress("round-1", "round-question")], reference), true);
assert.equal(isQuestionDoneInScope("round-question", { type: "round", roundId: "round-1" }, [], [roundProgress("round-1", "round-question", 0)], reference), false);
assert.deepEqual(
  calculateProgressCompletion(["recent", "recent", "old", "missing"], { type: "rolling", days: 90 }, stats, [], reference),
  { total: 3, completed: 1, percent: 33 },
  "completion deduplicates question IDs",
);
assert.deepEqual(
  calculateProgressCompletion(["round-question", "round-empty"], { type: "round", roundId: "round-1" }, [], [roundProgress("round-1", "round-question"), roundProgress("round-1", "round-empty", 0)], reference),
  { total: 2, completed: 1, percent: 50 },
  "completion honours round progress with zero attempts",
);

const scopedAttempt = (id: string, questionId: string, createdAt: string, correct: boolean, selected = "A"): AttemptV6 => ({
  id, runId: "run-1", questionId, createdAt, correct, selected, elapsedMs: 100, deviceId: "device-a",
});
const scopedAttempts = [
  scopedAttempt("old", "q1", new Date(Date.parse(reference) - 91 * day).toISOString(), false),
  scopedAttempt("wrong", "q1", new Date(Date.parse(reference) - 3 * day).toISOString(), false, ""),
  scopedAttempt("correct", "q1", new Date(Date.parse(reference) - day).toISOString(), true),
  scopedAttempt("q2", "q2", reference, true),
];
const rollingStats = buildScopedQuestionStats(["q1", "q2"], { type: "rolling", days: 90 }, scopedAttempts, [], reference);
assert.equal(rollingStats.get("q1")?.total, 2, "rolling statistics exclude attempts before the exact cutoff");
assert.equal(rollingStats.get("q1")?.correctStreakAfterWrong, 1, "rolling statistics preserve outcome order");
assert.deepEqual(summarizeScopedQuestionStats(rollingStats), {
  attempts: 3, correct: 2, wrong: 1, giveUps: 1, totalElapsedMs: 300, attemptedQuestions: 2,
  firstCorrect: 1, firstKnown: 2, lastAttemptAt: reference,
});
const selectedRoundStats = buildScopedQuestionStats(["q1"], { type: "round", roundId: "round-1" }, [], [{
  ...roundProgress("round-1", "q1", 3), correct: 2, wrong: 1,
}], reference);
assert.equal(selectedRoundStats.get("q1")?.total, 3, "round statistics use the durable round projection");
assert.equal(summarizeScopedQuestionStats(selectedRoundStats).giveUps, undefined, "unrecoverable round detail stays unknown instead of being fabricated");

assert.equal(normalizeContentText("  A\r\n B  "), "A\nB");
assert.deepEqual(plainTextToContentBlocks("a\r\nb"), [{ id: "text-0", type: "text", text: "a\nb" }]);
const shared: ContentBlock = { id: "shared-text", type: "text", text: "same" };
const question: QuestionV6 = {
  id: "question-1",
  type: "单选",
  content: [shared],
  options: [[shared], [{ id: "option-2", type: "text", text: "other" }]],
  answer: "A",
  tags: ["tag"],
  favorite: false,
  contentFingerprint: "",
  updatedAt: reference,
  deviceId: "device-a",
};
assert.equal(deriveContentText(question.content), "same");
assert.equal(deriveSearchText([{ id: "image", type: "image", assetId: "asset-1", alt: "diagram" }]), "diagram");
assert.equal(summarizeContent([{ id: "text", type: "text", text: "A long preview" }], 4), "A l…");
const sameContentDifferentBank = { ...question, id: "question-2", tags: ["other"], favorite: true };
assert.equal(questionContentFingerprint(question), questionContentFingerprint(sameContentDifferentBank), "bank-independent fingerprint");
assert.equal(
  questionContentFingerprint(question),
  questionContentFingerprint({
    ...question,
    content: [{ id: "part-a", type: "text", text: "s" }, { id: "part-b", type: "text", text: "ame" }],
    options: [[{ id: "option-part-a", type: "text", text: "same" }], [{ id: "option-2", type: "text", text: "other" }]],
  }),
  "fingerprint ignores adjacent text block splitting",
);
assert.notEqual(questionContentFingerprint(question), questionContentFingerprint({ ...question, answer: "B" }));
assert.notEqual(questionContentFingerprint(question), questionContentFingerprint({ ...question, type: "多选" }));
assert.notEqual(
  questionContentFingerprint(question),
  questionContentFingerprint({ ...question, content: [{ id: "different", type: "image", assetId: "asset-2" }] }),
);
assert.notEqual(
  questionContentFingerprint({
    ...question,
    content: [{ id: "text", type: "text", text: "same" }, { id: "image", type: "image", assetId: "asset-1" }],
  }),
  questionContentFingerprint({
    ...question,
    content: [{ id: "image", type: "image", assetId: "asset-1" }, { id: "text", type: "text", text: "same" }],
  }),
  "image position remains semantic",
);

const textBlocks: ContentBlock[] = [
  { id: "a", type: "text", text: "甲😀乙" },
  { id: "b", type: "text", text: "尾" },
];
const image: ContentBlock = { id: "img-1", type: "image", assetId: "asset-1" };
const middle = insertImageAtSelection(textBlocks, "a", { start: 3, end: 3 }, image);
assert.deepEqual(middle.map((block) => block.type === "text" ? block.text : block.assetId), ["甲😀", "asset-1", "乙", "尾"]);
const replacedSelection = insertImageAtSelection(textBlocks, "a", { start: 1, end: 3 }, { ...image, id: "img-2" });
assert.deepEqual(replacedSelection.map((block) => block.type === "text" ? block.text : block.assetId), ["甲", "asset-1", "乙", "尾"]);
const atStart = insertImageAtSelection(textBlocks, "a", { start: 0 }, { ...image, id: "img-3" });
assert.deepEqual(atStart.map((block) => block.type === "text" ? block.text : block.assetId), ["", "asset-1", "甲😀乙", "尾"]);
const consecutive = insertImageAtSelection(atStart, "a", { start: 0 }, { ...image, id: "img-4" });
assert.deepEqual(consecutive.map((block) => block.type === "text" ? block.text : block.assetId), ["", "asset-1", "", "asset-1", "甲😀乙", "尾"]);
const atEnd = insertImageAtSelection(textBlocks, "a", { start: 4 }, { ...image, id: "img-5" });
assert.deepEqual(atEnd.map((block) => block.type === "text" ? block.text : block.assetId), ["甲😀乙", "asset-1", "", "尾"]);
assert.deepEqual(moveContentBlock(textBlocks, "b", 0).map((block) => block.id), ["b", "a"]);
assert.deepEqual(replaceContentBlock(textBlocks, "b", { id: "c", type: "text", text: "替换" }).map((block) => block.id), ["a", "c"]);
assert.deepEqual(deleteContentBlock(textBlocks, "a").map((block) => block.id), ["b"]);

console.log("v6 domain tests passed: scopes, rounds, content blocks, fingerprints and pure editor operations");
