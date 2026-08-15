import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV6, dbV6, resetV6Database } from "../../src/lib/db/db-v6";
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

const server = await startMockGitHubServer({ cas: true });
try {
  const settings = { owner: "qa", repo: "restore-guard-vault", branch: "main", apiBaseUrl: server.url };
  await resetV6Database();
  await createBankV6("已同步题库");
  await syncWithGitHub(settings, "qa-token");

  // 产生一组未同步的本地修改。本地恢复缓存会清空 changeSets，若不加守卫会直接丢失。
  await createBankV6("未同步题库");
  const pendingBefore = await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingBefore, 1, "前置条件：应存在 1 组未同步变更");

  await assert.rejects(
    restoreLastRemoteCache(settings),
    /未同步|请先同步|处理/,
    "本地恢复缓存也必须像远端恢复一样守卫未同步变更",
  );

  const pendingAfter = await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingAfter, 1, "守卫失败后不得清空未同步变更");

  console.log("sync restore cache guard tests passed");
} finally {
  await server.close();
  dbV6.close();
}
