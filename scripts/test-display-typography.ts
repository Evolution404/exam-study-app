import assert from "node:assert/strict";
import { formatQuestionDisplayText, hasChineseText } from "../lib/display-typography";

assert.equal(hasChineseText("Which option is correct?"), false);
assert.equal(hasChineseText("下列说法正确的是?"), true);
assert.equal(
  formatQuestionDisplayText("电压为220V, 电流为3.5A. 正确吗?"),
  "电压为220V，电流为3.5A。正确吗？",
);
assert.equal(
  formatQuestionDisplayText('请选择: (A) "正确"; (B) "错误"!'),
  '请选择：(A) “正确”；(B) “错误”！',
);
assert.equal(
  formatQuestionDisplayText("已知 $f(x)=1,000.5$, 求 f(2)."),
  "已知 $f(x)=1,000.5$，求 f(2)。",
  "LaTeX and function notation must remain unchanged",
);
assert.equal(
  formatQuestionDisplayText("A. 3.5V, B. 4.0V", "请选择正确的电压"),
  "A. 3.5V，B. 4.0V",
  "options inherit the question language without changing labels or decimals",
);
assert.equal(
  formatQuestionDisplayText("Which option is correct? (A) Yes, (B) No."),
  "Which option is correct? (A) Yes, (B) No.",
  "English questions must remain unchanged",
);

console.log("display typography tests passed: Chinese punctuation, technical text, LaTeX and English preservation");
