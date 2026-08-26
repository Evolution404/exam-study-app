import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, resetV7Database, saveNoteV7, updateBankV7 } from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// 用 Map 实现一个最简单的 localStorage stub，模拟浏览器持久化，
// 并让测试可以切换设备 id（删除 shijuan-study-device-id 后重新生成）。
const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

function switchDevice(deviceId?: string) {
  if (deviceId) memoryLocalStorage.set("shijuan-study-device-id", deviceId);
  else memoryLocalStorage.delete("shijuan-study-device-id");
  return resetV7Database();
}

function choiceQuestion(stem: string, correctIndex = 0): Parameters<typeof createQuestionV7>[1] {
  const optionIds = ["opt-0", "opt-1", "opt-2", "opt-3"];
  return {
    type: "单选",
    stem,
    options: ["选项一", "选项二", "选项三", "选项四"],
    optionIds,
    solution: { kind: "choice", correctOptionIds: [optionIds[correctIndex]!] },
  };
}

async function fetchWithOneHeadPutConflict(): Promise<typeof fetch> {
  let injected = false;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : String((input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!injected && method === "PUT" && url.includes("/sync/v9/head.json")) {
      injected = true;
      return new Response(JSON.stringify({ message: "Conflict" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return fetch(input as RequestInfo | URL, init);
  };
}

const server = await startMockGitHubServer({ cas: true });
try {
  const settings = { owner: "qa", repo: "multidevice-checkpoint-vault", branch: "main", apiBaseUrl: server.url };
  const token = "qa-token";

  // ===== 设备 A：初始化并生成第一个检查点 =====
  await resetV7Database();
  const bank = await createBankV7("多设备检查点题库");
  const questionIds: string[] = [];
  for (let index = 1; index <= 36; index += 1) {
    const question = await createQuestionV7(bank.id, choiceQuestion(`设备 A 基础题目 ${index}`));
    questionIds.push(question.id);
  }
  const deviceAId = memoryLocalStorage.get("shijuan-study-device-id") ?? "device-a";
  const firstSync = await syncWithGitHub(settings, token);
  assert.equal(firstSync.formatVersion, 9, "初始化同步应返回 v9 协议版本");
  assert.equal(firstSync.remaining, 0, "初始化后应无待同步变更");
  assert.ok(server.contentPaths().filter((path) => path.startsWith("sync/v9/checkpoints/")).length >= 1, "初始化后应存在至少一个检查点");

  // ===== 设备 A：写入 36 条大解析，制造热窗口溢出，生成第二个检查点 =====
  const largeNote = "x".repeat(120 * 1024);
  for (const questionId of questionIds) {
    await saveNoteV7(questionId, `${questionId}:${largeNote}`);
  }
  const pendingBeforeCompaction = await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingBeforeCompaction, 36, "36 道题应分别产生 36 条待同步解析变更");

  const secondSync = await syncWithGitHub(settings, token);
  assert.equal(secondSync.pushed, 36, "第二次同步应上传 36 条解析变更");
  assert.equal(secondSync.remaining, 0, "压缩后应无待同步变更");
  assert.equal(secondSync.compacted, true, "热窗口超过 4 MiB 应生成第二个检查点");
  const checkpointPaths = server.contentPaths().filter((path) => path.startsWith("sync/v9/checkpoints/"));
  assert.ok(checkpointPaths.length >= 2, `远端应至少存在两个检查点，实际 ${checkpointPaths.length} 个`);
  assert.notEqual(checkpointPaths[0], checkpointPaths[1], "两个检查点路径应不同");

  // ===== 设备 B：空库首次同步，应拉取最新检查点 =====
  await switchDevice();
  const deviceBFirstSync = await syncWithGitHub(settings, token);
  assert.equal(deviceBFirstSync.remaining, 0, "设备 B 拉取后应无待同步变更");
  assert.equal(await dbV7.banks.count(), 1, "设备 B 应同步到 1 个题库");
  assert.equal(await dbV7.questions.count(), 36, "设备 B 应同步到 36 道题");
  assert.equal(await dbV7.notes.count(), 36, "设备 B 应同步到 36 条解析");
  const deviceBId = memoryLocalStorage.get("shijuan-study-device-id") ?? "device-b";

  // ===== 设备 B：新增一道题并推送 =====
  const deviceBBank = await dbV7.banks.toCollection().first();
  assert.ok(deviceBBank, "设备 B 应存在题库");
  await createQuestionV7(deviceBBank.id, choiceQuestion("设备 B 新增题目", 1));
  const deviceBPush = await syncWithGitHub(settings, token);
  assert.equal(deviceBPush.pushed, 1, "设备 B 应推送 1 条新增题目变更");
  assert.equal(deviceBPush.remaining, 0, "设备 B 推送后应无待同步变更");

  // ===== 设备 A：再次同步，收敛设备 B 的新题目 =====
  await switchDevice(deviceAId);
  await syncWithGitHub(settings, token);
  assert.equal(await dbV7.questions.count(), 37, "设备 A 最终应有 37 道题");
  assert.equal(await dbV7.notes.count(), 36, "设备 A 的解析数不应被设备 B 覆盖");
  assert.equal(await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count(), 0, "设备 A 最终应无待同步变更");

  // ===== 设备 C：空库首次同步，应拉取两个检查点之后的最新状态 =====
  await switchDevice();
  await syncWithGitHub(settings, token);
  assert.equal(await dbV7.banks.count(), 1, "设备 C 应同步到 1 个题库");
  assert.equal(await dbV7.questions.count(), 37, "设备 C 应同步到 37 道题");
  assert.equal(await dbV7.notes.count(), 36, "设备 C 应同步到 36 条解析");
  const deviceCId = memoryLocalStorage.get("shijuan-study-device-id") ?? "device-c";

  // ===== A/B/C 依次产生本地事件并同步，后两台设备会遇到 CAS 冲突 =====
  async function renameBankOnCurrentDevice(name: string): Promise<void> {
    const currentBank = await dbV7.banks.toCollection().first();
    assert.ok(currentBank, "当前设备应存在题库");
    await updateBankV7(currentBank.id, { name });
  }

  // A：先同步建立自己的本地基线，再产生一条题库改名事件，然后正常推送。
  await switchDevice(deviceAId);
  await syncWithGitHub(settings, token);
  await renameBankOnCurrentDevice("A 并发题库名");
  assert.equal(await dbV7.changeSets.where("state").equals("pending").count(), 1, "设备 A 推送前应有 1 条待同步变更");
  const pushA = await syncWithGitHub(settings, token);
  assert.equal(pushA.pushed, 1, "设备 A 应推送 1 条并发变更");
  assert.equal(pushA.remaining, 0, "设备 A 推送后应无待同步变更");
  assert.equal((await dbV7.banks.toCollection().first())?.name, "A 并发题库名", "设备 A 推送后题库名应为本地方案");

  // B：同步恢复自身数据，再产生题库改名事件；第一次 head PUT 注入 409，应 rebase 后重试成功。
  await switchDevice(deviceBId);
  await syncWithGitHub(settings, token);
  await renameBankOnCurrentDevice("B 并发题库名");
  assert.equal(await dbV7.changeSets.where("state").equals("pending").count(), 1, "设备 B 推送前应有 1 条待同步变更");
  let bConflictCount = 0;
  const bFetch = await fetchWithOneHeadPutConflict();
  const countingB = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await bFetch(input, init);
    if (response.status === 409) bConflictCount += 1;
    return response;
  };
  const pushB = await syncWithGitHub(settings, token, undefined, { fetch: countingB as typeof fetch });
  assert.equal(bConflictCount, 1, "设备 B 首次 head PUT 应恰好收到一次 409 冲突");
  assert.equal(pushB.pushed, 1, "设备 B 冲突重试后应推送 1 条变更");
  assert.equal(pushB.remaining, 0, "设备 B 推送后应无待同步变更");
  assert.equal((await dbV7.banks.toCollection().first())?.name, "B 并发题库名", "设备 B 应 rebase 后写回自己的题库名");

  // C：同样恢复自身数据并产生题库改名事件，注入 409 后应 rebase 并推送。
  await switchDevice(deviceCId);
  await syncWithGitHub(settings, token);
  await renameBankOnCurrentDevice("C 并发题库名");
  assert.equal(await dbV7.changeSets.where("state").equals("pending").count(), 1, "设备 C 推送前应有 1 条待同步变更");
  let cConflictCount = 0;
  const cFetch = await fetchWithOneHeadPutConflict();
  const countingC = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await cFetch(input, init);
    if (response.status === 409) cConflictCount += 1;
    return response;
  };
  const pushC = await syncWithGitHub(settings, token, undefined, { fetch: countingC as typeof fetch });
  assert.equal(cConflictCount, 1, "设备 C 首次 head PUT 应恰好收到一次 409 冲突");
  assert.equal(pushC.pushed, 1, "设备 C 冲突重试后应推送 1 条变更");
  assert.equal(pushC.remaining, 0, "设备 C 推送后应无待同步变更");
  assert.equal((await dbV7.banks.toCollection().first())?.name, "C 并发题库名", "设备 C 应 rebase 后写回自己的题库名");

  // ===== 三设备最终收敛 =====
  const finalNames: string[] = [];
  for (const [label, deviceId] of [["A", deviceAId], ["B", deviceBId], ["C", deviceCId]] as const) {
    await switchDevice(deviceId);
    await syncWithGitHub(settings, token);
    const bankName = (await dbV7.banks.toCollection().first())?.name ?? "";
    assert.equal(await dbV7.questions.count(), 37, `设备 ${label} 最终应有 37 道题`);
    assert.equal(await dbV7.notes.count(), 36, `设备 ${label} 解析数应保持 36`);
    assert.equal(await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count(), 0, `设备 ${label} 最终应无待同步变更`);
    finalNames.push(bankName);
  }
  assert.equal(finalNames[0], "C 并发题库名", "设备 A 最终应收敛到设备 C 的题库名");
  assert.equal(finalNames[1], "C 并发题库名", "设备 B 最终应收敛到设备 C 的题库名");
  assert.equal(finalNames[2], "C 并发题库名", "设备 C 最终应保持自己的题库名");

  console.log("sync multidevice checkpoint tests passed: 两个检查点、设备 C 拉取、三设备 CAS 冲突重试与最终收敛");
} finally {
  await server.close();
  dbV7.close();
}
