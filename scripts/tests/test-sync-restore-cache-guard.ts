import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { restoreLastRemoteCache, syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => memoryLocalStorage.set(key, value),
    removeItem: (key: string) => memoryLocalStorage.delete(key),
  },
});

const server = await startMockGitHubServer({ cas: true });
try {
  const settings = { owner: "qa", repo: "restore-guard-vault", branch: "main", apiBaseUrl: server.url };
  await resetV7Database();
  const syncedBank = await createBankV7("已同步题库");
  await createQuestionV7(syncedBank.id, {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: "已同步的题目？" }],
    options: [[{ id: "opt-0", type: "text", text: "是" }], [{ id: "opt-1", type: "text", text: "否" }]],
    optionIds: ["opt-0", "opt-1"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
    tags: [],
  });
  await syncWithGitHub(settings, "qa-token");

  // 产生一组未同步的本地修改。本地恢复的用途就是丢弃待同步事件、回滚到
  // 最后一次成功同步的状态（两个入口都有危险色确认弹窗明示放弃），因此
  // 恢复必须直接放行，而不是被未同步变更拦下导致功能不可用。
  await createBankV7("未同步题库");
  const pendingBefore = await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingBefore, 1, "前置条件：应存在 1 组未同步变更");

  const result = await restoreLastRemoteCache(settings);
  assert.equal(result.counts.questions >= 1, true, "本地恢复应返回缓存的题目数量");

  const pendingAfter = await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingAfter, 0, "本地恢复应清空待同步事件（丢弃是功能语义）");

  const bankNames = (await dbV7.banks.toArray()).map((bank) => bank.name);
  assert.ok(bankNames.includes("已同步题库"), "恢复后应回到缓存中的已同步题库");
  assert.ok(!bankNames.includes("未同步题库"), "未同步题库应随待同步事件一起被丢弃");

  console.log("sync restore cache discard tests passed");
} finally {
  await server.close();
  dbV7.close();
}
