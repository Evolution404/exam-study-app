import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

const server = await startMockGitHubServer({ cas: true });
const originalQuestionBulkGet = dbV7.questions.bulkGet.bind(dbV7.questions);
const originalAttemptBulkGet = dbV7.attempts.bulkGet.bind(dbV7.attempts);
try {
  const settings = { owner: "qa", repo: "fresh-install-contract-vault", branch: "main", apiBaseUrl: server.url };
  const token = "qa-token";

  await resetV7Database();
  await createBankV7("契约测试题库");
  await syncWithGitHub(settings, token);

  memoryLocalStorage.delete("shijuan-study-v7-device-id");
  await resetV7Database();
  let projectionBulkGetCalls = 0;
  dbV7.questions.bulkGet = ((keys) => {
    projectionBulkGetCalls += 1;
    return originalQuestionBulkGet(keys);
  }) as typeof dbV7.questions.bulkGet;
  dbV7.attempts.bulkGet = ((keys) => {
    projectionBulkGetCalls += 1;
    return originalAttemptBulkGet(keys);
  }) as typeof dbV7.attempts.bulkGet;

  const result = await syncWithGitHub(settings, token);
  assert.ok(result.receivedSnapshot, "全新设备安装检查点后应收到快照统计");
  assert.equal(result.pulled, 0, "没有热窗口分段时 pulled 应为 0（数据量由 receivedSnapshot 表达）");
  assert.equal(await dbV7.banks.count(), 1, "全新设备应恢复 1 个题库");
  assert.equal(projectionBulkGetCalls, 0, "全新空库安装不得为判断缺失记录而 bulkGet 远端 projection；应直接走 fresh fast path");

  console.log("sync fresh install contract tests passed: projection fast path skipped bulkGet planning");
} finally {
  dbV7.questions.bulkGet = originalQuestionBulkGet;
  dbV7.attempts.bulkGet = originalAttemptBulkGet;
  await server.close();
  dbV7.close();
}
