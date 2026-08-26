import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, resetV7Database } from "../../src/lib/db/db-v7";
import { restoreFullHistoryFromGitHub, SYNC_V7_DOWNLOAD_CONCURRENCY, syncWithGitHub, type SyncProgress } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// 同步进度报告按当前 v7 协议重新设计后，进度必须是「工作量加权 + 单调不减 +
// 阶段终点 to」的。本测试在 mock 后端上跑真实的推送 / 多分段拉取 / 纯拉取 /
// 远端恢复四种运行，逐条断言报告序列的形状。

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
const settings = { owner: "qa", repo: "progress-vault", branch: "main", apiBaseUrl: server.url };

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV7Database();
}

function collector() {
  const reports: SyncProgress[] = [];
  return { reports, callback: (progress: SyncProgress) => reports.push({ ...progress }) };
}

function choice(stem: string): Parameters<typeof createQuestionV7>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: ["甲", "乙", "丙", "丁"].map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    optionIds: ["opt-0", "opt-1", "opt-2", "opt-3"],
    solution: { kind: "choice", correctOptionIds: ["opt-0"] },
    tags: ["进度测试"],
  };
}

function assertWellFormed(reports: SyncProgress[], name: string, minimumReports: number): void {
  assert.ok(reports.length >= minimumReports, `${name}：报告数量应 ≥ ${minimumReports}（实际 ${reports.length}）`);
  assert.ok(reports[0].percent <= 15, `${name}：首个报告应处于起点（实际 ${reports[0].percent}%）`);
  const last = reports.at(-1)!;
  assert.equal(last.percent, 100, `${name}：最终报告应为 100%`);
  assert.equal(last.phase, "complete", `${name}：最终阶段应为 complete`);
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    if (report.to !== undefined) assert.ok(report.to >= report.percent, `${name}：阶段终点 to（${report.to}）不得小于当前值（${report.percent}）`);
    if (index > 0) {
      assert.ok(report.percent >= reports[index - 1].percent, `${name}：第 ${index} 个报告回退 ${reports[index - 1].percent}% → ${report.percent}%`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: 初始化 + 推送运行（含 pending → upload 波段）
// ---------------------------------------------------------------------------
{
  server.reset();
  await freshClient("device-a");
  const init = collector();
  await syncWithGitHub(settings, "qa-token", init.callback);
  assertWellFormed(init.reports, "初始化", 3);

  const bank = await createBankV7("进度题库");
  await createQuestionV7(bank.id, choice("进度测试第 1 题"));
  await createQuestionV7(bank.id, choice("进度测试第 2 题"));
  const push = collector();
  await syncWithGitHub(settings, "qa-token", push.callback);
  assertWellFormed(push.reports, "推送", 6);
  assert.ok(push.reports.some((report) => report.phase === "upload"), "推送运行应包含 upload 阶段报告");
  assert.ok(push.reports.some((report) => /正在上传分段/.test(report.label)), "推送应逐分段报告上传进度");
  assert.ok(push.reports.some((report) => report.phase === "merge" && /归并本机待上传变更/.test(report.label)), "推送应报告本机变更归并进度");
  console.log(`scenario 1 passed: 推送 ${push.reports.length} 条报告，单调且含逐分段上传`);
}

// ---------------------------------------------------------------------------
// Scenario 2: 多分段拉取 — 新设备一次拉下多个热窗口分段
// ---------------------------------------------------------------------------
{
  const bankId = (await createBankV7("多段题库")).id;
  const smallSyncs = 5;
  for (let index = 0; index < smallSyncs; index += 1) {
    await createQuestionV7(bankId, choice(`多段拉取第 ${index + 1} 题`));
    await syncWithGitHub(settings, "qa-token");
  }
  await freshClient("device-b");
  const pull = collector();
  // 注入延迟让并发可观测：分段下载必须多路并发（防退化为 for...await 串行），
  // 且并发受 SYNC_V7_DOWNLOAD_CONCURRENCY 封顶。
  server.setBlobLatency(20);
  server.stats.blobReads = 0;
  server.stats.maxConcurrentBlobReads = 0;
  try {
    await syncWithGitHub(settings, "qa-token", pull.callback);
  } finally {
    server.setBlobLatency(0);
  }
  assert.ok(server.stats.maxConcurrentBlobReads >= 2, `多段拉取应并发下载（实测峰值 ${server.stats.maxConcurrentBlobReads}）`);
  assert.ok(server.stats.maxConcurrentBlobReads <= SYNC_V7_DOWNLOAD_CONCURRENCY, `并发峰值不得超过 ${SYNC_V7_DOWNLOAD_CONCURRENCY}`);
  assertWellFormed(pull.reports, "多分段拉取", 10);
  const segmentReports = pull.reports.filter((report) => report.phase === "download" && /热窗口分段/.test(report.label));
  assert.ok(segmentReports.length >= smallSyncs, `多分段拉取应逐分段报告下载（期望 ≥ ${smallSyncs}，实际 ${segmentReports.length}）`);
  // Within the download phase (real work, wall-clock long), consecutive
  // reports must advance gradually — no phase-sized jumps between segments.
  for (let index = 1; index < segmentReports.length; index += 1) {
    const delta = segmentReports[index].percent - segmentReports[index - 1].percent;
    assert.ok(delta <= 25, `多分段拉取：相邻分段报告跳变应 ≤ 25%（实际 ${delta}%）`);
  }
  assert.ok(pull.reports.some((report) => report.phase === "merge" && /回放远端变更/.test(report.label)), "拉取应报告远端回放进度");
  assert.ok(pull.reports.some((report) => report.phase === "merge" && /(比较本机数据|更新题目|更新作答记录|本机增量更新完成)/.test(report.label)), "拉取应报告本机增量更新进度");
  assert.ok(pull.reports.some((report) => report.phase === "merge" && /(更新题目|更新作答记录|本机增量更新完成)/.test(report.label) && /（\d+\/\d+）/.test(report.label)), "拉取应透传本机 reconcile 的真实 completed/total 进度");
  console.log(`scenario 2 passed: 多分段拉取 ${pull.reports.length} 条报告，下载分段级报告 ${segmentReports.length} 条，并发峰值 ${server.stats.maxConcurrentBlobReads}`);
}

// ---------------------------------------------------------------------------
// Scenario 3: 纯拉取（无本机变更）— 不预留上传波段
// ---------------------------------------------------------------------------
{
  const idle = collector();
  await syncWithGitHub(settings, "qa-token", idle.callback);
  assertWellFormed(idle.reports, "纯拉取", 3);
  assert.ok(!idle.reports.some((report) => report.phase === "upload"), "纯拉取不应报告 upload 阶段");
  assert.ok(idle.reports.some((report) => report.phase === "download" && report.to !== undefined), "下载阶段应携带终点 to 供前端爬升");
  console.log(`scenario 3 passed: 纯拉取 ${idle.reports.length} 条报告，无 upload 阶段`);
}

// ---------------------------------------------------------------------------
// Scenario 4: 远端恢复 — 同样逐分段、单调、到 100
// ---------------------------------------------------------------------------
{
  await freshClient("device-c");
  const restore = collector();
  await restoreFullHistoryFromGitHub(settings, "qa-token", restore.callback);
  assertWellFormed(restore.reports, "远端恢复", 8);
  assert.ok(restore.reports.some((report) => report.phase === "download" && /热窗口分段/.test(report.label)), "远端恢复应逐分段报告下载");
  // 新上传的 descriptor 携带 storedSize → 下载前即显示实际/解压后双尺寸。
  assert.ok(restore.reports.some((report) => report.phase === "download" && /正在下载检查点（实际 [\d.]+ MB \/ 解压后 [\d.]+ MB）/.test(report.label ?? "")), `下载检查点应显示实际与解压后双尺寸（实际标签：${restore.reports.find((report) => /正在下载检查点/.test(report.label ?? ""))?.label}）`);
  console.log(`scenario 4 passed: 远端恢复 ${restore.reports.length} 条报告`);
}

console.log("sync progress tests passed");
await server.close();
process.exit(0);