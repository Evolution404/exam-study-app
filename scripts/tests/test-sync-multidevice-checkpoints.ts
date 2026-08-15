import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV6, createQuestionV6, dbV6, resetV6Database, saveNoteV6 } from "../../src/lib/db/db-v6";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// 用 Map 实现一个最简单的 localStorage stub，模拟浏览器持久化，
// 并让测试可以切换设备 id（删除 shijuan-study-v6-device-id 后重新生成）。
const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

const server = await startMockGitHubServer();
try {
  const settings = { owner: "qa", repo: "multidevice-checkpoint-vault", branch: "main", apiBaseUrl: server.url };
  const token = "qa-token";

  // ===== 设备 A：初始化并生成第一个检查点 =====
  await resetV6Database();
  const bank = await createBankV6("多设备检查点题库");
  const questionIds: string[] = [];
  for (let index = 1; index <= 36; index += 1) {
    const question = await createQuestionV6(bank.id, {
      type: "单选",
      stem: `设备 A 基础题目 ${index}`,
      options: ["选项一", "选项二", "选项三", "选项四"],
      answer: "A",
    });
    questionIds.push(question.id);
  }
  const firstSync = await syncWithGitHub(settings, token);
  assert.equal(firstSync.formatVersion, 7, "初始化同步应返回 v7 协议版本");
  assert.equal(firstSync.remaining, 0, "初始化后应无待同步变更");
  assert.ok(server.contentPaths().filter((path) => path.startsWith("sync/v7/checkpoints/")).length >= 1, "初始化后应存在至少一个检查点");

  // ===== 设备 A：写入 24 条大解析，制造热窗口溢出，生成第二个检查点 =====
  const largeNote = "x".repeat(120 * 1024);
  for (const questionId of questionIds) {
    await saveNoteV6(questionId, `${questionId}:${largeNote}`);
  }
  const pendingBeforeCompaction = await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingBeforeCompaction, 36, "36 道题应分别产生 36 条待同步解析变更");

  const secondSync = await syncWithGitHub(settings, token);
  assert.equal(secondSync.pushed, 36, "第二次同步应上传 36 条解析变更");
  assert.equal(secondSync.remaining, 0, "压缩后应无待同步变更");
  assert.equal(secondSync.compacted, true, "热窗口超过 4 MiB 应生成第二个检查点");
  const checkpointPaths = server.contentPaths().filter((path) => path.startsWith("sync/v7/checkpoints/"));
  assert.ok(checkpointPaths.length >= 2, `远端应至少存在两个检查点，实际 ${checkpointPaths.length} 个`);
  assert.notEqual(checkpointPaths[0], checkpointPaths[1], "两个检查点路径应不同");

  // ===== 设备 B：空库首次同步，应拉取最新检查点 =====
  memoryLocalStorage.delete("shijuan-study-v6-device-id");
  await resetV6Database();
  const deviceBFirstSync = await syncWithGitHub(settings, token);
  assert.equal(deviceBFirstSync.remaining, 0, "设备 B 拉取后应无待同步变更");
  assert.equal(await dbV6.banks.count(), 1, "设备 B 应同步到 1 个题库");
  assert.equal(await dbV6.questions.count(), 36, "设备 B 应同步到 36 道题");
  assert.equal(await dbV6.notes.count(), 36, "设备 B 应同步到 36 条解析");

  // ===== 设备 B：新增一道题并推送 =====
  const deviceBBank = await dbV6.banks.toCollection().first();
  assert.ok(deviceBBank, "设备 B 应存在题库");
  await createQuestionV6(deviceBBank.id, {
    type: "单选",
    stem: "设备 B 新增题目",
    options: ["选项一", "选项二", "选项三", "选项四"],
    answer: "B",
  });
  const deviceBPush = await syncWithGitHub(settings, token);
  assert.equal(deviceBPush.pushed, 1, "设备 B 应推送 1 条新增题目变更");
  assert.equal(deviceBPush.remaining, 0, "设备 B 推送后应无待同步变更");

  // ===== 设备 A：再次同步，收敛设备 B 的新题目 =====
  await syncWithGitHub(settings, token);
  assert.equal(await dbV6.questions.count(), 37, "设备 A 最终应有 37 道题");
  assert.equal(await dbV6.notes.count(), 36, "设备 A 的解析数不应被设备 B 覆盖");
  assert.equal(await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count(), 0, "设备 A 最终应无待同步变更");

  console.log("sync multidevice checkpoint tests passed: 两个检查点、跨设备拉取、推送与收敛");
} finally {
  await server.close();
  dbV6.close();
}
