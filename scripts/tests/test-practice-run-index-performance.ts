import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { latestInProgressPracticeRunV7, listPracticeRunsForBankV7, listPracticeRunsForQuestionIdsV7 } from "../../src/lib/db/practice-run-read-v7";
import type { PracticeRunV7 } from "../../src/lib/db/v7-types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetV7Database();
const at = "2026-09-16T00:00:00.000Z";
const run = (id: string, bankIds: string[], questionIds: string[]): PracticeRunV7 => ({
  id,
  bankId: bankIds[0] ?? "",
  bankIds,
  bankName: id,
  mode: "sequential",
  modeLabel: "全量顺序练习",
  questionIds,
  questionTypes: Object.fromEntries(questionIds.map((questionId) => [questionId, "单选"])),
  answers: {},
  shuffleOptions: false,
  optionOrders: {},
  startedAt: at,
  updatedAt: at,
  status: "completed",
  revision: 1,
});

const unrelated = Array.from({ length: 10_000 }, (_, index) => run(`unrelated-${index}`, [`bank-${index % 100}`], [`q-${index}`]));
const targets = [
  run("target-bank", ["bank-target"], ["q-target-a"]),
  run("target-shared", ["bank-other", "bank-target"], ["q-target-b", "q-shared"]),
];
await dbV7.practiceRuns.bulkPut([...unrelated, ...targets]);

let rowsRead = 0;
const readHook = (row: PracticeRunV7) => { rowsRead += 1; return row; };
dbV7.practiceRuns.hook("reading", readHook);
const bankRuns = await listPracticeRunsForBankV7("bank-target");
const questionRuns = await listPracticeRunsForQuestionIdsV7(["q-target-a", "q-shared", "q-shared"]);
dbV7.practiceRuns.hook("reading").unsubscribe(readHook);

assert.deepEqual(bankRuns.map((item) => item.id).sort(), ["target-bank", "target-shared"]);
assert.deepEqual(questionRuns.map((item) => item.id).sort(), ["target-bank", "target-shared"]);
assert.equal(rowsRead, 4, "indexed run readers must materialize only matching rows, not 10,000 unrelated runs");

const activeRuns = Array.from({ length: 2_000 }, (_, index) => ({
  ...run(`active-${index}`, ["bank-active"], [`active-q-${index}`]),
  status: "in_progress" as const,
  updatedAt: new Date(Date.parse(at) + index * 1_000).toISOString(),
}));
await dbV7.practiceRuns.bulkPut(activeRuns);
rowsRead = 0;
dbV7.practiceRuns.hook("reading", readHook);
const latest = await latestInProgressPracticeRunV7();
dbV7.practiceRuns.hook("reading").unsubscribe(readHook);
assert.equal(latest?.id, "active-1999", "compound status/update index must return the newest active run");
assert.equal(rowsRead, 1, "latest active run lookup must materialize one row instead of sorting every active run");

await dbV7.close();
console.log("practice run index performance tests passed: bank/question/latest-active lookups avoid full history scans");
