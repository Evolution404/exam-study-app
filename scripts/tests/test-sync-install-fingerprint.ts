import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { downloadRemoteV7, installFingerprint, projectionNeedsInstall, syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { createGitHubV7Remote } from "../../src/lib/sync/github-v7-remote";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// 免重装 + 检查点缓存解耦套件（Part D 防回退）：
//   1. 纯函数：指纹只含检查点 digest + cursors（不含 generatedAt/分段 sha）；
//      projectionNeedsInstall 的四要素判定；
//   2. coalesce 免重装：A 触发 coalesce 重排分段 → B 同步不重装（无检查点 blob
//      请求、无全表写入），只补拉真正新增的事件分段；
//   3. 检查点更换（真压实）仍走全量重装路径；
//   4. 跨设备最终一致。

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-v7-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-v7-device-id") currentDeviceId = value;
    },
  },
});

// --- 1. 纯函数 --------------------------------------------------------------
{
  const checkpoint = { path: "sync/v7/checkpoints/ab.json", blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 10 };
  const base = { formatVersion: 7 as const, vaultId: "qa/vault@main", generatedAt: "2026-08-14T00:00:00.000Z", generation: 3, metadata: { vaultId: "qa/vault@main", producer: "t" }, checkpoint, segments: [], cursors: { "device-a": 5 } };
  const fingerprint = installFingerprint({ head: base });
  // generatedAt 变化 / 分段重排（coalesce）不改指纹。
  assert.equal(installFingerprint({ head: { ...base, generatedAt: "2026-08-15T09:00:00.000Z", segments: [{ ...checkpoint, generation: 4, ordinal: 0, count: 1, cursors: { "device-a": 5 }, metadata: { vaultId: "qa/vault@main", createdAt: "2026-08-15T09:00:00.000Z", producer: "t" } }] } }), fingerprint, "coalesce/时间戳变化不改安装指纹");
  // 检查点更换或游标前进才改。
  assert.notEqual(installFingerprint({ head: { ...base, checkpoint: { ...checkpoint, sha256: "c".repeat(64) } } }), fingerprint, "检查点更换必须改指纹");
  assert.notEqual(installFingerprint({ head: { ...base, cursors: { "device-a": 6 } } }), fingerprint, "游标前进必须改指纹");
  // 判定函数四要素。
  const cache = { head: base };
  assert.equal(projectionNeedsInstall(fingerprint, cache, 0, 0), false, "指纹一致且无新事件 → 免重装");
  assert.equal(projectionNeedsInstall(undefined, cache, 0, 0), true, "首次安装");
  assert.equal(projectionNeedsInstall("stale", cache, 0, 0), true, "指纹失配 → 重装");
  assert.equal(projectionNeedsInstall(fingerprint, cache, 3, 0), true, "有未见过事件 → 重装");
  assert.equal(projectionNeedsInstall(fingerprint, cache, 0, 2), true, "有 blocked 结果要持久化 → 重装");
}

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "fingerprint-vault", branch: "main", apiBaseUrl: server.url };
const sync = () => syncWithGitHub(settings, "qa-token");

function question(stem: string): Parameters<typeof createQuestionV7>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: ["甲", "乙", "丙", "丁"].map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    answer: "A",
    tags: ["指纹测试"],
  };
}

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV7Database();
}

async function currentHead() {
  const remote = createGitHubV7Remote({ owner: settings.owner, repo: settings.repo, token: "t", apiBaseUrl: server.url });
  const read = await remote.readHead();
  assert.ok(read.initialized);
  return read.head;
}

// --- 2. tier 判定（downloadRemoteV7 直接驱动）--------------------------------
async function remoteCacheEntry() {
  const entries = await dbV7.syncMeta.toArray();
  const entry = entries.find((item) => item.key.startsWith("v7:sync:checkpoint:"));
  assert.ok(entry, "应存在远端缓存条目");
  return entry.value as { cachedAt: string; checkpoint: { cursors: Record<string, number>; counts: Record<string, number> }; head: { head: { checkpoint: { sha256: string }; segments: Array<{ path: string }> } } };
}

await freshClient("device-a");
await sync();
const bank = await createBankV7("指纹题库");
// 24+ 次小同步积累分段，触发设备 A 的 coalesce（阈值 24 段）。
for (let round = 0; round < 26; round += 1) {
  await createQuestionV7(bank.id, question(`指纹测试第 ${round} 题`));
  await sync();
}
const coalescedHead = await currentHead();
const segmentGenerations = new Set(coalescedHead.segments.map((descriptor) => descriptor.generation));
assert.ok(coalescedHead.segments.length < 26, `coalesce 应把 26 个小段合并（实际 ${coalescedHead.segments.length} 段）`);
assert.ok(segmentGenerations.size >= 2, "合并后分段来自多个 generation（发生过重排）");

// 设备 B 同步一次建立缓存（折叠检查点 + 当时 head），随后 A 触发新一轮 coalesce。
await freshClient("device-b");
await sync();
assert.equal(await dbV7.questions.count(), 26, "设备 B 应拉到全部 26 题");
const bCached = await remoteCacheEntry();
const bCachedCheckpointSha = bCached.head.head.checkpoint.sha256;

// A 再积累 24+ 小段触发第二次 coalesce —— 检查点 descriptor 不变，分段全重排。
currentDeviceId = "device-a";
for (let round = 0; round < 26; round += 1) {
  await createQuestionV7(bank.id, question(`指纹二轮第 ${round} 题`));
  await sync();
}
const secondHead = await currentHead();
assert.equal(secondHead.checkpoint.sha256, bCachedCheckpointSha, "coalesce 不改检查点（前提）");
const overlap = secondHead.segments.filter((descriptor) => bCached.head.head.segments.some((old) => old.path === descriptor.path));
assert.ok(overlap.length < secondHead.segments.length, "重排后缓存分段路径大量失配（复现历史缺陷前提）");

// tier 1/2：用 B 的旧缓存对新 head 下载 —— 检查点零网络、分段按游标覆盖跳过。
const remote = createGitHubV7Remote({ owner: settings.owner, repo: settings.repo, token: "t", apiBaseUrl: server.url });
server.stats.blobReads = 0;
const incremental = await downloadRemoteV7(remote, secondHead, bCached as never);
assert.equal(incremental.reusedCache, true, "检查点未变 → 复用缓存基座");
assert.equal(server.stats.blobReads, secondHead.segments.filter((descriptor) => {
  const cursors = descriptor.cursors ?? {};
  const covered = Object.keys(cursors).length > 0 && Object.entries(cursors).every(([device, sequence]) => sequence <= (bCached.checkpoint.cursors[device] ?? -1));
  return !covered && !bCached.head.head.segments.some((old) => old.path === descriptor.path);
}).length, "blob 读取数 = 未被游标覆盖且路径失配的分段数（无检查点重取）");
// 增量下载到的事件都属于 A 的二轮写入。
assert.ok(incremental.changes.length >= 26, `应拉到二轮事件（实际 ${incremental.changes.length}）`);
// coalesce 混合页可同时含已覆盖与新事件（页游标取最大值），因此只要求新事件齐备。
const freshChanges = incremental.changes.filter((change) => change.localSequence > (bCached.checkpoint.cursors[change.deviceId] ?? 0));
assert.ok(freshChanges.length >= 26, `增量下载应包含全部二轮新事件（实际 ${freshChanges.length}）`);

// tier 3：检查点更换（真压实）→ 全量下载。~115 KB/题（低于 128 KiB 卸载阈值，
// 保持 inline），60 题 ≈ 7 MB > 4 MiB 触发压实。
const heavyBank = await createBankV7("压实题库");
for (let index = 0; index < 60; index += 1) {
  await createQuestionV7(heavyBank.id, {
    type: "单选",
    content: [{ id: `s-${index}`, type: "text", text: `压实第 ${index} 题：` + "重型题干内容。".repeat(5500) }],
    options: ["甲", "乙", "丙", "丁"].map((_, optionIndex) => [{ id: `o-${index}-${optionIndex}`, type: "text", text: `选项${optionIndex}` }]),
    answer: "A",
    tags: ["压实"],
  });
}
const compactResult = await sync();
const postCompactHead = await currentHead();
assert.ok(compactResult.compacted || postCompactHead.segments.length === 0, "重负载推送应触发压实");
assert.notEqual(postCompactHead.checkpoint.sha256, bCachedCheckpointSha, "压实必须更换检查点 descriptor");

server.stats.blobReads = 0;
const full = await downloadRemoteV7(remote, postCompactHead, bCached as never);
assert.equal(full.reusedCache, false, "检查点更换 → 缓存不可复用（全量路径）");
assert.ok(server.stats.blobReads >= 1, "必须重新下载检查点 blob");
assert.equal(full.changes.length, postCompactHead.segments.reduce((sum, descriptor) => sum + (descriptor.count ?? 0), 0), "全量路径重放所有分段事件");

// 最终一致性：B 全新拉取后数据完整。
await freshClient("device-b");
await sync();
const totalAfter = await dbV7.questions.count();
assert.ok(totalAfter >= 86, `B 应看到全部题目（实际 ${totalAfter}）`);

await server.close();
dbV7.close();
console.log("sync install fingerprint tests passed: 纯函数判定、coalesce 免重装（无检查点重取）、增量只补新分段、最终一致");
