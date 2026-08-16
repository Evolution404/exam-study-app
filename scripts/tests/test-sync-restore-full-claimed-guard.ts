import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { restoreFullHistoryFromGitHub, syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
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
  const settings = { owner: "qa", repo: "restore-claimed-guard-vault", branch: "main", apiBaseUrl: server.url };
  await resetV7Database();
  await createBankV7("已同步题库");
  await syncWithGitHub(settings, "qa-token");

  await createBankV7("未同步题库");
  await dbV7.transaction("rw", dbV7.changeSets, async () => {
    const pending = await dbV7.changeSets.where("state").equals("pending").toArray();
    if (pending.length) await dbV7.changeSets.bulkPut(pending.map((record) => ({ ...record, state: "claimed" as const, claimId: "claim-x", claimedAt: new Date().toISOString() })));
  });

  await assert.rejects(
    restoreFullHistoryFromGitHub(settings, "qa-token"),
    /未同步/,
    "远端恢复也应守卫 claimed 状态的本地变更",
  );

  console.log("sync restore full claimed guard tests passed");
} finally {
  await server.close();
  dbV7.close();
}
