import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBank, createPracticeRun, createQuestion, studyDb, putImageAsset, resetDatabase } from "../../src/lib/db/db";
import { isSyncCheckpoint, validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";
import { createSyncCheckpoint, encodeSyncCheckpoint, parseSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-store";
import { SYNC_CHECKPOINT_FORMAT, type SyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-types";

await resetDatabase();
await putImageAsset({ id: "a".repeat(64), mimeType: "image/webp", size: 123, width: 10, height: 10 });

// 回归：当前正式 QuestionType 已包含“填空/简答”。远端恢复的 checkpoint
// validator 必须接受与本地数据模型相同的完整题型集合，不能保留旧四题型硬编码。
const typeBank = await createBank("恢复题型回归");
await createQuestion(typeBank.id, {
  type: "填空",
  content: [{ id: "fill-stem", type: "text", text: "填空恢复题" }],
  options: [],
  solution: { kind: "fill", blanks: [{ id: "blank-1", acceptedAnswers: ["填空答案"] }] },
  tags: ["恢复"],
});
await createQuestion(typeBank.id, {
  type: "简答",
  content: [{ id: "short-stem", type: "text", text: "简答恢复题" }],
  options: [],
  solution: { kind: "short", referenceText: "简答参考答案" },
  tags: ["恢复"],
});

// 1) 新建检查点必须使用当前检查点格式且可 round-trip，包括新增正式题型
{
  const checkpoint = await createSyncCheckpoint();
  assert.equal(checkpoint.formatVersion, SYNC_CHECKPOINT_FORMAT);
  assert.deepEqual(checkpoint.state.questions.map((question) => question.type).sort(), ["填空", "简答"].sort());
  const bytes = encodeSyncCheckpoint(checkpoint);
  const parsed = parseSyncCheckpoint(bytes);
  assert.equal(parsed.formatVersion, SYNC_CHECKPOINT_FORMAT);
  assert.deepEqual(parsed.state.imageAssets[0], checkpoint.state.imageAssets[0]);
  assert.deepEqual(parsed.state.questions.map((question) => question.type).sort(), ["填空", "简答"].sort());
  assert.ok(isSyncCheckpoint(parsed));
}

// 2) 退役的上一版检查点格式必须被拒绝，公开恢复只接受当前格式
{
  const current = await createSyncCheckpoint();
  const unsupported = structuredClone(current) as SyncCheckpoint & { formatVersion: number };
  unsupported.formatVersion = SYNC_CHECKPOINT_FORMAT - 1;
  assert.throws(() => validateSyncCheckpoint(unsupported), /formatVersion/, "previous checkpoint format must be rejected by the current-only validator");
  const bytes = new TextEncoder().encode(JSON.stringify(unsupported));
  assert.throws(() => parseSyncCheckpoint(bytes), /formatVersion/, "parser must reject retired checkpoint bytes");
}

// 3) 旧单图 remote 元数据已完全退役；当前 checkpoint 出现该字段直接拒绝
{
  const current = await createSyncCheckpoint();
  const asset = current.state.imageAssets[0] as typeof current.state.imageAssets[number] & { remote?: unknown };
  asset.remote = { path: `sync/v9/assets/${"a".repeat(64)}.webp`, blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 123 };
  assert.throws(() => validateSyncCheckpoint(current), /retired remote metadata/, "current checkpoint must reject retired per-image remote metadata");
}

// 4) 非法格式与坏 imageAsset 被拒绝
{
  const current = await createSyncCheckpoint();
  const badFormat = structuredClone(current) as SyncCheckpoint & { formatVersion: number };
  badFormat.formatVersion = SYNC_CHECKPOINT_FORMAT - 2;
  assert.throws(() => validateSyncCheckpoint(badFormat), /formatVersion/);

  const badCounts = structuredClone(current);
  badCounts.counts.banks += 1;
  assert.throws(() => validateSyncCheckpoint(badCounts), /counts/);
}

// 5) choice solution 必须引用当前题目的真实 option id
{
  const current = await createSyncCheckpoint();
  const invalid = structuredClone(current);
  const question = invalid.state.questions[0]!;
  question.type = "单选";
  question.options = [[{ id: "choice-a", type: "text", text: "甲" }], [{ id: "choice-b", type: "text", text: "乙" }]];
  question.optionIds = ["opt-a", "opt-b"];
  question.solution = { kind: "choice", correctOptionIds: ["missing"] };
  assert.throws(() => validateSyncCheckpoint(invalid), /missing option id/, "checkpoint must reject missing choice option ids");
}

// 6) 检查点不接受 blob 字段
{
  const current = await createSyncCheckpoint();
  const withBlob = structuredClone(current) as SyncCheckpoint & { state: { imageAssets: Array<Record<string, unknown>> } };
  (withBlob.state.imageAssets[0] as Record<string, unknown>).blob = new Blob(["x"], { type: "image/webp" });
  assert.throws(() => validateSyncCheckpoint(withBlob), /must not contain a Blob/);
}

// 7) run 内部映射只能引用 run.questionIds，禁止同步脏快照携带幽灵答案/题型/选项顺序。
{
  const runBank = await createBank("run结构校验");
  const runQuestion = await createQuestion(runBank.id, {
    type: "单选",
    stem: "run结构题",
    options: ["甲", "乙"],
    optionIds: ["opt-a", "opt-b"],
    solution: { kind: "choice", correctOptionIds: ["opt-a"] },
  });
  const run = await createPracticeRun({ bankId: runBank.id, questionIds: [runQuestion.id] });
  const current = await createSyncCheckpoint();
  const target = current.state.practiceRuns.find((item) => item.id === run.id)!;
  const answerInvalid = structuredClone(current);
  answerInvalid.state.practiceRuns.find((item) => item.id === run.id)!.answers.question_missing = {
    selected: ["A"], submitted: true, correct: true,
  };
  assert.throws(() => validateSyncCheckpoint(answerInvalid), /answers.*questionIds/, "checkpoint must reject answer keys outside run.questionIds");

  const typeInvalid = structuredClone(current);
  typeInvalid.state.practiceRuns.find((item) => item.id === run.id)!.questionTypes.question_missing = "单选";
  assert.throws(() => validateSyncCheckpoint(typeInvalid), /questionTypes.*questionIds/, "checkpoint must reject questionTypes keys outside run.questionIds");

  const orderInvalid = structuredClone(current);
  orderInvalid.state.practiceRuns.find((item) => item.id === run.id)!.optionOrders.question_missing = [0, 1];
  assert.throws(() => validateSyncCheckpoint(orderInvalid), /optionOrders.*questionIds/, "checkpoint must reject optionOrders keys outside run.questionIds");
  assert.deepEqual(target.questionIds, [runQuestion.id]);
}

studyDb.close();
console.log("sync checkpoint extra tests passed");
