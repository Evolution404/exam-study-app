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
try {
  const settings = { owner: "qa", repo: "fresh-install-contract-vault", branch: "main", apiBaseUrl: server.url };
  const token = "qa-token";

  await resetV7Database();
  await createBankV7("契约测试题库");
  await syncWithGitHub(settings, token);

  memoryLocalStorage.delete("shijuan-study-device-id");
  await resetV7Database();
  const result = await syncWithGitHub(settings, token);
  assert.ok(result.receivedSnapshot, "全新设备安装检查点后应收到快照统计");
  assert.equal(result.pulled, 0, "没有热窗口分段时 pulled 应为 0（数据量由 receivedSnapshot 表达）");
  assert.equal(await dbV7.banks.count(), 1, "全新设备应恢复 1 个题库");

  console.log("sync fresh install contract tests passed");
} finally {
  await server.close();
  dbV7.close();
}
