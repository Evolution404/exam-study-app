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
  PROJECTION_MODEL_REVISION,
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

assert.equal(
  (await studyDb.syncMeta.get("projection:model-revision"))?.value,
  PROJECTION_MODEL_REVISION,
  "projection rebuild 必须在同一模型收口时写入当前 revision",
);

await ensureLocalProjectionsReady();
assert.equal((await studyDb.questionProgress.get(question.id))?.total, 2, "当前 revision 且无 pending 标记时恢复检查必须幂等");

// Algorithm/model revision mismatch must force a deterministic rebuild even
// when projection rows are non-empty and no crash marker exists.
await studyDb.transaction("rw", [studyDb.questionProgress, studyDb.syncMeta], async () => {
  const stale = await studyDb.questionProgress.get(question.id);
  if (!stale) throw new Error("expected stale projection fixture");
  await studyDb.questionProgress.put({ ...stale, total: 999 });
  await studyDb.syncMeta.put({ key: "projection:model-revision", value: PROJECTION_MODEL_REVISION - 1, updatedAt: new Date().toISOString() });
});
await ensureLocalProjectionsReady();
assert.equal((await studyDb.questionProgress.get(question.id))?.total, 2, "旧 projection model revision 必须触发 full rebuild");
assert.equal((await studyDb.syncMeta.get("projection:model-revision"))?.value, PROJECTION_MODEL_REVISION);

studyDb.close();
console.log("projection crash recovery passed: stale non-empty projections are rebuilt after pending canonical commit");
