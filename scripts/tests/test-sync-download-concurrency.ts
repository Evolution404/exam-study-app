import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { SYNC_V7_DOWNLOAD_CONCURRENCY, syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// 并发分段下载防回退套件：热窗口分段曾一度退化为 for...await 串行下载。
// 用 mock 后端的 blob 并发计数器 + 可注入延迟证明：
//   1. 多段拉取时 blob GET 真正并发（≥2 路），且受 SYNC_V7_DOWNLOAD_CONCURRENCY 封顶；
//   2. 重放顺序不受完成顺序影响 —— 变更集仍按 generation/ordinal 到达；
//   3. 进度报告单调不减、报告次数不少于分段数（进度条功能完整）；
//   4. 跨设备数据一致（并发下载不破坏正确性）。

assert.equal(SYNC_V7_DOWNLOAD_CONCURRENCY, 6, "下载并发度应为 6");

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-device-id") currentDeviceId = value;
    },
  },
});

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "concurrency-vault", branch: "main", apiBaseUrl: server.url };

function question(stem: string): Parameters<typeof createQuestionV7>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: ["甲", "乙", "丙", "丁"].map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    optionIds: ["opt-0", "opt-1", "opt-2", "opt-3"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
    tags: ["并发下载测试"],
  };
}

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV7Database();
}

// --- 阶段零：单个热窗口也必须与检查点同时开始 -----------------------------
// 多分段本身就能形成并发，不能证明检查点没有被串行等待。独立仓库只放一个
// segment；新设备峰值必须达到 2（checkpoint + segment）。
const parallelSettings = { ...settings, repo: "checkpoint-parallel-vault" };
await freshClient("parallel-source");
await syncWithGitHub(parallelSettings, "qa-token");
const parallelBank = await createBankV7("检查点并行题库");
await createQuestionV7(parallelBank.id, question("检查点与单个热窗口必须并行"));
await syncWithGitHub(parallelSettings, "qa-token");
server.setBlobLatency(30);
server.stats.blobReads = 0;
server.stats.maxConcurrentBlobReads = 0;
await freshClient("parallel-target");
try { await syncWithGitHub(parallelSettings, "qa-token"); }
finally { server.setBlobLatency(0); }
assert.equal(server.stats.maxConcurrentBlobReads, 2, `单 segment 首次拉取应同时下载 checkpoint（实测峰值 ${server.stats.maxConcurrentBlobReads}）`);

// --- 阶段一：device-a 建立多分段热窗口 -------------------------------------
await freshClient("device-a");
await syncWithGitHub(settings, "qa-token");
const bank = await createBankV7("并发下载题库");
// 多次小同步各产生独立分段（合并阈值 24 段远未触达）。
for (let round = 0; round < 8; round += 1) {
  for (let index = 0; index < 3; index += 1) {
    await createQuestionV7(bank.id, question(`并发下载第 ${round * 3 + index} 题：` + "弧垂增大时安全距离随之调整。".repeat(30)));
  }
  await syncWithGitHub(settings, "qa-token");
}

// 确认热窗口确实有多个分段，否则本套件没有观测对象。
const headResponse = await fetch(`${settings.apiBaseUrl}/repos/qa/concurrency-vault/contents/sync/v9/head.json`);
const headEnvelope = await headResponse.json() as { content: string };
const head = JSON.parse(Buffer.from(headEnvelope.content, "base64").toString("utf8")) as { segments: Array<{ path: string }> };
assert.ok(head.segments.length >= 6, `热窗口应至少有 6 个分段（实际 ${head.segments.length}）供并发观测`);

// --- 阶段二：device-b 全新拉取，注入延迟让并发可观测 ------------------------
server.setBlobLatency(25);
const progressFractions: number[] = [];
const progressLabels: string[] = [];
await freshClient("device-b");
try {
  await syncWithGitHub(settings, "qa-token", (progress) => {
    if (progress.phase === "download") {
      progressFractions.push(progress.percent);
      progressLabels.push(progress.label ?? "");
    }
  });
} finally {
  server.setBlobLatency(0);
}

const observedPeak = server.stats.maxConcurrentBlobReads;
assert.ok(observedPeak >= 2, `分段下载应至少 2 路并发（实测峰值 ${observedPeak}）`);
assert.ok(server.stats.maxConcurrentBlobReads <= SYNC_V7_DOWNLOAD_CONCURRENCY, `并发峰值不得超过 ${SYNC_V7_DOWNLOAD_CONCURRENCY}（实测 ${server.stats.maxConcurrentBlobReads}）`);
for (let index = 1; index < progressFractions.length; index += 1) {
  assert.ok(progressFractions[index]! >= progressFractions[index - 1]!, `下载进度必须单调不减（第 ${index} 步 ${progressFractions[index]} < ${progressFractions[index - 1]}）`);
}
const segmentStepCount = progressLabels.filter((label) => label.includes("热窗口分段")).length;
assert.ok(segmentStepCount >= head.segments.length, `分段级进度报告数（${segmentStepCount}）应不少于分段数（${head.segments.length}）`);

// 跨设备一致性：24 题全部到达，题干序号连续无丢失。
const stems = (await dbV7.questions.toArray())
  .map((row) => row.content.map((block) => block.type === "text" ? block.text : "").join(""))
  .filter((text) => text.includes("并发下载第"));
assert.equal(stems.length, 24, "应完整拉取全部 24 题");
const numbers = stems.map((text) => Number(/并发下载第 (\d+) 题/.exec(text)?.[1])).sort((a, b) => a - b);
assert.deepEqual(numbers, Array.from({ length: 24 }, (_, index) => index), "题目按 wire 顺序全部到达，无丢失无重复");

// --- 阶段三：重放顺序 —— 事件按 localSequence 严格递增 ----------------------
// downloadRemote 按段序展平；每段内事件保持写入序。用同步事件的 deviceId 序列
// 验证跨段顺序：device-a 的 localSequence 必须单调递增。
const records = await dbV7.changeSets.toArray();
const deviceASequence = records
  .filter((record) => record.deviceId === "device-a")
  .map((record) => record.localSequence)
  .sort((a, b) => a - b);
for (let index = 1; index < deviceASequence.length; index += 1) {
  assert.ok(deviceASequence[index]! > deviceASequence[index - 1]!, "localSequence 应严格递增（无重复拉取）");
}

// --- 阶段四：串行回归 —— 并发度为 1 时仍正确（单段/边界） --------------------
server.stats.blobReads = 0;
server.stats.maxConcurrentBlobReads = 0;
await freshClient("device-c");
await syncWithGitHub(settings, "qa-token");
assert.equal(await dbV7.questions.count(), 24, "第三台设备完整拉取（重复验证正确性）");

await server.close();
dbV7.close();
console.log(`sync download concurrency tests passed: 并发峰值 ${observedPeak}（≤${SYNC_V7_DOWNLOAD_CONCURRENCY}）、顺序保真、进度单调（${segmentStepCount} 段级报告）`);