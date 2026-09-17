import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBank, createPracticeRun, createQuestion, studyDb, recordPracticeAnswer, resetDatabase, setPracticeRunStatus } from "../../src/lib/db/db";
import { restoreFullHistoryFromGitHub, syncWithGitHub } from "../../src/lib/sync/github-sync-engine";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

let currentDeviceId = "restore-types-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-device-id") currentDeviceId = value;
    },
    removeItem: () => undefined,
  },
});

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "restore-question-types", branch: "main", apiBaseUrl: server.url };

try {
  server.reset();
  await resetDatabase();
  await syncWithGitHub(settings, "qa-token");

  const bank = await createBank("远程恢复题型");
  const fillQuestion = await createQuestion(bank.id, {
    type: "填空",
    content: [{ id: "fill-stem", type: "text", text: "远程恢复填空题" }],
    options: [],
    solution: { kind: "fill", blanks: [{ id: "blank-1", acceptedAnswers: ["填空答案"] }] },
    tags: ["恢复"],
  });
  await createQuestion(bank.id, {
    type: "简答",
    content: [{ id: "short-stem", type: "text", text: "远程恢复简答题" }],
    options: [],
    solution: { kind: "short", referenceText: "简答参考答案" },
    tags: ["恢复"],
  });
  const oldRun = await createPracticeRun({
    bankId: bank.id, bankIds: [bank.id], questionIds: [fillQuestion.id],
  });
  await recordPracticeAnswer({
    runId: oldRun.id, questionId: fillQuestion.id, bankId: bank.id, selected: ["旧答案"],
    correct: true, elapsedMs: 1000,
  });
  await setPracticeRunStatus(oldRun.id, "completed");
  await syncWithGitHub(settings, "qa-token");

  currentDeviceId = "restore-types-b";
  await resetDatabase();
  const restoreProgress: string[] = [];
  const rangedSettings = { ...settings, historySyncStart: "2027-01-01" };
  await restoreFullHistoryFromGitHub(rangedSettings, "qa-token", (item) => { restoreProgress.push(item.label); });

  assert.ok(restoreProgress.some((label) => /(更新题目|更新作答记录|本机增量更新完成)/.test(label) && /（\d+\/\d+）/.test(label)), "remote restore must expose real local completed/total progress");
  const restored = await studyDb.questions.toArray();
  assert.deepEqual(
    restored.map((question) => question.type).sort(),
    ["填空", "简答"].sort(),
    "remote full restore must accept and restore every current QuestionType",
  );
  assert.equal(restored.length, 2, "remote restore should recover both questions");
  assert.equal(await studyDb.attempts.count(), 1, "explicit full remote restore must ignore historySyncStart and recover older attempts");
  assert.equal(await studyDb.practiceRuns.count(), 1, "explicit full remote restore must recover older completed runs");

  // Simulate a crash after projection install but before sync metadata/cache was
  // persisted. The next sync must self-heal from remote state and preserve a new
  // local edit created in that interrupted state.
  await studyDb.syncMeta.clear();
  const localAfterCrash = await createQuestion(bank.id, {
    type: "单选",
    content: [{ id: "crash-stem", type: "text", text: "恢复中断后新增题" }],
    options: [[{ id: "crash-a", type: "text", text: "A" }], [{ id: "crash-b", type: "text", text: "B" }]],
    optionIds: ["crash-a", "crash-b"],
    solution: { kind: "choice", correctOptionIds: ["crash-a"] },
    tags: ["恢复"],
  });
  let questionClearCalls = 0;
  const originalQuestionClear = studyDb.questions.clear.bind(studyDb.questions);
  studyDb.questions.clear = (() => {
    questionClearCalls += 1;
    return originalQuestionClear();
  }) as typeof studyDb.questions.clear;
  try {
    await syncWithGitHub(settings, "qa-token");
  } finally {
    studyDb.questions.clear = originalQuestionClear;
  }
  assert.ok(await studyDb.questions.get(localAfterCrash.id), "metadata-interrupted recovery must preserve a newly queued local edit");
  assert.equal(await studyDb.attempts.count(), 1, "metadata-interrupted recovery must retain restored remote history");
  assert.equal(questionClearCalls, 0, "metadata-interrupted recovery must reconcile without clearing the projection");

  console.log("remote restore question-type/history/progress/crash-recovery regression passed");
} finally {
  await resetDatabase();
  studyDb.close();
  await server.close();
}
process.exit(0);
