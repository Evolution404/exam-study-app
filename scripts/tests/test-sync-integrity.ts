import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  createReviewRoundV7,
  deleteQuestionV7,
  putImageAssetDescriptorV7,
  recordPracticeAnswerV7,
  resetV7Database,
  saveNoteV7,
  saveQuestionGroupV7,
} from "../../src/lib/db/db-v7";
import { createSyncCheckpointV7, encodeSyncCheckpointV7, parseSyncCheckpointV7 } from "../../src/lib/sync/sync-v7-checkpoint-store";

// G6 — checkpoint round-trip fidelity. A checkpoint must survive encode → parse
// without dropping any entity field. We seed a representative slice of every
// table, build the checkpoint, serialize it to JSON bytes, parse it back, and
// deep-equal each table. The one documented exception — imageAssets never carry
// their binary `blob` into a checkpoint — is asserted explicitly.

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-v7-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-v7-device-id") currentDeviceId = value;
    },
  },
});

function singleChoice(stem: string, answer: string): Parameters<typeof createQuestionV7>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: ["对", "错"].map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: [answer === "A" ? "opt-0" : "opt-1"] },
    tags: ["完整性"],
  };
}

try {
  await resetV7Database();
  currentDeviceId = "device-a";

  // Seed a representative slice of every table.
  const bank = await createBankV7("往返题库");
  const q1 = await createQuestionV7(bank.id, singleChoice("往返题一", "A"));
  const q2 = await createQuestionV7(bank.id, singleChoice("往返题二", "A"));
  await saveNoteV7(q1.id, "往返解析笔记");
  const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q1.id] });
  await recordPracticeAnswerV7({ runId: run.id, questionId: q1.id, selected: "A", correct: true, elapsedMs: 10 });
  await saveQuestionGroupV7({ name: "往返题组", type: "自定义", description: "组说明", items: [{ questionId: q1.id, note: "组内提示" }] });
  await createReviewRoundV7({ name: "往返复习轮", bankIds: [bank.id] });
  await putImageAssetDescriptorV7({ id: "a".repeat(64), mimeType: "image/webp", size: 123, width: 10, height: 10 });
  // H5：创建事件仍在 pending 未推送时，删题会抵消该事件（零墓碑零删除事件）。
  // 本场景要验证「已推送」的删除路径 → 先把创建 change-set 标记为 committed。
  const { dbV7 } = await import("../../src/lib/db/db-v7");
  const publishedRecords = (await dbV7.changeSets.where("state").equals("pending").toArray())
    .filter((record) => record.mutations.some((mutation) => (mutation.kind === "question.upsert" && mutation.question.id === q2.id) || (mutation.kind === "membership.save" && mutation.membership.questionId === q2.id)));
  await dbV7.changeSets.bulkPut(publishedRecords.map((record) => ({ ...record, state: "committed" as const, committedAt: new Date().toISOString() })));
  await deleteQuestionV7(q2.id);

  // Build the checkpoint from the DB, then round-trip it through JSON bytes.
  const checkpoint = await createSyncCheckpointV7();
  const roundTripped = parseSyncCheckpointV7(encodeSyncCheckpointV7(checkpoint));

  // Every table must survive the round trip unchanged. JSON serialization drops
  // `undefined` fields, so canonicalize the source through the same JSON pass
  // before comparing (that loss is itself the point of the round-trip test).
  const state = JSON.parse(JSON.stringify(checkpoint.state)) as typeof checkpoint.state;
  const back = roundTripped.state;
  assert.deepEqual(back.banks, state.banks, "banks 往返应一致");
  assert.deepEqual(back.bankFolders, state.bankFolders, "bankFolders 往返应一致");
  assert.deepEqual(back.questions, state.questions, "questions 往返应一致");
  assert.deepEqual(back.memberships, state.memberships, "memberships 往返应一致");
  assert.deepEqual(back.imageAssets, state.imageAssets, "imageAssets 往返应一致");
  assert.deepEqual(back.attempts, state.attempts, "attempts 往返应一致");
  assert.deepEqual(back.attemptStats, state.attemptStats, "attemptStats 往返应一致");
  assert.deepEqual(back.attemptDailyStats, state.attemptDailyStats, "attemptDailyStats 往返应一致");
  assert.deepEqual(back.notes, state.notes, "notes 往返应一致");
  assert.deepEqual(back.practiceRuns, state.practiceRuns, "practiceRuns 往返应一致");
  assert.deepEqual(back.practiceRunStats, state.practiceRunStats, "practiceRunStats 往返应一致");
  assert.deepEqual(back.questionGroups, state.questionGroups, "questionGroups 往返应一致");
  assert.deepEqual(back.reviewRounds, state.reviewRounds, "reviewRounds 往返应一致");
  assert.deepEqual(back.reviewRoundProgress, state.reviewRoundProgress, "reviewRoundProgress 往返应一致");
  assert.deepEqual(back.tombstones, state.tombstones, "tombstones 往返应一致");
  assert.deepEqual(roundTripped.counts, checkpoint.counts, "counts 往返应一致");
  assert.deepEqual(roundTripped.cursors, checkpoint.cursors, "cursors 往返应一致");

  // Characterized exception: imageAssets never carry a binary `blob` into a
  // checkpoint — the descriptor (id/mimeType/size/width/height/remote) survives.
  assert.ok(roundTripped.state.imageAssets.length >= 1, "应至少有一个 imageAsset 描述符");
  for (const asset of roundTripped.state.imageAssets) {
    assert.equal("blob" in asset, false, "checkpoint imageAssets 不应含二进制 blob 字段");
    assert.ok(asset.id && asset.mimeType && asset.size > 0, "imageAsset 描述符字段应保真");
  }

  // Deleting a question must leave a tombstone that survives the round trip.
  assert.ok(roundTripped.state.tombstones.length >= 1, "删题应产生墓碑并在往返后保留");

  console.log("G6 passed: 检查点 encode→parse 往返保真（15 表 deep-equal + imageAssets 描述符子集 + 墓碑保留）");
} catch (error) {
  console.error("sync integrity tests FAILED:", error);
  process.exit(1);
}
