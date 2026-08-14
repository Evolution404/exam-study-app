import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBankV6,
  createPracticeRunV6,
  createQuestionV6,
  dbV6,
  deleteBankWithExclusiveQuestionsV6,
  deleteQuestionV6,
  importQuestionBankV6,
  recordPracticeAnswerV6,
  removeMembershipV6,
  resetV6Database,
  toggleQuestionFavoriteV6,
  updateQuestionV6,
} from "../lib/db-v6";
import { syncWithGitHub } from "../lib/github-sync-v7";
import { startMockGitHubServer } from "./mock-github-server.mjs";

// Integration tests for question lifecycle (import / edit / delete / membership
// / dedup) plus a committed-records GC stress test, all against the in-memory
// mock GitHub backend with fresh-device pulls verifying cross-device consistency.

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-v6-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-v6-device-id") currentDeviceId = value;
    },
  },
});

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "mock-vault", branch: "main", apiBaseUrl: server.url };
const sync = () => syncWithGitHub(settings, "qa-token");

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV6Database();
}

function singleChoice(stem: string, answer: string, options: string[]): Parameters<typeof createQuestionV6>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: options.map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    answer,
    tags: ["试题管理"],
  };
}

try {
  // --- Scenario 1: atomic import round-trips --------------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const rows = Array.from({ length: 200 }, (_, index) => ({ q: `导入第 ${index + 1} 题：考点 ${index}，下列哪项正确？`, a: ["甲", "乙", "丙", "丁"], ans: "A" }));
    const bank = await importQuestionBankV6("试题导入.json", rows);
    assert.equal(await dbV6.questions.count(), 200, "本地应导入 200 题");
    const fingerprints = new Set((await dbV6.questions.toArray()).map((question) => question.contentFingerprint));
    await sync();
    assert.ok(server.contentPaths().some((path) => path.startsWith("sync/v7/objects/")), "大导入应卸载为不可变对象");

    await freshClient("device-b");
    await sync();
    assert.equal(await dbV6.questions.count(), 200, "新设备应拉取到全部 200 题");
    assert.equal(await dbV6.bankQuestionMemberships.where("bankId").equals(bank.id).count(), 200, "题库关系应完整");
    const pulledFingerprints = new Set((await dbV6.questions.toArray()).map((question) => question.contentFingerprint));
    assert.deepEqual([...pulledFingerprints].sort(), [...fingerprints].sort(), "内容指纹应逐题一致");
    console.log("scenario 1 passed: 单原子大导入跨设备一致（含卸载）");
  }

  // --- Scenario 2: editing a question propagates ----------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV6("编辑题库");
    const question = await createQuestionV6(bank.id, singleChoice("原始题干", "A", ["对", "错"]));
    await sync();

    await freshClient("device-b");
    await sync();
    const original = await dbV6.questions.get(question.id);
    assert.equal((original?.content[0] as { text?: string } | undefined)?.text, "原始题干", "新设备应先拉取到原始内容");

    await freshClient("device-a");
    await sync();
    await updateQuestionV6(question.id, { content: [{ id: "stem-0", type: "text", text: "编辑后的题干" }], tags: ["已更新"] });
    await sync();

    await freshClient("device-b");
    await sync();
    const pulled = await dbV6.questions.get(question.id);
    assert.equal((pulled?.content[0] as { text?: string } | undefined)?.text, "编辑后的题干", "编辑后的内容应同步");
    assert.deepEqual(pulled?.tags, ["已更新"], "标签编辑应同步");
    console.log("scenario 2 passed: 题目编辑跨设备传播");
  }

  // --- Scenario 3: deleting a question cascades to its stats ----------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV6("删除统计题库");
    const question = await createQuestionV6(bank.id, singleChoice("将被删除且已作答", "A", ["对", "错"]));
    const run = await createPracticeRunV6({ bankId: bank.id, questionIds: [question.id] });
    await recordPracticeAnswerV6({ runId: run.id, questionId: question.id, selected: "A", correct: true });
    assert.ok(await dbV6.attemptStats.get(question.id), "作答应产生全局统计");

    await deleteQuestionV6(question.id);
    assert.equal(await dbV6.attempts.count(), 0, "本地级联应清理作答");
    assert.equal(await dbV6.attemptStats.get(question.id), undefined, "本地级联应清理统计");

    await sync();
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV6.questions.get(question.id), undefined, "新设备不应再看到已删题目");
    assert.equal(await dbV6.attempts.count(), 0, "新设备作答应被清理");
    assert.equal(await dbV6.attemptStats.get(question.id), undefined, "新设备统计应被清理");
    assert.equal(await dbV6.attemptDailyStats.where("questionId").equals(question.id).count(), 0, "每日统计应被清理");
    console.log("scenario 3 passed: 删除题目级联清理作答与统计跨设备一致");
  }

  // --- Scenario 4: deleting an exclusive bank cascades to questions ---------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV6("独占删库");
    const question = await createQuestionV6(bank.id, singleChoice("独占题", "A", ["对", "错"]));
    const run = await createPracticeRunV6({ bankId: bank.id, questionIds: [question.id] });
    await recordPracticeAnswerV6({ runId: run.id, questionId: question.id, selected: "A", correct: true });

    await deleteBankWithExclusiveQuestionsV6(bank.id);
    await sync();
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV6.banks.get(bank.id), undefined, "新设备不应看到已删题库");
    assert.equal(await dbV6.questions.get(question.id), undefined, "独占题目应被级联删除");
    assert.equal(await dbV6.practiceRuns.get(run.id), undefined, "绑定该题库的练习应随题库清除");
    console.log("scenario 4 passed: 删除独占题库级联清理题目与练习跨设备一致");
  }

  // --- Scenario 5: removing a membership keeps the global question ----------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    // Importing the same content under two filenames creates two banks sharing
    // one global question (fingerprint dedup), with a membership in each bank.
    const row = [{ q: "共享题目", a: ["对", "错"], ans: "A" }];
    const bankA = await importQuestionBankV6("共享A.json", row);
    const bankB = await importQuestionBankV6("共享B.json", row);
    const shared = (await dbV6.questions.toArray()).find((question) => (question.content[0] as { text?: string } | undefined)?.text === "共享题目");
    assert.ok(shared, "应存在共享题目");
    assert.equal(await dbV6.bankQuestionMemberships.where("questionId").equals(shared!.id).count(), 2, "共享题应同时归属两个题库");

    await removeMembershipV6(bankA.id, shared!.id);
    await sync();
    await freshClient("device-b");
    await sync();
    assert.ok(await dbV6.questions.get(shared!.id), "移除关系后题目应全局保留");
    assert.equal(await dbV6.bankQuestionMemberships.where("questionId").equals(shared!.id).count(), 1, "仅剩一个题库关系");
    assert.equal((await dbV6.bankQuestionMemberships.where("questionId").equals(shared!.id).toArray())[0]?.bankId, bankB.id, "保留的应是题库 B 的关系");
    console.log("scenario 5 passed: 移除题库关系保留全局题目");
  }

  // --- Scenario 6: re-importing identical content deduplicates --------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const rows = Array.from({ length: 50 }, (_, index) => ({ q: `去重第 ${index + 1} 题`, a: ["甲", "乙"], ans: "A" }));
    await importQuestionBankV6("第一次.json", rows);
    await importQuestionBankV6("第二次.json", rows); // identical content
    assert.equal(await dbV6.questions.count(), 50, "重复导入不应产生重复题目");
    assert.equal(await dbV6.bankQuestionMemberships.count(), 100, "两个题库应各持有一条关系");

    await sync();
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV6.questions.count(), 50, "新设备题目数应一致（无重复）");
    console.log("scenario 6 passed: 重复导入按内容指纹去重");
  }

  // --- Scenario 7 (GC stress): >500 committed records prune to ≤500 ---------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV6("GC 压测题库");
    const question = await createQuestionV6(bank.id, singleChoice("收藏压测题", "A", ["对", "错"]));
    // Each toggle enqueues an independent question.upsert change-set (no dedup),
    // so 600 toggles produce 600 committed records after one sync.
    for (let index = 0; index < 600; index += 1) await toggleQuestionFavoriteV6(question.id);
    await sync();
    const committedCount = await dbV6.changeSets.where("state").equals("committed").count();
    assert.ok(committedCount <= 500, `committed 应被裁剪到 ≤500，实际 ${committedCount}`);
    assert.ok(committedCount > 0, "裁剪后仍应保留最近的已同步记录");
    const originFinalFavorite = (await dbV6.questions.get(question.id))?.favorite;

    // Pruning must not lose data: a fresh device pulls the full segment tail and
    // reconstructs the identical projection (final favorite state).
    await freshClient("device-b");
    await sync();
    const pulled = await dbV6.questions.get(question.id);
    assert.ok(pulled, "GC 后新设备仍能完整拉取题目");
    assert.equal(pulled?.favorite, originFinalFavorite, "两设备的最终收藏状态应一致");
    console.log("scenario 7 passed: 超过 500 条 committed 被裁剪且数据完整可重建");
  }

  console.log("sync question management tests passed");
} finally {
  await server.close();
  dbV6.close();
}
