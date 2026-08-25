import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
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
  await createQuestionV7(bank.id, {
    type: "填空",
    content: [{ id: "fill-stem", type: "text", text: "远程恢复填空题" }],
    options: [],
    answer: "填空答案",
    tags: ["恢复"],
  });
  await createQuestionV7(bank.id, {
    type: "简答",
    content: [{ id: "short-stem", type: "text", text: "远程恢复简答题" }],
    options: [],
    answer: "简答参考答案",
    tags: ["恢复"],
  });
  await syncWithGitHub(settings, "qa-token");

  currentDeviceId = "restore-types-b";
  await resetV7Database();
  await restoreFullHistoryFromGitHub(settings, "qa-token");

  const restored = await dbV7.questions.toArray();
  assert.deepEqual(
    restored.map((question) => question.type).sort(),
    ["填空", "简答"].sort(),
    "remote full restore must accept and restore every current QuestionType",
  );
  assert.equal(restored.length, 2, "remote restore should recover both questions");

  console.log("remote restore question-type regression passed");
} finally {
  await resetV7Database();
  dbV7.close();
  await server.close();
}
process.exit(0);
