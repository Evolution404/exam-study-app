import assert from "node:assert/strict";
import fs from "node:fs";
import { derivePracticeAnswerState, isPracticeAnswerCorrect } from "../../src/lib/practice/practice-answer-state";
import type { QuestionV7 } from "../../src/lib/db/v7-types";

const base = (overrides: Partial<QuestionV7>): QuestionV7 => ({
  id: "q",
  type: "单选",
  content: [{ id: "stem", type: "text", text: "题目" }],
  options: [
    [{ id: "a", type: "text", text: "甲" }],
    [{ id: "b", type: "text", text: "乙" }],
  ],
  optionIds: ["opt-a", "opt-b"],
  solution: { kind: "choice", correctOptionIds: ["opt-b"] },
  tags: [],
  contentFingerprint: "fp",
  updatedAt: "2026-08-27T00:00:00.000Z",
  deviceId: "answer-state-test",
  ...overrides,
});

const choice = base({});
assert.equal(isPracticeAnswerCorrect(choice, ["B"], 1), true);
assert.equal(isPracticeAnswerCorrect(choice, ["A"], 1), false);
assert.equal(isPracticeAnswerCorrect(base({ type: "多选", solution: { kind: "choice", correctOptionIds: ["opt-a", "opt-b"] } }), ["A", "B"], 1), true);
assert.equal(isPracticeAnswerCorrect(base({ type: "多选", solution: { kind: "choice", correctOptionIds: ["opt-a", "opt-b"] } }), ["A"], 1), false);

const calculation = base({ type: "计算", options: [], optionIds: [], solution: { kind: "calculation", blanks: [{ id: "n", expected: 10 }] } });
assert.equal(isPracticeAnswerCorrect(calculation, ["10"], 1), true);
assert.equal(isPracticeAnswerCorrect(calculation, ["12"], 1), false);
const fill = base({ type: "填空", options: [], optionIds: [], solution: { kind: "fill", blanks: [{ id: "f", acceptedAnswers: ["南京"] }] } });
assert.equal(isPracticeAnswerCorrect(fill, ["南京"], 1), true);
assert.equal(isPracticeAnswerCorrect(fill, ["苏州"], 1), false);
const short = base({ type: "简答", options: [], optionIds: [], solution: { kind: "short", referenceText: "参考" } });
assert.equal(isPracticeAnswerCorrect(short, ["回答"], 1, "correct"), true);
assert.equal(isPracticeAnswerCorrect(short, ["回答"], 1, "incorrect"), false);

const derived = derivePracticeAnswerState({
  question: choice,
  stem: "题目",
  selected: ["B"],
  calculationDrafts: [],
  fillDrafts: [],
  submitted: true,
  displayOrder: [1, 0],
  calculationTolerancePercent: 1,
  showAnswerOnWrong: false,
});
assert.equal(derived.correct, true);
assert.equal(derived.selectedAnswer, "A", "选择字母必须按当前 displayOrder 映射到展示字母");
assert.equal(derived.revealAnswer, true);
assert.equal(derived.gaveUp, false);
assert.deepEqual(derived.optionIds, ["opt-a", "opt-b"]);
assert.deepEqual([...derived.correctOptionIds], ["opt-b"]);

const wrongHidden = derivePracticeAnswerState({
  question: choice,
  stem: "题目",
  selected: ["A"],
  calculationDrafts: [],
  fillDrafts: [],
  submitted: true,
  displayOrder: [0, 1],
  calculationTolerancePercent: 1,
  showAnswerOnWrong: false,
});
assert.equal(wrongHidden.correct, false);
assert.equal(wrongHidden.revealAnswer, false);

const calculationDerived = derivePracticeAnswerState({
  question: calculation,
  stem: "结果（ ）",
  selected: [],
  calculationDrafts: ["10"],
  fillDrafts: [],
  submitted: false,
  displayOrder: [],
  calculationTolerancePercent: 1,
  showAnswerOnWrong: true,
});
assert.equal(calculationDerived.calculationInputValid, true);
assert.equal(calculationDerived.selectedAnswer, "");
assert.equal(calculationDerived.correct, false, "未提交时即使 draft 正确也不能展示为答对");

const practiceSource = fs.readFileSync(new URL("../../src/app/shell/views/practice.tsx", import.meta.url), "utf8");
assert.match(practiceSource, /derivePracticeAnswerState\(\{/, "Practice presentation derivation 必须使用 single pure answer-state model");
assert.match(practiceSource, /isPracticeAnswerCorrect\(question\.canonical, finalSelection/, "submit correctness 必须复用同一 pure correctness owner");
assert.doesNotMatch(practiceSource, /areCalculationAnswersCorrect|fillAnswersAreCorrect|selectedOptionIds/, "Practice React owner 不得再维护第二套判题规则");

console.log("practice answer-state tests passed: choice/calculation/fill/short correctness and presentation derivation");
