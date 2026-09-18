import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBank,
  createPracticeRun,
  createQuestion,
  recordPracticeAnswer,
  resetDatabase,
  studyDb,
} from "../../src/lib/db/db";
import {
  ensureLocalProjectionsReady,
  markProjectionRebuildPendingInTx,
} from "../../src/lib/db/projection-engine";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => "projection-crash-recovery-device",
    setItem: () => undefined,
  },
});

await resetDatabase();
const bank = await createBank("projection crash recovery");
const question = await createQuestion(bank.id, {
  type: "单选",
  stem: "恢复题",
  options: ["A", "B"],
  optionIds: ["a", "b"],
  solution: { kind: "choice", correctOptionIds: ["a"] },
});
const run = await createPracticeRun({ bankId: bank.id, questionIds: [question.id] });
await recordPracticeAnswer({
  runId: run.id,
  questionId: question.id,
  selected: ["A"],
  correct: true,
  elapsedMs: 10,
});

assert.equal((await studyDb.questionProgress.get(question.id))?.total, 1);

const secondAttempt = {
  id: "crash-recovery-attempt-2",
  runId: run.id,
  questionId: question.id,
  selected: "B",
  correct: false,
  elapsedMs: 20,
  createdAt: "2026-09-18T00:00:02.000Z",
  deviceId: "projection-crash-recovery-device",
};

await studyDb.transaction("rw", [studyDb.attempts, studyDb.syncMeta], async () => {
  await studyDb.attempts.put(secondAttempt);
  await markProjectionRebuildPendingInTx();
});

assert.equal(
  (await studyDb.questionProgress.get(question.id))?.total,
  1,
  "模拟 crash 窗口时 canonical 已更新而 projection 仍旧",
);

await ensureLocalProjectionsReady();

const rebuilt = await studyDb.questionProgress.get(question.id);
assert.equal(rebuilt?.total, 2, "启动恢复必须从 canonical facts 重建非空但过期的 projection");
assert.equal(rebuilt?.wrong, 1);
assert.equal(
  await studyDb.syncMeta.get("projection:rebuild-pending"),
  undefined,
  "projection 成功重建后必须清掉 pending 标记",
);

await ensureLocalProjectionsReady();
assert.equal((await studyDb.questionProgress.get(question.id))?.total, 2, "无 pending 标记时恢复检查必须幂等");

studyDb.close();
console.log("projection crash recovery passed: stale non-empty projections are rebuilt after pending canonical commit");
