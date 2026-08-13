import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV6, dbV6, resetV6Database } from "../lib/db-v6";
import { syncWithGitHub } from "../lib/github-sync-v7";
import { startMockGitHubServer } from "./mock-github-server.mjs";

// The browser-driven sync test covers the UI; this fast, Chrome-free test pins
// down the HTTP contract between the real GitHubV7Remote client and the local
// mock backend: a full successful v7 sync (init + upload + idempotent re-sync)
// must run end to end against the in-memory server.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

const server = await startMockGitHubServer();
try {
  await resetV6Database();
  const settings = { owner: "qa", repo: "mock-vault", branch: "main", apiBaseUrl: server.url };
  const labels: string[] = [];

  // First sync against an empty mock: initializes the vault and folds any local
  // baseline into the initial checkpoint (pushed: 0 is correct here).
  const init = await syncWithGitHub(settings, "qa-token", (progress) => labels.push(progress.label));
  assert.equal(init.formatVersion, 7, "同步协议版本应为 7");
  assert.equal(init.remaining, 0, "初始化后应无待办");

  // A change-set created AFTER the baseline exists is what the push path uploads.
  await createBankV6("同步后端契约测试题库");
  const pendingBefore = await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.ok(pendingBefore >= 1, "建库应产生待同步变更");

  const push = await syncWithGitHub(settings, "qa-token");
  assert.equal(push.pushed, 1, "应上传 1 组变更");
  assert.equal(push.remaining, 0, "同步后应无待办");
  assert.ok(labels.length > 0, "应回报同步进度");

  const committed = await dbV6.changeSets.where("state").equals("committed").count();
  assert.ok(committed >= 1, "变更应已提交到云端");
  const pendingAfter = await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingAfter, 0, "同步后本地无待办");

  // Third sync against the same mock state: nothing new to push, stays consistent.
  const again = await syncWithGitHub(settings, "qa-token");
  assert.equal(again.pushed, 0, "二次同步不应重复上传");
  assert.equal(again.remaining, 0);

  console.log("mock github backend sync contract passed");
} finally {
  await server.close();
  dbV6.close();
}
