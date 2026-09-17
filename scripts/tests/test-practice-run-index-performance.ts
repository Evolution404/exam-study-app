import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import "fake-indexeddb/auto";
import { dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { latestInProgressPracticeRunV7, listPracticeRunsForBankV7, listPracticeRunsForQuestionIdsV7, readPracticeHistoryV7 } from "../../src/lib/db/practice-run-read-v7";
import { decomposePracticeRunV7 } from "../../src/lib/db/practice-run-store-v7";
import type { PracticeRunRecordV7, PracticeRunV7 } from "../../src/lib/db/v7-types";

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
  completedAt: at,
  status: "completed",
  revision: 1,
});

async function seedRuns(runs: readonly PracticeRunV7[]): Promise<void> {
  const bundles = runs.map((item) => decomposePracticeRunV7(item, []));
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunSources, dbV7.practiceRunItems], async () => {
    await dbV7.practiceRuns.bulkPut(bundles.map((bundle) => bundle.record));
    await dbV7.practiceRunSources.bulkPut(bundles.flatMap((bundle) => bundle.sources));
    await dbV7.practiceRunItems.bulkPut(bundles.flatMap((bundle) => bundle.items));
  });
}

const unrelated = Array.from({ length: 10_000 }, (_, index) => run(`unrelated-${index}`, [`bank-${index % 100}`], [`q-${index}`]));
const targets = [
  run("target-bank", ["bank-target"], ["q-target-a"]),
  run("target-shared", ["bank-other", "bank-target"], ["q-target-b", "q-shared"]),
];
await seedRuns([...unrelated, ...targets]);

let rowsRead = 0;
const readHook = (row: PracticeRunRecordV7) => { rowsRead += 1; return row; };
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
  completedAt: undefined,
  startedAt: new Date(Date.parse(at) + index * 1_000).toISOString(),
  updatedAt: new Date(Date.parse(at) + index * 1_000).toISOString(),
}));
await seedRuns(activeRuns);
rowsRead = 0;
dbV7.practiceRuns.hook("reading", readHook);
const latest = await latestInProgressPracticeRunV7();
dbV7.practiceRuns.hook("reading").unsubscribe(readHook);
assert.equal(latest?.id, "active-1999", "compound status/update index must return the newest active run");
assert.equal(rowsRead, 1, "latest active run lookup must materialize one row instead of sorting every active run");

// History paging must use the canonical activityAt index on run metadata,
// without a second activity table or full-history materialization.
const allRuns = [...unrelated, ...targets, ...activeRuns];
rowsRead = 0;
dbV7.practiceRuns.hook("reading", readHook);
const history = await readPracticeHistoryV7("all", 50);
dbV7.practiceRuns.hook("reading").unsubscribe(readHook);
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
  resolve(dbSourceRoot, "practice-run-store-v7.ts"),
  resolve(dbSourceRoot, "db-v7-restore.ts"),
]);
const directRunWriters = readdirSync(dbSourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => resolve(entry.parentPath, entry.name))
  .filter((file) => !allowedRunWriters.has(file))
  .filter((file) => /practiceRuns\.(?:put|bulkPut|delete|bulkDelete)\(/.test(readFileSync(file, "utf8")));
assert.deepEqual(directRunWriters, [], `practice run domain writes must go through the normalized store helper: ${directRunWriters.join(", ")}`);

await dbV7.close();
console.log("practice run index performance tests passed: bank/question/latest-active/history lookups avoid full history scans");
