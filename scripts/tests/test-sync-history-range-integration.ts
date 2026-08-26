import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createPracticeRunV7, createQuestionV7, dbV7, recordPracticeAnswerV7, resetV7Database, setPracticeRunStatusV7 } from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

let currentDeviceId = "history-device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => key === "shijuan-study-device-id" ? currentDeviceId : null,
    setItem: (key: string, value: string) => { if (key === "shijuan-study-device-id") currentDeviceId = value; },
  },
});

const server = await startMockGitHubServer({ cas: true });
const baseSettings = { owner: "qa", repo: "history-window", branch: "main", apiBaseUrl: server.url };
const day = 86_400_000;
const base = Date.now();
const oldAt = new Date(base - 20 * day).toISOString();
const start = new Date(base - 15 * day).toISOString().slice(0, 10);
const recentAt = new Date(base - 10 * day).toISOString();

try {
  await resetV7Database();
  await syncWithGitHub(baseSettings, "token");
  const bank = await createBankV7("历史窗口题库");
  const question = await createQuestionV7(bank.id, {
    type: "单选",
    stem: "同步范围是否只影响历史？",
    options: ["是", "否"],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
  });
  await syncWithGitHub(baseSettings, "token");
  const oldRun = await createPracticeRunV7({ bankId: bank.id, questionIds: [question.id], startedAt: oldAt });
  await setPracticeRunStatusV7(oldRun.id, "completed");
  const recentRun = await createPracticeRunV7({ bankId: bank.id, questionIds: [question.id], startedAt: recentAt });
  await setPracticeRunStatusV7(recentRun.id, "completed");
  await syncWithGitHub(baseSettings, "token");
  await recordPracticeAnswerV7({ runId: oldRun.id, questionId: question.id, selected: "A", correct: true, createdAt: oldAt });
  await recordPracticeAnswerV7({ runId: recentRun.id, questionId: question.id, selected: "B", correct: false, createdAt: recentAt });
  await syncWithGitHub(baseSettings, "token");
  const remotePaths = new Set(server.contentPaths());

  currentDeviceId = "history-device-b";
  await resetV7Database();
  const windowedSettings = { ...baseSettings, historySyncStart: start };
  await syncWithGitHub(windowedSettings, "token");
  assert.equal(await dbV7.questions.count(), 1, "content entities remain fully synchronized");
  assert.deepEqual((await dbV7.practiceRuns.toArray()).map((run) => run.id), [recentRun.id], "new device installs only runs at or after its history start");
  assert.equal(await dbV7.attempts.count(), 1, "windowed device retains exactly one recent attempt");
  assert.equal((await dbV7.attempts.toArray())[0]?.createdAt, recentAt);
  assert.deepEqual(new Set(server.contentPaths()), remotePaths, "windowed pull does not delete remote history objects");

  await syncWithGitHub(baseSettings, "token");
  assert.equal(await dbV7.practiceRuns.count(), 2, "moving the device start earlier restores older remote runs");
  assert.equal(await dbV7.attempts.count(), 2, "moving the device start earlier restores older remote attempts");
  assert.equal((await dbV7.attemptStats.get(question.id))?.total, 2, "statistics rebuild after expanding the history range");

  console.log("sync history range integration passed: per-device filtering, complete content, remote preservation and range expansion");
} finally {
  await server.close();
  dbV7.close();
}
