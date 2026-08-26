import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createPracticeRunV7, createQuestionV7, dbV7, recordPracticeAnswerV7, resetV7Database, setPracticeRunStatusV7 } from "../../src/lib/db/db-v7";
import { restoreFullHistoryFromGitHub, syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

let currentDeviceId = "restore-types-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-v7-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-v7-device-id") currentDeviceId = value;
    },
    removeItem: () => undefined,
  },
});

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "restore-question-types", branch: "main", apiBaseUrl: server.url };

try {
  server.reset();
  await resetV7Database();
  await syncWithGitHub(settings, "qa-token");

  const bank = await createBankV7("远程恢复题型");
  const fillQuestion = await createQuestionV7(bank.id, {
    type: "填空",
    content: [{ id: "fill-stem", type: "text", text: "远程恢复填空题" }],
    options: [],
    solution: { kind: "fill", blanks: [{ id: "blank-1", acceptedAnswers: ["填空答案"] }] },
    tags: ["恢复"],
  });
  await createQuestionV7(bank.id, {
    type: "简答",
    content: [{ id: "short-stem", type: "text", text: "远程恢复简答题" }],
    options: [],
    solution: { kind: "short", referenceText: "简答参考答案" },
    tags: ["恢复"],
  });
  const oldRun = await createPracticeRunV7({
    bankId: bank.id, bankIds: [bank.id], questionIds: [fillQuestion.id],
  });
  await recordPracticeAnswerV7({
    runId: oldRun.id, questionId: fillQuestion.id, bankId: bank.id, selected: ["旧答案"],
    correct: true, elapsedMs: 1000,
  });
  await setPracticeRunStatusV7(oldRun.id, "completed");
  await syncWithGitHub(settings, "qa-token");

  currentDeviceId = "restore-types-b";
  await resetV7Database();
  const restoreProgress: string[] = [];
  const rangedSettings = { ...settings, historySyncStart: "2027-01-01" };
  await restoreFullHistoryFromGitHub(rangedSettings, "qa-token", (item) => { restoreProgress.push(item.label); });

  assert.ok(restoreProgress.some((label) => /(更新题目|更新作答记录|本机增量更新完成)/.test(label) && /（\d+\/\d+）/.test(label)), "remote restore must expose real local completed/total progress");
  const restored = await dbV7.questions.toArray();
  assert.deepEqual(
    restored.map((question) => question.type).sort(),
    ["填空", "简答"].sort(),
    "remote full restore must accept and restore every current QuestionType",
  );
  assert.equal(restored.length, 2, "remote restore should recover both questions");
  assert.equal(await dbV7.attempts.count(), 1, "explicit full remote restore must ignore historySyncStart and recover older attempts");
  assert.equal(await dbV7.practiceRuns.count(), 1, "explicit full remote restore must recover older completed runs");

  // Simulate a crash after projection install but before sync metadata/cache was
  // persisted. The next sync must self-heal from remote state and preserve a new
  // local edit created in that interrupted state.
  await dbV7.syncMeta.clear();
  const localAfterCrash = await createQuestionV7(bank.id, {
    type: "单选",
    content: [{ id: "crash-stem", type: "text", text: "恢复中断后新增题" }],
    options: [[{ id: "crash-a", type: "text", text: "A" }], [{ id: "crash-b", type: "text", text: "B" }]],
    optionIds: ["crash-a", "crash-b"],
    solution: { kind: "choice", correctOptionIds: ["crash-a"] },
    tags: ["恢复"],
  });
  let questionClearCalls = 0;
  const originalQuestionClear = dbV7.questions.clear.bind(dbV7.questions);
  dbV7.questions.clear = (() => {
    questionClearCalls += 1;
    return originalQuestionClear();
  }) as typeof dbV7.questions.clear;
  try {
    await syncWithGitHub(settings, "qa-token");
  } finally {
    dbV7.questions.clear = originalQuestionClear;
  }
  assert.ok(await dbV7.questions.get(localAfterCrash.id), "metadata-interrupted recovery must preserve a newly queued local edit");
  assert.equal(await dbV7.attempts.count(), 1, "metadata-interrupted recovery must retain restored remote history");
  assert.equal(questionClearCalls, 0, "metadata-interrupted recovery must reconcile without clearing the projection");

  console.log("remote restore question-type/history/progress/crash-recovery regression passed");
} finally {
  await resetV7Database();
  dbV7.close();
  await server.close();
}
process.exit(0);
