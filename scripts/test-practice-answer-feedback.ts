import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const studyApp = read("app/study-app.tsx");
const styles = read("app/styles/components.css");

assert.match(studyApp, /className="option-status option-status-right"/, "correct status needs a dedicated overlay");
assert.match(studyApp, /className="option-status option-status-wrong"/, "wrong status needs a dedicated overlay");
assert.match(styles, /\.options button \{ position:relative;/, "option cards must anchor their status overlay");
assert.match(styles, /\.option-status \{ position:absolute;/, "answer icons must not participate in option text layout");
assert.match(styles, /padding:10px 50px 10px 15px/, "every option must reserve the same stable status gutter before and after submission");
assert.match(studyApp, /correct \? <p>正确答案：\{displayAnswer\}<\/p> : preferences\.showAnswerOnWrong/, "correct feedback must show only answer letters");
assert.doesNotMatch(studyApp, /\(correct \|\| preferences\.showAnswerOnWrong\) \? <p>正确答案/, "correct feedback must not reuse the verbose wrong-answer explanation");

console.log("practice answer feedback tests passed: stable option layout, overlay icons and concise correct result");
