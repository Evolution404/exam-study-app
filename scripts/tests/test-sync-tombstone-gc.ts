import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV6, createQuestionV6, dbV6, deleteQuestionsV6, resetV6Database } from "../../lib/db-v6";
import {
  SYNC_V7_DEVICE_RETIRE_DAYS,
  reclaimableTombstonesV7,
  syncWithGitHub,
} from "../../lib/github-sync-v7";
import { createGitHubV7Remote } from "../../lib/github-v7-remote";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";
import type { TombstoneV6 } from "../../lib/v6-types";

// 墓碑因果稳定回收套件（Part H）：
//   1. 判定单元 —— 全确认可回收 / 任一未确认保留 / 未上报保守保留 / 失联退役剔除；
//   2. 压实 GC 集成 —— A 删除 → B/C 各同步（水位前进）→ 压实 → 墓碑从新检查点消失，
//      新设备拉取后删除状态保持；
//   3. 复活防护回归 —— C 持有早于删除的 pending 编辑未同步 → 墓碑因 C 未确认而保留；
//      C 上线同步 → pending 被 rejectTombstoned 拦截（blocked），题目不复活；
//   4. 水位写入 —— 纯拉取且游标前进 → devices 表更新；空闲同步零 head 写入；
//   5. H5 导入即删抵消 —— 创建事件仍在 pending 未推送 → 删除零墓碑零事件；
//      已推送场景仍写墓碑；
//   6. 迁移清空存量墓碑（G 套件覆盖实现，这里断言远端无 sequence 的旧墓碑保守保留）。

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-v6-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-v6-device-id") currentDeviceId = value;
    },
  },
});

function tombstone(deviceId: string, sequence: number): TombstoneV6 {
  return { key: `question:q-${sequence}`, entityType: "question", entityId: `q-${sequence}`, deletedAt: "2026-08-01T00:00:00.000Z", deviceId, eventId: `e-${sequence}`, sequence };
}

const NOW = "2026-08-14T00:00:00.000Z";

// --- 1. 判定单元 ------------------------------------------------------------
{
  const tomb = tombstone("device-a", 10);
  // 全确认 → 可回收。
  assert.deepEqual(
    reclaimableTombstonesV7([tomb], { devices: { "device-b": { cursors: { "device-a": 10 }, syncedAt: NOW }, "device-c": { cursors: { "device-a": 99 }, syncedAt: NOW } }, headCursors: { "device-a": 12 }, selfDeviceId: "device-a", now: NOW }),
    { keep: [], dropped: 1 },
    "所有已知设备水位 ≥ 墓碑序号 → 可回收",
  );
  // 任一未确认 → 保留。
  assert.deepEqual(
    reclaimableTombstonesV7([tomb], { devices: { "device-b": { cursors: { "device-a": 10 }, syncedAt: NOW }, "device-c": { cursors: { "device-a": 9 }, syncedAt: NOW } }, headCursors: { "device-a": 12 }, selfDeviceId: "device-a", now: NOW }).keep,
    [tomb],
    "任一设备水位未达 → 保留",
  );
  // 未上报水位的设备（仅出现在 cursors 键里）→ 保守保留。
  assert.deepEqual(
    reclaimableTombstonesV7([tomb], { devices: { "device-b": { cursors: { "device-a": 10 }, syncedAt: NOW } }, headCursors: { "device-a": 12, "device-x": 5 }, selfDeviceId: "device-a", now: NOW }).keep,
    [tomb],
    "未上报水位的设备视为未确认 → 保留",
  );
  // 失联超期（退役）→ 从判定集合剔除后可回收。
  const stale = new Date(Date.parse(NOW) - (SYNC_V7_DEVICE_RETIRE_DAYS + 1) * 86_400_000).toISOString();
  assert.deepEqual(
    reclaimableTombstonesV7([tomb], { devices: { "device-b": { cursors: { "device-a": 10 }, syncedAt: NOW }, "device-c": { cursors: { "device-a": 1 }, syncedAt: stale } }, headCursors: { "device-a": 12 }, selfDeviceId: "device-a", now: NOW }),
    { keep: [], dropped: 1 },
    "失联设备从判定集合剔除 → 可回收",
  );
  // 90 天内活跃的慢设备仍阻塞。
  assert.deepEqual(
    reclaimableTombstonesV7([tomb], { devices: { "device-c": { cursors: { "device-a": 1 }, syncedAt: new Date(Date.parse(NOW) - (SYNC_V7_DEVICE_RETIRE_DAYS - 1) * 86_400_000).toISOString() } }, headCursors: {}, selfDeviceId: "device-a", now: NOW }).keep,
    [tomb],
    "90 天内活跃设备仍阻塞回收",
  );
  // 无序号锚（legacy）→ 永远保留。
  const legacy = { ...tomb, sequence: undefined } as unknown as TombstoneV6;
  assert.deepEqual(
    reclaimableTombstonesV7([legacy], { devices: { "device-b": { cursors: { "device-a": 1e9 }, syncedAt: NOW } }, headCursors: {}, selfDeviceId: "device-a", now: NOW }).keep,
    [legacy],
    "无序号的旧墓碑保守保留",
  );
}

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "tombstone-gc-vault", branch: "main", apiBaseUrl: server.url };
const sync = () => syncWithGitHub(settings, "qa-token");

function question(stem: string): Parameters<typeof createQuestionV6>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: ["甲", "乙", "丙", "丁"].map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    answer: "A",
    tags: ["墓碑测试"],
  };
}

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV6Database();
}

async function currentHead() {
  const remote = createGitHubV7Remote({ owner: settings.owner, repo: settings.repo, token: "t", apiBaseUrl: server.url });
  const read = await remote.readHead();
  assert.ok(read.initialized);
  return read.head;
}

async function remoteCheckpointTombstones(): Promise<TombstoneV6[]> {
  const head = await currentHead();
  if (!head.checkpoint) return [];
  const response = await fetch(`${settings.apiBaseUrl}/repos/qa/tombstone-gc-vault/git/blobs/${head.checkpoint.blobSha}`, { headers: { accept: "application/vnd.github.raw+json" } });
  const { inflateSync } = await import("node:zlib");
  const raw = Buffer.from(await response.arrayBuffer());
  const text = raw[0] === 0x78 ? inflateSync(raw).toString("utf8") : raw.toString("utf8");
  const checkpoint = JSON.parse(text) as { state: { tombstones: TombstoneV6[] } };
  return checkpoint.state.tombstones;
}

// --- 2/3/4. 集成：A 删除 → 水位 → 压实 GC → 复活防护 -------------------------
await freshClient("device-a");
await sync();
const bank = await createBankV6("墓碑题库");
// 建足够体量：一题会被 A 删除且 B/C 都已拉过；另一题承载 C 的 pending 编辑。
for (let index = 0; index < 4; index += 1) await createQuestionV6(bank.id, question(`墓碑测试第 ${index} 题`));
await sync();

// B、C 各拉一次（它们的 installedCursors 将覆盖 A 的创建事件，但还没见到删除）。
await freshClient("device-b");
await sync();
await freshClient("device-c");
await sync();

// A 删除第 0 题（此时该题创建事件已推送 → 正常写墓碑）。
currentDeviceId = "device-a";
const allQuestions = await dbV6.questions.toArray();
const doomed = allQuestions.find((row) => row.content.some((block) => block.type === "text" && block.text.includes("第 0 题")));
assert.ok(doomed, "应定位被删题");
await deleteQuestionsV6([doomed.id]);
assert.equal(await dbV6.tombstones.count(), 2, "已推送的删除应写题目+关系两条墓碑");
await sync();
assert.ok((await remoteCheckpointTombstones()).length === 0, "删除后墓碑只在热事件里，还没进检查点");

// --- 4. 水位写入：B 纯拉取（游标前进）→ devices 表出现 B 的水位 ---------------
await freshClient("device-b");
await sync();
const headAfterB = await currentHead();
assert.ok(headAfterB.devices?.["device-b"], "B 拉取删除后应在 head.devices 上报水位");
assert.ok((headAfterB.devices?.["device-b"]?.cursors["device-a"] ?? 0) >= 1, "B 的水位应覆盖 A 的删除序号");
// 空闲同步：无新事件 → 不再写 head（水位未前进，零写入）。
const headBlobShaBefore = (await createGitHubV7Remote({ owner: settings.owner, repo: settings.repo, token: "t", apiBaseUrl: server.url }).readHead()).cache?.blobSha;
await sync();
const headBlobShaAfter = (await createGitHubV7Remote({ owner: settings.owner, repo: settings.repo, token: "t", apiBaseUrl: server.url }).readHead()).cache?.blobSha;
assert.equal(headBlobShaAfter, headBlobShaBefore, "空闲同步（水位未前进）不得写 head");

// --- 3. 复活防护：C 持有早于删除的 pending 编辑、未同步 ------------------------
await freshClient("device-c");
await sync();
// C 本地对被删题做一次「编辑」（先恢复旧状态再入队 pending）：
// 直接注入一条 pending 的 question.upsert（模拟离线编辑）。
const { createChangeSetV7 } = await import("../../lib/change-set-v7");
const staleEdit = await createChangeSetV7({
  deviceId: "device-c",
  localSequence: 1,
  createdAt: "2026-08-13T00:00:00.000Z",
  mutations: [{ kind: "question.upsert", question: { ...doomed, tags: ["离线编辑"], updatedAt: "2026-08-13T00:00:00.000Z" } }],
});
await dbV6.changeSets.put({ ...staleEdit, state: "pending" });
// C 同步：pending 与远端删除冲突 → blocked，不复活。
const cResult = await sync();
const blockedRecords = await dbV6.changeSets.where("state").equals("blocked").toArray();
assert.ok(blockedRecords.length >= 1, "陈旧编辑应被墓碑拦截为 blocked");
assert.equal(await dbV6.questions.count(), 3, "被删题不得复活（只剩 3 题）");
assert.ok(cResult.remaining >= 1, "同步结果应报告待处理操作");

// --- 2. 压实 GC：所有设备水位确认后，墓碑从新检查点消失 -----------------------
// 触发压实：A 推送 ~115KB/题 × 60 inline 超过 4 MiB。
currentDeviceId = "device-a";
const heavyBank = await createBankV6("压实墓碑题库");
for (let index = 0; index < 60; index += 1) {
  await createQuestionV6(heavyBank.id, {
    type: "单选",
    content: [{ id: `s-${index}`, type: "text", text: `压实墓碑第 ${index} 题：` + "重型题干内容。".repeat(5500) }],
    options: [[{ id: "a", type: "text", text: "甲" }]],
    answer: "A",
    tags: [],
  });
}
const compactResult = await sync();
assert.ok(compactResult.compacted, "重负载推送应触发压实");
// C 的水位（拉取删除那次同步）已覆盖删除序号；B 也已上报 → GC 条件满足。
const checkpointTombstones = await remoteCheckpointTombstones();
assert.equal(checkpointTombstones.length, 0, `压实后检查点不应再含已确认墓碑（实际 ${checkpointTombstones.length}）`);

// 新设备拉取：删除状态保持（第 0 题不出现，其余 3+60 题到达）。
await freshClient("device-d");
await sync();
const stems = (await dbV6.questions.toArray()).map((row) => row.content.map((block) => block.type === "text" ? block.text : "").join(""));
assert.ok(!stems.some((text) => text.includes("墓碑测试第 0 题")), "新设备不得看到已删除的题");
assert.ok(stems.some((text) => text.includes("墓碑测试第 1 题")), "其余题目正常到达");
assert.ok(stems.some((text) => text.includes("压实墓碑第 0 题")), "压实题库到达");

// --- 5. H5 导入即删抵消 ------------------------------------------------------
await freshClient("device-e");
await sync();
const importBank = await createBankV6("导入即删题库");
const created: string[] = [];
for (let index = 0; index < 5; index += 1) {
  const join = await createQuestionV6(importBank.id, question(`导入即删第 ${index} 题`));
  created.push(join.id);
}
// 未同步（创建事件仍 pending）就删除。
await deleteQuestionsV6(created);
assert.equal(await dbV6.tombstones.count(), 0, "导入即删（未推送）应零墓碑");
const pendingAfterOffset = await dbV6.changeSets.where("state").equals("pending").toArray();
assert.ok(!pendingAfterOffset.some((record) => record.mutations.some((mutation) => mutation.kind === "question.bulk.delete")), "导入即删不入队删除事件");
// 推送后远端零删除事件：新设备看不到这 5 题，也没有墓碑。
await sync();
await freshClient("device-f");
await sync();
const eStems = (await dbV6.questions.toArray()).map((row) => row.content.map((block) => block.type === "text" ? block.text : "").join(""));
assert.ok(!eStems.some((text) => text.includes("导入即删")), "抵消后远端从未见过这些题");
assert.equal(await dbV6.tombstones.count(), 0, "抵消场景远端零墓碑到达");

await server.close();
dbV6.close();
console.log("sync tombstone gc tests passed: 判定单元、压实回收、复活防护（blocked）、水位写入与零空闲写、导入即删抵消");
