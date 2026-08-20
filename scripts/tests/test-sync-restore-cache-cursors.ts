import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { restoreLastRemoteCache, syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
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

const settings = { owner: "qa", repo: "restore-cursors-vault", branch: "main", apiBaseUrl: "" };
const cursorsKey = "v8:sync:installed-cursors:qa/restore-cursors-vault@main";

const server = await startMockGitHubServer({ cas: true });
try {
  const resolvedSettings = { ...settings, apiBaseUrl: server.url };
  await resetV7Database();
  await createBankV7("恢复游标测试题库");
  await syncWithGitHub(resolvedSettings, "qa-token");

  // 模拟本地游标缓存损坏/丢失后，从本机 v7 恢复记录恢复。
  await dbV7.syncMeta.delete(cursorsKey);
  assert.equal(await dbV7.syncMeta.get(cursorsKey), undefined, "前置条件：游标缓存已删除");

  await restoreLastRemoteCache(resolvedSettings);
  const restoredCursors = (await dbV7.syncMeta.get(cursorsKey))?.value as Record<string, number> | undefined;
  assert.ok(restoredCursors, "restoreLastRemoteCache 应恢复已安装游标，避免下次同步重复下载已合并热窗口");

  console.log("sync restore cache cursors tests passed");
} finally {
  await server.close();
  dbV7.close();
}
