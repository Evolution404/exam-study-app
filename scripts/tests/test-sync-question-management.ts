import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  dbV7,
  deleteBankV7,
  deleteBankWithExclusiveQuestionsV7,
  deletePracticeRunV7,
  deleteQuestionV7,
  importQuestionBankV7,
  recordPracticeAnswerV7,
  removeMembershipV7,
  resetV7Database,
  saveNoteV7,
  saveQuestionGroupV7,
  toggleQuestionFavoriteV7,
  updateQuestionV7,
} from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// Integration tests for question lifecycle (import / edit / delete / membership
// / dedup) plus a committed-records GC stress test, all against the in-memory
// mock GitHub backend with fresh-device pulls verifying cross-device consistency.

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-device-id") currentDeviceId = value;
    },
  },
});

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "mock-vault", branch: "main", apiBaseUrl: server.url };
const sync = () => syncWithGitHub(settings, "qa-token");

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV7Database();
}

// 双队列 serialize/re-inject：fake-indexeddb 单库无法同时持有两设备活动态，用「快照某设备
// pending → 切设备 → 回注」模拟离线 pending 跨设备竞争（替代 S12 的单记录内联写法）。
type PendingSnapshot = { id: string; deviceId: string; localSequence: number; createdAt: string; mutations: unknown[] } & Record<string, unknown>;
async function snapshotPending(predicate: (record: PendingSnapshot) => boolean): Promise<PendingSnapshot[]> {
  const records = await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).toArray();
  return structuredClone(records.filter(predicate) as PendingSnapshot[]);
}
async function restorePending(records: PendingSnapshot[]): Promise<void> {
  for (const record of records) await dbV7.changeSets.put({ ...record, state: "pending" as const, claimedAt: undefined, claimId: undefined });
}

function singleChoice(stem: string, answer: string, options: string[]): Parameters<typeof createQuestionV7>[1] {
  const optionIds = options.map((_, index) => `opt-${index}`);
  const correctOptionIds = answer.split("").map((letter) => optionIds[letter.charCodeAt(0) - 65]).filter((id): id is string => Boolean(id));
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: options.map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    optionIds,
    solution: { kind: "choice", correctOptionIds },
    tags: ["试题管理"],
  };
}

try {
  // --- Scenario 1: atomic import round-trips --------------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const rows = Array.from({ length: 200 }, (_, index) => ({ stem: `导入第 ${index + 1} 题：考点 ${index}，下列哪项正确？`, type: "单选", options: ["甲", "乙", "丙", "丁"], answer: "A" }));
    const bank = await importQuestionBankV7("试题导入.json", rows);
    assert.equal(await dbV7.questions.count(), 200, "本地应导入 200 题");
    const fingerprints = new Set((await dbV7.questions.toArray()).map((question) => question.contentFingerprint));
    await sync();
    assert.ok(server.contentPaths().some((path) => path.startsWith("sync/v9/objects/")), "大导入应卸载为不可变对象");

    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.questions.count(), 200, "新设备应拉取到全部 200 题");
    assert.equal(await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).count(), 200, "题库关系应完整");
    const pulledFingerprints = new Set((await dbV7.questions.toArray()).map((question) => question.contentFingerprint));
    assert.deepEqual([...pulledFingerprints].sort(), [...fingerprints].sort(), "内容指纹应逐题一致");
    console.log("scenario 1 passed: 单原子大导入跨设备一致（含卸载）");
  }

  // --- Scenario 2: editing a question propagates ----------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("编辑题库");
    const question = await createQuestionV7(bank.id, singleChoice("原始题干", "A", ["对", "错"]));
    await sync();

    await freshClient("device-b");
    await sync();
    const original = await dbV7.questions.get(question.id);
    assert.equal((original?.content[0] as { text?: string } | undefined)?.text, "原始题干", "新设备应先拉取到原始内容");

    await freshClient("device-a");
    await sync();
    await updateQuestionV7(question.id, { content: [{ id: "stem-0", type: "text", text: "编辑后的题干" }], tags: ["已更新"] });
    await sync();

    await freshClient("device-b");
    await sync();
    const pulled = await dbV7.questions.get(question.id);
    assert.equal((pulled?.content[0] as { text?: string } | undefined)?.text, "编辑后的题干", "编辑后的内容应同步");
    assert.deepEqual(pulled?.tags, ["已更新"], "标签编辑应同步");
    console.log("scenario 2 passed: 题目编辑跨设备传播");
  }

  // --- Scenario 3: deleting a question cascades to its stats ----------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("删除统计题库");
    const question = await createQuestionV7(bank.id, singleChoice("将被删除且已作答", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [question.id] });
    await recordPracticeAnswerV7({ runId: run.id, questionId: question.id, selected: "A", correct: true });
    assert.ok(await dbV7.attemptStats.get(question.id), "作答应产生全局统计");

    await deleteQuestionV7(question.id);
    assert.equal(await dbV7.attempts.count(), 0, "本地级联应清理作答");
    assert.equal(await dbV7.attemptStats.get(question.id), undefined, "本地级联应清理统计");

    await sync();
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.questions.get(question.id), undefined, "新设备不应再看到已删题目");
    assert.equal(await dbV7.attempts.count(), 0, "新设备作答应被清理");
    assert.equal(await dbV7.attemptStats.get(question.id), undefined, "新设备统计应被清理");
    assert.equal(await dbV7.attemptDailyStats.where("questionId").equals(question.id).count(), 0, "每日统计应被清理");
    console.log("scenario 3 passed: 删除题目级联清理作答与统计跨设备一致");
  }

  // --- Scenario 4: deleting an exclusive bank cascades to questions ---------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("独占删库");
    const question = await createQuestionV7(bank.id, singleChoice("独占题", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [question.id] });
    await recordPracticeAnswerV7({ runId: run.id, questionId: question.id, selected: "A", correct: true });

    await deleteBankWithExclusiveQuestionsV7(bank.id);
    await sync();
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.banks.get(bank.id), undefined, "新设备不应看到已删题库");
    assert.equal(await dbV7.questions.get(question.id), undefined, "独占题目应被级联删除");
    assert.equal(await dbV7.practiceRuns.get(run.id), undefined, "绑定该题库的练习应随题库清除");
    console.log("scenario 4 passed: 删除独占题库级联清理题目与练习跨设备一致");
  }

  // --- Scenario 5: removing a membership keeps the global question ----------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    // Importing the same content under two filenames creates two banks sharing
    // one global question (fingerprint dedup), with a membership in each bank.
    const row = [{ stem: "共享题目", type: "单选", options: ["对", "错"], answer: "A" }];
    const bankA = await importQuestionBankV7("共享A.json", row);
    const bankB = await importQuestionBankV7("共享B.json", row);
    const shared = (await dbV7.questions.toArray()).find((question) => (question.content[0] as { text?: string } | undefined)?.text === "共享题目");
    assert.ok(shared, "应存在共享题目");
    assert.equal(await dbV7.bankQuestionMemberships.where("questionId").equals(shared!.id).count(), 2, "共享题应同时归属两个题库");

    await removeMembershipV7(bankA.id, shared!.id);
    await sync();
    await freshClient("device-b");
    await sync();
    assert.ok(await dbV7.questions.get(shared!.id), "移除关系后题目应全局保留");
    assert.equal(await dbV7.bankQuestionMemberships.where("questionId").equals(shared!.id).count(), 1, "仅剩一个题库关系");
    assert.equal((await dbV7.bankQuestionMemberships.where("questionId").equals(shared!.id).toArray())[0]?.bankId, bankB.id, "保留的应是题库 B 的关系");
    console.log("scenario 5 passed: 移除题库关系保留全局题目");
  }

  // --- Scenario 6: re-importing identical content deduplicates --------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const rows = Array.from({ length: 50 }, (_, index) => ({ stem: `去重第 ${index + 1} 题`, type: "单选", options: ["甲", "乙"], answer: "A" }));
    await importQuestionBankV7("第一次.json", rows);
    await importQuestionBankV7("第二次.json", rows); // identical content
    assert.equal(await dbV7.questions.count(), 50, "重复导入不应产生重复题目");
    assert.equal(await dbV7.bankQuestionMemberships.count(), 100, "两个题库应各持有一条关系");

    await sync();
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.questions.count(), 50, "新设备题目数应一致（无重复）");
    console.log("scenario 6 passed: 重复导入按内容指纹去重");
  }

  // --- Scenario 7 (GC stress): >500 committed records prune to ≤500 ---------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("GC 压测题库");
    const question = await createQuestionV7(bank.id, singleChoice("收藏压测题", "A", ["对", "错"]));
    // Each toggle enqueues an independent question.upsert change-set (no dedup),
    // so 600 toggles produce 600 committed records after one sync.
    for (let index = 0; index < 600; index += 1) await toggleQuestionFavoriteV7(question.id);
    await sync();
    const committedCount = await dbV7.changeSets.where("state").equals("committed").count();
    assert.ok(committedCount <= 500, `committed 应被裁剪到 ≤500，实际 ${committedCount}`);
    assert.ok(committedCount > 0, "裁剪后仍应保留最近的已同步记录");
    const originFinalFavorite = (await dbV7.questions.get(question.id))?.favorite;

    // Pruning must not lose data: a fresh device pulls the full segment tail and
    // reconstructs the identical projection (final favorite state).
    await freshClient("device-b");
    await sync();
    const pulled = await dbV7.questions.get(question.id);
    assert.ok(pulled, "GC 后新设备仍能完整拉取题目");
    assert.equal(pulled?.favorite, originFinalFavorite, "两设备的最终收藏状态应一致");
    console.log("scenario 7 passed: 超过 500 条 committed 被裁剪且数据完整可重建");
  }

  // --- Scenario 8: deleting one question in a multi-question run trims it ----
  // The data contract behind "练习中删除题目自动跳过": the run keeps its other
  // questions and the trim survives a sync round-trip to a fresh device.
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("练习中删题");
    const q1 = await createQuestionV7(bank.id, singleChoice("练习题一", "A", ["对", "错"]));
    const q2 = await createQuestionV7(bank.id, singleChoice("练习题二", "A", ["对", "错"]));
    const q3 = await createQuestionV7(bank.id, singleChoice("练习题三", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q1.id, q2.id, q3.id] });
    await recordPracticeAnswerV7({ runId: run.id, questionId: q1.id, selected: "A", correct: true });
    // Establish the questions on the remote first, so the delete below is its
    // own change-set rather than collapsing create+delete into one batch.
    await sync();

    // Delete q2 (not the currently-viewed q1) while the run is in progress.
    await deleteQuestionV7(q2.id);
    const trimmed = await dbV7.practiceRuns.get(run.id);
    assert.ok(trimmed, "练习记录应保留");
    assert.deepEqual(trimmed?.questionIds, [q1.id, q3.id], "仅从练习中剔除被删题，其余题保留");
    assert.equal(trimmed?.answers[q1.id]?.submitted, true, "已作答的进度不受影响");

    await sync();
    await freshClient("device-b");
    await sync();
    const pulled = await dbV7.practiceRuns.get(run.id);
    assert.deepEqual(pulled?.questionIds, [q1.id, q3.id], "新设备看到的练习同样不含被删题");
    assert.equal(await dbV7.questions.get(q2.id), undefined, "新设备不应看到已删题目");
    assert.equal((await dbV7.questions.get(q1.id))?.id, q1.id, "未删题目全局保留");
    console.log("scenario 8 passed: 删除练习中的某题只裁剪该题，其余进度跨设备一致");
  }

  // --- Scenario 9: deleting a question cascades through notes and groups -----
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("关联清理");
    const q = await createQuestionV7(bank.id, singleChoice("带笔记与题组的题", "A", ["对", "错"]));
    await saveNoteV7(q.id, "错因：混淆了弧垂方向");
    const group = await saveQuestionGroupV7({ name: "易错题组", type: "专题", description: "", items: [{ questionId: q.id, note: "" }] });
    assert.equal((await dbV7.notes.get(q.id))?.content, "错因：混淆了弧垂方向");
    assert.ok(await dbV7.questionGroups.get(group.id));

    await deleteQuestionV7(q.id);
    assert.equal(await dbV7.notes.get(q.id), undefined, "个人解析应随题目级联删除");
    assert.equal(await dbV7.questionGroups.get(group.id), undefined, "题组内题目全删后题组应清除");

    await sync();
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.notes.get(q.id), undefined, "新设备解析也应清理");
    assert.equal(await dbV7.questionGroups.count(), 0, "新设备不应残留空题组");
    console.log("scenario 9 passed: 删除题目级联清理解析与题组跨设备一致");
  }

  // --- Scenario 10: a tombstone prevents a deleted question from reviving ----
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("防复活");
    const q = await createQuestionV7(bank.id, singleChoice("将被删除", "A", ["对", "错"]));
    await sync();
    await deleteQuestionV7(q.id);
    await sync();
    assert.ok(await dbV7.tombstones.get(`question:${q.id}`), "删除应写入墓碑");

    // A second device that never saw the question must not resurrect it just
    // because an older change-set predating the delete still references its id.
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.questions.get(q.id), undefined, "墓碑阻止已删题目在同步后复活");
    assert.ok(await dbV7.tombstones.get(`question:${q.id}`), "新设备也应记录墓碑");
    console.log("scenario 10 passed: 墓碑阻止已删题目跨设备复活");
  }

  // --- Scenario 11: editing a question the remote already deleted -----------
  // Device A creates and pushes a question. Device B deletes it and pushes the
  // tombstone. When Device A next syncs it pulls the tombstone, so the question
  // vanishes locally and the edit entry point refuses to operate on it (the data
  // layer guards against editing a tombstoned question). A fresh device must not
  // see the question revive. This covers the common real-world path: a user who
  // still had the question open cannot push an edit that resurrects it.
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("远端已删本地编辑");
    const q = await createQuestionV7(bank.id, singleChoice("将被另一设备删除", "A", ["对", "错"]));
    await sync();
    assert.equal((await dbV7.questions.get(q.id))?.id, q.id, "device-a 应先看到题目");

    // Device B deletes the question and pushes the tombstone.
    await freshClient("device-b");
    await sync();
    await deleteQuestionV7(q.id);
    await sync();

    // Device A pulls the delete on its next sync.
    await freshClient("device-a");
    await sync();
    assert.equal(await dbV7.questions.get(q.id), undefined, "device-a 同步后应感知到删除");
    assert.ok(await dbV7.tombstones.get(`question:${q.id}`), "墓碑应随删除到达 device-a");
    // The data layer must refuse to edit a tombstoned question rather than
    // silently re-creating it and queuing a reviving upsert.
    await assert.rejects(() => updateQuestionV7(q.id, { tags: ["本地改"] }), /不存在或已被删除/, "编辑已删题应被拒绝，不产生复活 upsert");
    assert.equal(await dbV7.changeSets.where("state").equals("pending").count(), 0, "被拒的编辑不应入队待同步");

    // A fresh device confirms the tombstone wins globally.
    await freshClient("device-c");
    await sync();
    assert.equal(await dbV7.questions.get(q.id), undefined, "墓碑优先：远端已删题不应复活");
    console.log("scenario 11 passed: 编辑远端已删题被拒绝，墓碑阻止复活");
  }

  // --- Scenario 12: a pending offline edit hits a tombstone on next sync -----
  // The concurrent case Scenario 11 cannot reach through freshClient resets:
  // Device A creates+syncs, then edits OFFLINE (a pending question.upsert sits in
  // its local queue, never pushed). Device B deletes the question and pushes the
  // tombstone. When Device A finally syncs, its still-pending upsert is rebased
  // against the tombstone and is BLOCKED rather than reviving the question.
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("离线编辑遇墓碑");
    const q = await createQuestionV7(bank.id, singleChoice("离线编辑的题", "A", ["对", "错"]));
    await sync();

    // Capture the queue so we can replay Device A's offline edit after the DB is
    // reset for Device B: serialize the pending upsert, run Device B's delete,
    // then restore the pending record onto Device A's fresh pull.
    await updateQuestionV7(q.id, { content: [{ id: "stem-0", type: "text", text: "离线后的题干" }], tags: ["离线"] });
    const pendingEdit = (await dbV7.changeSets.where("state").equals("pending").toArray()).find((record) => record.mutations.some((mutation) => mutation.kind === "question.upsert"));
    assert.ok(pendingEdit, "离线编辑应产生待同步 upsert");

    await freshClient("device-b");
    await sync();
    await deleteQuestionV7(q.id);
    await sync();

    // Device A resumes: re-pull everything, then re-inject the offline upsert as
    // a fresh pending change-set (same effect as if it had never synced it).
    currentDeviceId = "device-a";
    await resetV7Database();
    await sync();
    await dbV7.changeSets.put({ ...pendingEdit!, state: "pending", claimedAt: undefined, claimId: undefined });
    const result = await sync();
    assert.ok(result.remaining >= 1, "离线编辑遇墓碑应被 blocked");

    const blockedRecords = await dbV7.changeSets.where("state").equals("blocked").toArray();
    assert.ok(blockedRecords.some((record) => record.mutations.some((mutation) => mutation.kind === "question.upsert" && (mutation as { question?: { id?: string } }).question?.id === q.id)), "blocked 记录应正是该离线 upsert");

    await freshClient("device-c");
    await sync();
    assert.equal(await dbV7.questions.get(q.id), undefined, "墓碑优先：离线编辑不应让已删题复活");
    console.log("scenario 12 passed: 离线编辑遇远端墓碑被 blocked，墓碑阻止复活");
  }

  // --- Scenario 13 (E6): 删题把题组裁空 → 远端 replay 写墓碑，阻止陈旧组编辑复活 ---
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("E6题组裁空");
    const q = await createQuestionV7(bank.id, singleChoice("E6组内唯一题", "A", ["对", "错"]));
    const group = await saveQuestionGroupV7({ name: "E6易错组", type: "专题", description: "", items: [{ questionId: q.id, note: "" }] });
    await sync();

    // device-b 拉取，离线编辑该组（产生 pending questionGroup.saved）
    await freshClient("device-b");
    await sync();
    assert.ok(await dbV7.questionGroups.get(group.id), "device-b 应先拉到题组");
    await saveQuestionGroupV7({ id: group.id, name: "E6易错组-离线改", type: "专题", description: "", items: [{ questionId: q.id, note: "离线备注" }] });
    const offlineGroupEdit = await snapshotPending((record) => record.mutations.some((m) => (m as { kind: string; group?: { id?: string } }).kind === "questionGroup.saved" && (m as { group?: { id?: string } }).group?.id === group.id));
    assert.ok(offlineGroupEdit.length, "离线编辑应产生 pending questionGroup.saved");

    // device-a 删题 → 组被裁空（修复前不发墓碑；修复后 question.bulk.delete 回放写 questionGroup 墓碑）
    await freshClient("device-a");
    await sync();
    await deleteQuestionV7(q.id);
    assert.equal(await dbV7.questionGroups.get(group.id), undefined, "裁空后题组应被删除");
    assert.ok(await dbV7.tombstones.get(`questionGroup:${group.id}`), "本地应写 questionGroup 墓碑");
    await sync();

    // device-b 回到自己的视图，拉到删除，再回注离线组编辑，sync
    currentDeviceId = "device-b";
    await resetV7Database();
    await sync();
    await restorePending(offlineGroupEdit);
    const result = await sync();
    assert.ok(result.remaining >= 1, "陈旧的 questionGroup.saved 应被 blocked，而非静默复活组");

    const blockedRecords = await dbV7.changeSets.where("state").equals("blocked").toArray();
    assert.ok(blockedRecords.some((record) => record.mutations.some((m) => (m as { kind: string; group?: { id?: string } }).kind === "questionGroup.saved" && (m as { group?: { id?: string } }).group?.id === group.id)), "blocked 记录应正是该组离线编辑");

    await freshClient("device-c");
    await sync();
    assert.equal(await dbV7.questionGroups.get(group.id), undefined, "墓碑优先：裁空的题组不应被陈旧编辑复活");
    console.log("scenario 13 passed: 删题裁空题组写墓碑，阻止跨设备陈旧组编辑复活（E6）");
  }

  // --- Scenario 14 (S2.1): A 删题，B 的活动 run 含该题 → B 同步后 run 被裁剪、行保留 ---
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("跨设备活动run裁剪");
    const q1 = await createQuestionV7(bank.id, singleChoice("活动run题一", "A", ["对", "错"]));
    const q2 = await createQuestionV7(bank.id, singleChoice("活动run题二", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q1.id, q2.id] });
    await sync();

    // device-b 拉取，B 端正在练习（写一答案模拟 in_progress）
    await freshClient("device-b");
    await sync();
    await recordPracticeAnswerV7({ runId: run.id, questionId: q1.id, selected: "A", correct: true });
    assert.deepEqual((await dbV7.practiceRuns.get(run.id))?.questionIds, [q1.id, q2.id], "B 拉取后 run 完整");

    // device-a 删 q1 并推送
    await freshClient("device-a");
    await sync();
    await deleteQuestionV7(q1.id);
    await sync();

    // device-b 再同步：投影收到 question.bulk.delete，run 被裁剪
    currentDeviceId = "device-b";
    await resetV7Database();
    await sync();
    assert.equal(await dbV7.questions.get(q1.id), undefined, "B 应感知到 q1 删除");
    const bRun = await dbV7.practiceRuns.get(run.id);
    assert.ok(bRun, "B 的 run 行应保留");
    assert.deepEqual(bRun?.questionIds, [q2.id], "B 的 run 应裁掉 q1、保留 q2");
    assert.equal(bRun?.answers[q1.id], undefined, "B 的 run answers 中 q1 应移除");
    console.log("scenario 14 passed: 跨设备删题裁剪对方活动 run（S2.1）");
  }

  // --- Scenario 15 (S3.1): 删独占题库 → 独占题随库删、共享题存活、靶向 run 墓碑化 ---
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bankX = await createBankV7("独占删库X");
    const bankY = await createBankV7("共享存留Y");
    const qExclusive = await createQuestionV7(bankX.id, singleChoice("仅X独占题", "A", ["对", "错"]));
    const qShared = await createQuestionV7(bankX.id, singleChoice("X与Y共享题", "A", ["对", "错"]));
    await createQuestionV7(bankY.id, singleChoice("X与Y共享题", "A", ["对", "错"])); // 显式复用 qShared，建立 Y 关系
    const run = await createPracticeRunV7({ bankId: bankX.id, questionIds: [qExclusive.id, qShared.id] });
    await sync();

    await deleteBankWithExclusiveQuestionsV7(bankX.id);
    await sync();

    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.banks.get(bankX.id), undefined, "X 题库应删除");
    assert.ok(await dbV7.banks.get(bankY.id), "Y 题库应保留");
    assert.equal(await dbV7.questions.get(qExclusive.id), undefined, "X 独占题应随库删除");
    assert.ok(await dbV7.questions.get(qShared.id), "共享题应存活（Y 仍有关系）");
    assert.equal(await dbV7.practiceRuns.get(run.id), undefined, "靶向 X 的 run 应被删除");
    assert.ok(await dbV7.tombstones.get(`bank:${bankX.id}`), "应写 bank 墓碑");
    assert.ok(await dbV7.tombstones.get(`practiceRun:${run.id}`), "应写靶向 run 墓碑");
    assert.ok(await dbV7.tombstones.get(`question:${qExclusive.id}`), "应写独占题墓碑");
    console.log("scenario 15 passed: 删独占题库级联（独占题删/共享题存活/靶向run墓碑）（S3.1）");
  }

  // --- Scenario 16 (S3.4): deleteBankV7 总墓碑化靶向 run vs deletePracticeRunV7 条件墓碑 ---
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("墓碑策略对比");
    const q = await createQuestionV7(bank.id, singleChoice("墓碑对比题", "A", ["对", "错"]));
    const runNoAnswer = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id] }); // 无作答
    await sync();
    await deleteBankV7(bank.id);
    await sync();
    assert.equal(await dbV7.practiceRuns.get(runNoAnswer.id), undefined, "靶向 run 应删除");
    assert.ok(await dbV7.tombstones.get(`practiceRun:${runNoAnswer.id}`), "deleteBankV7 即使 run 无作答也总写墓碑");

    // 对照：直接 deletePracticeRunV7 一个无作答 run → 无墓碑（E7 特征化）
    await freshClient("device-b");
    await sync();
    const bank2 = await createBankV7("直接删run对比");
    const q2 = await createQuestionV7(bank2.id, singleChoice("直接删run题", "A", ["对", "错"]));
    const directRun = await createPracticeRunV7({ bankId: bank2.id, questionIds: [q2.id] });
    await sync();
    await deletePracticeRunV7(directRun.id);
    assert.equal(await dbV7.practiceRuns.get(directRun.id), undefined, "直接删 run 应删除");
    assert.equal(await dbV7.tombstones.get(`practiceRun:${directRun.id}`), undefined, "deletePracticeRunV7 对无作答 run 不写墓碑（E7）");
    console.log("scenario 16 passed: 题库删 run 总墓碑 vs 直接删 run 条件墓碑（S3.4/E7）");
  }

  console.log("sync question management tests passed");
} finally {
  await server.close();
  dbV7.close();
}
