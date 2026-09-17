import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBank, studyDb, resetDatabase } from "../../src/lib/db/db";
import { restoreLastRemoteCache, syncWithGitHub } from "../../src/lib/sync/github-sync-engine";
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
const cursorsKey = "v9:sync:installed-cursors:qa/restore-cursors-vault@main";

const server = await startMockGitHubServer({ cas: true });
try {
  const resolvedSettings = { ...settings, apiBaseUrl: server.url };
  await resetDatabase();
  await createBank("恢复游标测试题库");
  await syncWithGitHub(resolvedSettings, "qa-token");

  // 模拟本地游标缓存损坏/丢失后，从本机 v7 恢复记录恢复。
  await studyDb.syncMeta.delete(cursorsKey);
  assert.equal(await studyDb.syncMeta.get(cursorsKey), undefined, "前置条件：游标缓存已删除");

  await restoreLastRemoteCache(resolvedSettings);
  const restoredCursors = (await studyDb.syncMeta.get(cursorsKey))?.value as Record<string, number> | undefined;
  assert.ok(restoredCursors, "restoreLastRemoteCache 应恢复已安装游标，避免下次同步重复下载已合并热窗口");

  console.log("sync restore cache cursors tests passed");
} finally {
  await server.close();
  studyDb.close();
}
