import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBank, studyDb, resetDatabase } from "../../src/lib/db/db";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-engine";
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
const originalQuestionBulkGet = studyDb.questions.bulkGet.bind(studyDb.questions);
const originalAttemptBulkGet = studyDb.attempts.bulkGet.bind(studyDb.attempts);
try {
  const settings = { owner: "qa", repo: "fresh-install-contract-vault", branch: "main", apiBaseUrl: server.url };
  const token = "qa-token";

  await resetDatabase();
  await createBank("契约测试题库");
  await syncWithGitHub(settings, token);

  memoryLocalStorage.delete("shijuan-study-device-id");
  await resetDatabase();
  let projectionBulkGetCalls = 0;
  studyDb.questions.bulkGet = ((keys) => {
    projectionBulkGetCalls += 1;
    return originalQuestionBulkGet(keys);
  }) as typeof studyDb.questions.bulkGet;
  studyDb.attempts.bulkGet = ((keys) => {
    projectionBulkGetCalls += 1;
    return originalAttemptBulkGet(keys);
  }) as typeof studyDb.attempts.bulkGet;

  const result = await syncWithGitHub(settings, token);
  assert.ok(result.receivedSnapshot, "全新设备安装检查点后应收到快照统计");
  assert.equal(result.pulled, 0, "没有热窗口分段时 pulled 应为 0（数据量由 receivedSnapshot 表达）");
  assert.equal(await studyDb.banks.count(), 1, "全新设备应恢复 1 个题库");
  assert.equal(projectionBulkGetCalls, 0, "全新空库安装不得为判断缺失记录而 bulkGet 远端 projection；应直接走 fresh fast path");

  console.log("sync fresh install contract tests passed: projection fast path skipped bulkGet planning");
} finally {
  studyDb.questions.bulkGet = originalQuestionBulkGet;
  studyDb.attempts.bulkGet = originalAttemptBulkGet;
  await server.close();
  studyDb.close();
}
