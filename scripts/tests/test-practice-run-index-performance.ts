import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import "fake-indexeddb/auto";
import { studyDb, resetDatabase } from "../../src/lib/db/db";
import { latestInProgressPracticeRun, listPracticeRunsForBank, listPracticeRunsForQuestionIds, readPracticeHistory } from "../../src/lib/db/practice-run-read";
import { decomposePracticeRun } from "../../src/lib/db/practice-run-store";
import type { PracticeRunRecord, PracticeRun } from "../../src/lib/db/types";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

await resetDatabase();
const at = "2026-09-16T00:00:00.000Z";
const run = (id: string, bankIds: string[], questionIds: string[]): PracticeRun => ({
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
  completedAt: at,
  status: "completed",
  revision: 1,
});

async function seedRuns(runs: readonly PracticeRun[]): Promise<void> {
  const bundles = runs.map((item) => decomposePracticeRun(item, []));
  await studyDb.transaction("rw", [studyDb.practiceRuns, studyDb.practiceRunSources, studyDb.practiceRunItems], async () => {
    await studyDb.practiceRuns.bulkPut(bundles.map((bundle) => bundle.record));
    await studyDb.practiceRunSources.bulkPut(bundles.flatMap((bundle) => bundle.sources));
    await studyDb.practiceRunItems.bulkPut(bundles.flatMap((bundle) => bundle.items));
  });
}

const unrelated = Array.from({ length: 10_000 }, (_, index) => run(`unrelated-${index}`, [`bank-${index % 100}`], [`q-${index}`]));
const targets = [
  run("target-bank", ["bank-target"], ["q-target-a"]),
  run("target-shared", ["bank-other", "bank-target"], ["q-target-b", "q-shared"]),
];
await seedRuns([...unrelated, ...targets]);

let rowsRead = 0;
const readHook = (row: PracticeRunRecord) => { rowsRead += 1; return row; };
studyDb.practiceRuns.hook("reading", readHook);
const bankRuns = await listPracticeRunsForBank("bank-target");
const questionRuns = await listPracticeRunsForQuestionIds(["q-target-a", "q-shared", "q-shared"]);
studyDb.practiceRuns.hook("reading").unsubscribe(readHook);

assert.deepEqual(bankRuns.map((item) => item.id).sort(), ["target-bank", "target-shared"]);
assert.deepEqual(questionRuns.map((item) => item.id).sort(), ["target-bank", "target-shared"]);
assert.equal(rowsRead, 4, "indexed run readers must materialize only matching rows, not 10,000 unrelated runs");

const activeRuns = Array.from({ length: 2_000 }, (_, index) => ({
  ...run(`active-${index}`, ["bank-active"], [`active-q-${index}`]),
  status: "in_progress" as const,
  completedAt: undefined,
  startedAt: new Date(Date.parse(at) + index * 1_000).toISOString(),
  updatedAt: new Date(Date.parse(at) + index * 1_000).toISOString(),
}));
await seedRuns(activeRuns);
rowsRead = 0;
studyDb.practiceRuns.hook("reading", readHook);
const latest = await latestInProgressPracticeRun();
studyDb.practiceRuns.hook("reading").unsubscribe(readHook);
assert.equal(latest?.id, "active-1999", "compound status/update index must return the newest active run");
assert.equal(rowsRead, 1, "latest active run lookup must materialize one row instead of sorting every active run");

// History paging must use the canonical activityAt index on run metadata,
// without a second activity table or full-history materialization.
const allRuns = [...unrelated, ...targets, ...activeRuns];
rowsRead = 0;
studyDb.practiceRuns.hook("reading", readHook);
const history = await readPracticeHistory("all", 50);
studyDb.practiceRuns.hook("reading").unsubscribe(readHook);
assert.equal(history.runs.length, 50);
assert.equal(history.total, allRuns.length);
assert.equal(history.counts.completed, unrelated.length + targets.length);
assert.equal(history.counts.in_progress, activeRuns.length);
assert.equal(rowsRead, 50, "history first page must materialize only its 50 run rows, not the complete history");

// Engineering guard: domain code must not mutate practiceRuns metadata outside
// the normalized store helper. Full checkpoint restore is the only bulk-install
// exception because it writes already-decomposed canonical records.
const dbSourceRoot = resolve(process.cwd(), "src/lib/db");
const allowedRunWriters = new Set([
  resolve(dbSourceRoot, "practice-run-store.ts"),
  resolve(dbSourceRoot, "db-restore.ts"),
]);
const directRunWriters = readdirSync(dbSourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => resolve(entry.parentPath, entry.name))
  .filter((file) => !allowedRunWriters.has(file))
  .filter((file) => /practiceRuns\.(?:put|bulkPut|delete|bulkDelete)\(/.test(readFileSync(file, "utf8")));
assert.deepEqual(directRunWriters, [], `practice run domain writes must go through the normalized store helper: ${directRunWriters.join(", ")}`);

await studyDb.close();
console.log("practice run index performance tests passed: bank/question/latest-active/history lookups avoid full history scans");
