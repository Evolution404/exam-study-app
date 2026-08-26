import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  completeReviewRoundV7,
  createBankV7,
  createPracticeRunV7,
  createQuestionV7,
  createReviewRoundV7,
  dbV7,
  deleteBankWithExclusiveQuestionsV7,
  deletePracticeRunV7,
  recordPracticeAnswerV7,
  resetV7Database,
  saveBankFolderV7,
  saveNoteV7,
  saveQuestionGroupV7,
  setPracticeRunStatusV7,
  splitQuestionV7,
  toggleQuestionFavoriteV7,
} from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// End-to-end sync integration for the learning-statistics projections. Each
// scenario runs real operations on one or more simulated devices against the
// in-memory mock GitHub backend, then pulls from a brand-new device and asserts
// the derived stats (attemptStats / attemptDailyStats / practiceRunStats /
// reviewRoundProgress) and the entity tables converge to the same projection.

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

function singleChoice(stem: string, answer: string, options: string[]): Parameters<typeof createQuestionV7>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: options.map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    answer,
    tags: ["统计测试"],
  };
}

// Dates relative to "now" (future) so each answer change-set's `createdAt`
// sorts strictly after the bank/question/run change-sets created with nowIso().
// They land on distinct calendar days, which is what exercises daily grouping.
function dateAfter(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}
const DAY_1 = dateAfter(1);
const DAY_2 = dateAfter(2);
const DAY_3 = dateAfter(3);

/** A single answer submission. Empty `selected` records a give-up. */
async function answer(runId: string, questionId: string, correct: boolean, selected: string | string[], createdAt?: string, elapsedMs = 120): Promise<void> {
  await recordPracticeAnswerV7({ runId, questionId, selected, correct, elapsedMs, ...(createdAt ? { createdAt } : {}) });
}

/** Run a device's pending edits up to the mock and pull them into a fresh device. */
async function pushThenVerify(deviceId: string, verify: (fresh: string) => Promise<void>): Promise<void> {
  await sync();
  await freshClient(deviceId);
  await sync();
  await verify(deviceId);
}

try {
  // --- Scenario 1: correct / wrong / give-up stats round-trip --------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("统计基础题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("一加一等于几？", "B", ["1", "2", "3"]));
    const q2 = await createQuestionV7(bank.id, singleChoice("地球是圆的吗？", "A", ["是", "否"]));
    const q3 = await createQuestionV7(bank.id, singleChoice("放弃的题目", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q1.id, q2.id, q3.id] });
    await answer(run.id, q1.id, true, "B", DAY_1);
    await answer(run.id, q2.id, false, "B", DAY_1);
    await answer(run.id, q3.id, false, "", DAY_1); // give-up

    await pushThenVerify("device-b", async () => {
      const stats = await dbV7.attemptStats.toArray();
      const byQuestion = new Map(stats.map((row) => [row.questionId, row]));
      assert.equal(stats.length, 3, "三道题应各有一条统计");
      assert.deepEqual(
        { total: byQuestion.get(q1.id)?.total, correct: byQuestion.get(q1.id)?.correct, wrong: byQuestion.get(q1.id)?.wrong, giveUps: byQuestion.get(q1.id)?.giveUps },
        { total: 1, correct: 1, wrong: 0, giveUps: 0 },
        "答对一题：total=1 correct=1",
      );
      assert.deepEqual(
        { total: byQuestion.get(q2.id)?.total, correct: byQuestion.get(q2.id)?.correct, wrong: byQuestion.get(q2.id)?.wrong, giveUps: byQuestion.get(q2.id)?.giveUps },
        { total: 1, correct: 0, wrong: 1, giveUps: 0 },
        "答错一题：total=1 wrong=1",
      );
      assert.deepEqual(
        { total: byQuestion.get(q3.id)?.total, correct: byQuestion.get(q3.id)?.correct, wrong: byQuestion.get(q3.id)?.wrong, giveUps: byQuestion.get(q3.id)?.giveUps },
        { total: 1, correct: 0, wrong: 1, giveUps: 1 },
        "放弃一题：同时计入 wrong 与 giveUps",
      );
      assert.equal(await dbV7.attempts.count(), 3, "三条作答记录应完整同步");
      const daily = await dbV7.attemptDailyStats.toArray();
      assert.equal(daily.length, 3, "同一天的三题各自一条每日统计");
      assert.ok(daily.every((row) => row.date === DAY_1.slice(0, 10)), "每日统计应落在作答当天");
      assert.equal(daily.reduce((sum, row) => sum + row.total, 0), 3, "当天作答总量为 3");
    });
    console.log("scenario 1 passed: 正确/错误/放弃 三类作答统计跨设备一致");
  }

  // --- Scenario 2: repeated answers accumulate streaks across dates ---------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("连续作答题库");
    const q = await createQuestionV7(bank.id, singleChoice("连续练习", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id] });
    await answer(run.id, q.id, true, "A", DAY_1);
    await answer(run.id, q.id, false, "B", DAY_2);
    await answer(run.id, q.id, true, "A", DAY_3, 200);

    await pushThenVerify("device-b", async () => {
      const stat = await dbV7.attemptStats.get(q.id);
      assert.ok(stat, "应存在该题统计");
      assert.equal(stat.total, 3, "三次作答应累加");
      assert.equal(stat.correct, 2);
      assert.equal(stat.wrong, 1);
      assert.equal(stat.hasBeenWrong, true);
      assert.equal(stat.currentCorrectStreak, 1, "最后一次答对 → 当前连胜 1");
      assert.equal(stat.correctStreakAfterWrong, 1, "最后一次错误之后答对了 1 次");
      assert.equal(stat.totalElapsedMs, 120 + 120 + 200, "耗时累加");
      assert.equal(stat.recentOutcomes.length, 3, "最近作答轨迹保留");
      assert.equal(stat.recentOutcomes[2].correct, true, "轨迹按时间升序");
      // Daily stats split across three distinct dates.
      const daily = await dbV7.attemptDailyStats.where("questionId").equals(q.id).toArray();
      assert.equal(daily.length, 3, "跨三天应产生三条每日统计");
      const dates = daily.map((row) => row.date).sort();
      assert.deepEqual(dates, [DAY_1.slice(0, 10), DAY_2.slice(0, 10), DAY_3.slice(0, 10)].sort(), "每日统计分别落在作答当天");
    });
    console.log("scenario 2 passed: 连续作答的连胜/轨迹与跨日期分组一致");
  }

  // --- Scenario 3: two devices answer concurrently and merge ---------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("并发作答题库");
    const q = await createQuestionV7(bank.id, singleChoice("并发题", "A", ["对", "错"]));
    const runA = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id] });
    await answer(runA.id, q.id, true, "A", DAY_1);
    await sync();

    await freshClient("device-b");
    await sync();
    const runB = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id] });
    await answer(runB.id, q.id, false, "B", DAY_2);
    await sync();

    await freshClient("device-a");
    await sync();
    const stat = await dbV7.attemptStats.get(q.id);
    assert.ok(stat);
    assert.equal(stat.total, 2, "两台设备各自一次作答应合并");
    assert.equal(stat.correct, 1);
    assert.equal(stat.wrong, 1);
    const daily = await dbV7.attemptDailyStats.where("questionId").equals(q.id).toArray();
    assert.equal(daily.length, 2, "两个不同日期的每日统计各一条");
    console.log("scenario 3 passed: 多设备并发作答双向合并（含不同日期）");
  }

  // --- Scenario 4: practice-run status transitions + run stats -------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("练习统计题库");
    const q = await createQuestionV7(bank.id, singleChoice("练习状态题", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id] });
    await answer(run.id, q.id, true, "A", DAY_1);
    await setPracticeRunStatusV7(run.id, "completed");

    await pushThenVerify("device-b", async () => {
      const pulledRun = await dbV7.practiceRuns.get(run.id);
      assert.equal(pulledRun?.status, "completed", "练习完成状态应同步");
      assert.equal(Object.keys(pulledRun!.answers).length, 1, "作答应随练习同步");
      const runStats = await dbV7.practiceRunStats.get(bank.id);
      assert.ok(runStats);
      assert.deepEqual(
        { total: runStats.total, completed: runStats.completed, inProgress: runStats.inProgress },
        { total: 1, completed: 1, inProgress: 0 },
        "练习统计应从 in_progress 流转到 completed",
      );
    });
    console.log("scenario 4 passed: 练习状态流转与练习统计跨设备一致");
  }

  // --- Scenario 5: deleting a run keeps global attempt stats ----------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("删除练习题库");
    const q = await createQuestionV7(bank.id, singleChoice("删除练习题", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id] });
    await answer(run.id, q.id, true, "A");
    await deletePracticeRunV7(run.id);

    await pushThenVerify("device-b", async () => {
      assert.equal(await dbV7.practiceRuns.get(run.id), undefined, "练习记录应被删除");
      const stat = await dbV7.attemptStats.get(q.id);
      assert.ok(stat, "删除练习不应回退全局作答统计");
      assert.equal(stat.total, 1);
      assert.equal(await dbV7.attempts.count(), 1, "作答记录保留为全局学习历史");
    });
    console.log("scenario 5 passed: 删除练习保留全局统计、仅删除练习投影");
  }

  // --- Scenario 6: cascade bank delete clears stats --------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("级联删除统计题库");
    const q = await createQuestionV7(bank.id, singleChoice("将被级联删除", "A", ["对", "错"]));
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q.id] });
    await answer(run.id, q.id, true, "A");
    await deleteBankWithExclusiveQuestionsV7(bank.id);

    await pushThenVerify("device-b", async () => {
      assert.equal(await dbV7.questions.get(q.id), undefined, "级联删除应移除题目");
      assert.equal(await dbV7.attempts.count(), 0, "级联删除应移除作答");
      assert.equal(await dbV7.attemptStats.get(q.id), undefined, "级联删除应移除全局统计");
      assert.equal(await dbV7.attemptDailyStats.where("questionId").equals(q.id).count(), 0, "级联删除应移除每日统计");
    });
    console.log("scenario 6 passed: 题库级联删除同步清理作答与全部统计");
  }

  // --- Scenario 7: review-round progress syncs -------------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("复习轮次题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("复习题 1", "A", ["对", "错"]));
    const q2 = await createQuestionV7(bank.id, singleChoice("复习题 2", "B", ["对", "错"]));
    const round = await createReviewRoundV7({ name: "错题复习", bankIds: [bank.id] });
    const run = await createPracticeRunV7({ bankId: bank.id, questionIds: [q1.id, q2.id], reviewRoundId: round.id });
    await answer(run.id, q1.id, true, "A");
    await answer(run.id, q2.id, false, "A");
    await completeReviewRoundV7(round.id);

    await pushThenVerify("device-b", async () => {
      const pulledRound = await dbV7.reviewRounds.get(round.id);
      assert.equal(pulledRound?.status, "completed", "轮次完成状态应同步");
      const progress = await dbV7.reviewRoundProgress.where("roundId").equals(round.id).toArray();
      assert.equal(progress.length, 2, "两道题的轮次进度应同步");
      const byQuestion = new Map(progress.map((row) => [row.questionId, row]));
      assert.deepEqual(
        { a: byQuestion.get(q1.id)?.correct, b: byQuestion.get(q2.id)?.correct },
        { a: 1, b: 0 },
        "轮次进度应区分对错",
      );
      assert.equal(byQuestion.get(q1.id)?.recentOutcomes?.length, 1, "轮次同步后应保留个人难度证据");
      assert.equal(byQuestion.get(q1.id)?.currentCorrectStreak, 1);
      assert.equal(byQuestion.get(q2.id)?.hasBeenWrong, true);
      assert.equal(byQuestion.get(q2.id)?.totalElapsedMs, 120);
    });
    console.log("scenario 7 passed: 复习轮次进度与完成状态跨设备一致");
  }

  // --- Scenario 8: groups / notes / folders / favourites ---------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("杂项操作题库");
    const folder = await saveBankFolderV7({ name: "同步文件夹", description: "验证" });
    const q1 = await createQuestionV7(bank.id, singleChoice("收藏题", "A", ["对", "错"]));
    const q2 = await createQuestionV7(bank.id, singleChoice("解析题", "A", ["对", "错"]));
    await saveNoteV7(q2.id, "这是一条个人解析。");
    await saveQuestionGroupV7({ name: "题组 A", type: "错题", description: "同步验证", items: [{ questionId: q1.id, note: "重点" }, { questionId: q2.id, note: "" }] });
    await toggleQuestionFavoriteV7(q1.id);
    await saveBankFolderV7({ id: folder.id, name: "同步文件夹", description: "更新后的描述" });

    await pushThenVerify("device-b", async () => {
      assert.ok(await dbV7.bankFolders.get(folder.id), "文件夹应同步");
      assert.equal((await dbV7.questions.get(q1.id))?.favorite, true, "收藏状态应同步");
      const note = await dbV7.notes.get(q2.id);
      assert.equal(note?.content, "这是一条个人解析。", "解析应同步");
      const group = (await dbV7.questionGroups.toArray())[0];
      assert.ok(group, "题组应同步");
      assert.equal(group.items.length, 2, "题组成员应完整");
    });
    console.log("scenario 8 passed: 文件夹/解析/题组/收藏 跨设备同步");
  }

  // --- Scenario 9: question split propagates a clone -------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("拆分题库");
    const original = await createQuestionV7(bank.id, singleChoice("待拆分题", "A", ["对", "错"]));
    const { clones } = await splitQuestionV7(original.id, [bank.id]);
    assert.equal(clones.length, 1, "拆分应产生一个 clone");

    await pushThenVerify("device-b", async () => {
      assert.ok(await dbV7.questions.get(original.id), "原题应保留");
      assert.ok(await dbV7.questions.get(clones[0].id), "clone 应同步到新设备");
      assert.equal(await dbV7.questions.count(), 2, "拆分后应有两道题");
    });
    console.log("scenario 9 passed: 题目拆分跨设备传播 clone");
  }

  console.log("sync stats integration tests passed");
} finally {
  await server.close();
  dbV7.close();
}
