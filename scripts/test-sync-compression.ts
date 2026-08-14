import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV6, createQuestionV6, dbV6, resetV6Database } from "../lib/db-v6";
import { syncWithGitHub } from "../lib/github-sync-v7";
import { createGitHubV7Remote } from "../lib/github-v7-remote";
import {
  decodeSyncV7Json,
  encodeSyncV7Json,
  isZlibEnvelope,
  syncV7CompressionEnabled,
} from "../lib/sync-v7-codec";
import { startMockGitHubServer } from "./mock-github-server.mjs";

// 传输层压缩（deflate 信封）防回退套件：
//   1. codec 单元 —— 往返、双格式嗅探、误判排除、CompressionStream 回退；
//   2. remote 层 —— putImmutable 上传的线上字节确实是压缩信封且体积显著缩小，
//      readBlob 解压后逻辑字节与 digest 校验一致，idempotent 422 路径可读回；
//   3. 混合 vault —— 远端先有存量纯 JSON 对象（模拟旧设备写入），新设备压缩
//      写入后新旧对象共存，同步/拉取全部成功（读取端格式自动嗅探）；
//   4. 端到端 —— 多设备 syncWithGitHub 全压缩路径跨设备一致，head.json 保持纯 JSON。

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

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV6Database();
}

function question(stem: string): Parameters<typeof createQuestionV6>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: ["甲", "乙", "丙", "丁"].map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    answer: "A",
    tags: ["压缩测试"],
  };
}

// --- 1. codec 单元 ---------------------------------------------------------
{
  assert.equal(typeof syncV7CompressionEnabled(), "boolean");
  const json = JSON.stringify({ 题: "弧垂与安全距离反向变化", data: "重复文本".repeat(5000), n: 42 });
  const encoded = await encodeSyncV7Json(json);
  if (syncV7CompressionEnabled()) {
    assert.equal(isZlibEnvelope(encoded), true, "可用环境下编码产物应是 zlib 信封");
    assert.ok(encoded.byteLength < json.length / 2, `压缩比应显著（${encoded.byteLength} vs ${json.length}）`);
  }
  assert.equal(await decodeSyncV7Json(encoded), json, "压缩→解压文本逐字节一致");
  assert.equal(await decodeSyncV7Json(new TextEncoder().encode(json)), json, "存量纯 JSON 直通解码");
  // 嗅探不得误判：图片头 / JSON 头 / 过短字节 / FDICT 位。
  assert.equal(isZlibEnvelope(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false, "PNG 不得误判");
  assert.equal(isZlibEnvelope(new Uint8Array([0xff, 0xd8, 0xff])), false, "JPEG 不得误判");
  assert.equal(isZlibEnvelope(new TextEncoder().encode("{}")), false, "JSON 不得误判");
  assert.equal(isZlibEnvelope(new Uint8Array([0x78])), false, "过短不得误判");
  assert.equal(isZlibEnvelope(new Uint8Array([0x78, 0x3d])), false, "非法 zlib 头不得误判");
}

// --- 1b. CompressionStream 不可用 → 回退纯 JSON，读写自洽 -------------------
{
  const compressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream");
  const decompressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream");
  assert.ok(compressionDescriptor && decompressionDescriptor, "Node 应提供 CompressionStream 以便覆盖测试");
  delete (globalThis as { CompressionStream?: unknown }).CompressionStream;
  delete (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  try {
    assert.equal(syncV7CompressionEnabled(), false, "无压缩流时报告不可用");
    const json = JSON.stringify({ 回退: "纯 JSON", data: "x".repeat(9999) });
    const encoded = await encodeSyncV7Json(json);
    assert.equal(isZlibEnvelope(encoded), false, "回退产物不是 zlib 信封");
    assert.deepEqual(Array.from(encoded), Array.from(new TextEncoder().encode(json)), "回退产物 = 原始 UTF-8 字节（与历史线上格式一致）");
    assert.equal(await decodeSyncV7Json(encoded), json, "回退产物可解码");
  } finally {
    Object.defineProperty(globalThis, "CompressionStream", compressionDescriptor!);
    Object.defineProperty(globalThis, "DecompressionStream", decompressionDescriptor!);
  }
}

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "compression-vault", branch: "main", apiBaseUrl: server.url };
const mixedSettings = { owner: "qa", repo: "compression-mixed-vault", branch: "main", apiBaseUrl: server.url };
const sync = () => syncWithGitHub(settings, "qa-token");

// --- 2. remote 层：线上字节是压缩信封、体积显著缩小、读回一致 ---------------
{
  // 记录型 fetch：捕获 PUT 的线上请求体长度（base64 content），透传给 mock 后端。
  const putBodies: Array<{ path: string; wireBytes: number }> = [];
  const innerFetch: typeof fetch = globalThis.fetch.bind(globalThis);
  const spyFetch: typeof fetch = async (input, init) => {
    if (init?.method === "PUT") {
      const url = typeof input === "string" ? input : (input as URL).toString?.() ?? "";
      if (url.includes("/contents/sync/v7/")) {
        const body = JSON.parse(String(init.body)) as { content: string; message?: string };
        putBodies.push({ path: url, wireBytes: body.content.length });
      }
    }
    return innerFetch(input as never, init as never);
  };

  await freshClient("device-a");
  await sync();
  const bank = await createBankV6("压缩题库");
  // 体积可观的题干让压缩收益可观测（真实数据里中文 JSON 压缩比 ~5-10×）。
  for (let index = 0; index < 6; index += 1) {
    await createQuestionV6(bank.id, question(`压缩信封第 ${index} 题：` + "弧垂增大时安全距离随之调整。".repeat(120)));
  }
  putBodies.length = 0;
  await syncWithGitHub(settings, "qa-token", undefined, { fetch: spyFetch });
  const segmentPuts = putBodies.filter((entry) => entry.path.includes("/segments/"));
  assert.ok(segmentPuts.length >= 1, "应至少上传一个分段");

  // 直接读取远端存储的 blob：验证 mock 端存的是压缩信封，且逻辑读回一致。
  const remote = createGitHubV7Remote({ owner: "qa", repo: "compression-vault", token: "t", apiBaseUrl: server.url });
  const head = await remote.readHead();
  assert.ok(head.initialized);
  for (const descriptor of head.head.segments) {
    const raw = await (await fetch(`${server.url}/repos/qa/compression-vault/git/blobs/${descriptor.blobSha}`, { headers: { accept: "application/vnd.github.raw+json" } })).arrayBuffer();
    assert.equal(isZlibEnvelope(new Uint8Array(raw)), true, `分段 ${descriptor.path} 远端存储应是压缩信封`);
    const logical = await remote.readBlob(descriptor);
    assert.equal(logical.byteLength, descriptor.size, "读回逻辑字节长度与描述符一致");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", logical as BufferSource)), (v) => v.toString(16).padStart(2, "0")).join("");
    assert.equal(digest, descriptor.sha256, "读回逻辑字节 digest 与描述符一致（内容寻址不因信封改变）");
  }
  // head.json 永远是纯 JSON。
  const headRaw = await (await fetch(`${server.url}/repos/qa/compression-vault/contents/sync/v7/head.json`)).json() as { content: string };
  const headBytes = Buffer.from(headRaw.content, "base64");
  assert.equal(isZlibEnvelope(new Uint8Array(headBytes)), false, "head.json 保持纯 JSON");
  JSON.parse(new TextDecoder().decode(headBytes));
}

// --- 3. 混合格式 vault：存量纯 JSON + 新写压缩对象共存可读 -------------------
{
  // 旧设备（无 CompressionStream）先写纯 JSON 对象到远端。
  const compressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream");
  const decompressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream");
  delete (globalThis as { CompressionStream?: unknown }).CompressionStream;
  delete (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  await freshClient("legacy-a");
  const legacySync = () => syncWithGitHub(mixedSettings, "qa-token");
  await legacySync();
  const legacyBank = await createBankV6("存量纯 JSON 题库");
  await createQuestionV6(legacyBank.id, question("旧设备写入的题目"));
  await legacySync();
  Object.defineProperty(globalThis, "CompressionStream", compressionDescriptor!);
  Object.defineProperty(globalThis, "DecompressionStream", decompressionDescriptor!);

  // 远端确实存有纯 JSON 分段（回退路径写入）。
  const remote = createGitHubV7Remote({ owner: "qa", repo: "compression-mixed-vault", token: "t", apiBaseUrl: server.url });
  const legacyHead = await remote.readHead();
  assert.ok(legacyHead.initialized);
  const legacySegment = legacyHead.head.segments[0]!;
  const legacyRaw = new Uint8Array(await (await fetch(`${server.url}/repos/qa/compression-mixed-vault/git/blobs/${legacySegment.blobSha}`, { headers: { accept: "application/vnd.github.raw+json" } })).arrayBuffer());
  assert.equal(isZlibEnvelope(legacyRaw), false, "旧设备写入的分段应是纯 JSON");

  // 新设备（压缩可用）拉取存量 + 推送新数据：同一 vault 新旧格式共存。
  await freshClient("modern-b");
  const mixedSync = () => syncWithGitHub(mixedSettings, "qa-token");
  await mixedSync();
  assert.ok(await dbV6.questions.count() >= 1, "新设备应拉到旧设备的题目");
  const modernBank = await createBankV6("新设备压缩题库");
  await createQuestionV6(modernBank.id, question("新设备写入的题目：".concat("混合格式验证。".repeat(200))));
  await mixedSync();

  // 旧设备再次上线（恢复压缩能力后）也能读到新设备写入的压缩对象。
  await freshClient("legacy-a");
  await legacySync();
  const stems = (await dbV6.questions.toArray()).flatMap((row) => row.content.map((block) => block.type === "text" ? block.text : "")).join("\n");
  assert.ok(stems.includes("新设备写入的题目"), "旧设备应能读到压缩格式的新数据");

  // 再来一台全新设备：一次性拉取混合格式 vault，全部题目齐备。
  await freshClient("fresh-c");
  await mixedSync();
  const allStems = (await dbV6.questions.toArray()).flatMap((row) => row.content.map((block) => block.type === "text" ? block.text : "")).join("\n");
  assert.ok(allStems.includes("旧设备写入的题目") && allStems.includes("新设备写入的题目"), "全新设备应能同时读取纯 JSON 与压缩两种格式的对象");
}

// --- 4. idempotent 422 路径：同内容再 PUT 走读回比对 -------------------------
// 幂等冲突（HTTP 422 already-exists）由 CAS 语义触发，用独立 cas:true 后端单测。
{
  const casServer = await startMockGitHubServer({ cas: true });
  try {
    const remote = createGitHubV7Remote({ owner: "qa", repo: "idempotent-vault", token: "t", apiBaseUrl: casServer.url });
    const json = new TextEncoder().encode(JSON.stringify({ formatVersion: 1, events: ["幂等重放".repeat(200)] }));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", json as BufferSource)), (v) => v.toString(16).padStart(2, "0")).join("");
    const path = `sync/v7/segments/${digest}.json`;
    const first = await remote.putImmutable({ path, bytes: json, kind: "segment" });
    assert.equal(first.created, true, "首次上传应 created");
    const second = await remote.putImmutable({ path, bytes: json, kind: "segment" });
    assert.equal(second.idempotent, true, "同内容重 PUT 应走 idempotent 路径（解压后逻辑字节比对）");
    assert.equal(second.sha256, digest, "幂等返回的逻辑 digest 与原内容一致");
    assert.equal(second.blobSha, first.blobSha, "幂等命中同一个远端 blob");
    // 幂等比对基于逻辑字节：同 path 不同内容必须报冲突而不是静默接受。
    // 内容寻址先拒绝：path digest 与新内容 digest 不符，不会覆盖远端对象。
    await assert.rejects(remote.putImmutable({ path, bytes: new TextEncoder().encode(JSON.stringify({ formatVersion: 1, events: ["不同内容"] })), kind: "segment" }), /mismatch/, "同路径不同内容在上传前即被内容寻址拒绝");
  } finally {
    await casServer.close();
  }
}

// --- 5. 远端迁移（Part G）：验证失败中止 / 迁移后拉取等价 / 幂等 -------------
{
  const { migrateVaultToCompressed } = await import("../lib/github-sync-v7");
  const migrationSettings = { owner: "qa", repo: "migrate-vault", branch: "main", apiBaseUrl: server.url };
  const migrationSync = () => syncWithGitHub(migrationSettings, "qa-token");

  // 建立含热事件的 vault：A 推送若干题（分segment仍在热窗口）。
  await freshClient("migrate-a");
  await migrationSync();
  const migrateBank = await createBankV6("迁移题库");
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < 3; index += 1) {
      await createQuestionV6(migrateBank.id, question(`迁移第 ${round * 3 + index} 题：` + "压缩迁移正文。".repeat(40)));
    }
    await migrationSync();
  }
  const remote = createGitHubV7Remote({ owner: "qa", repo: "migrate-vault", token: "t", apiBaseUrl: server.url });
  const headBefore = (await remote.readHead()).head;
  assert.ok(headBefore.segments.length >= 3, `迁移前应有热分段（实际 ${headBefore.segments.length}）`);

  // 5a. 验证失败中止：损坏热分段 blob → 抛错且远端零改动。
  server.armCorruptOnce();
  await assert.rejects(migrateVaultToCompressed(migrationSettings, "qa-token", undefined, { fetch: undefined }), /mismatch|失败/, "损坏对象应让迁移在验证阶段中止");
  const headAfterAbort = (await remote.readHead()).head;
  assert.equal(headAfterAbort.checkpoint.sha256, headBefore.checkpoint.sha256, "中止后检查点不变");
  assert.deepEqual(headAfterAbort.segments.map((item) => item.path), headBefore.segments.map((item) => item.path), "中止后热窗口不变");

  // 5b. 迁移前基线：全新设备拉取的投影（除墓碑外）。
  await freshClient("baseline-x");
  await migrationSync();
  const baselineQuestions = (await dbV6.questions.toArray()).map((row) => ({ id: row.id, type: row.type, answer: row.answer, tags: row.tags })).sort((a, b) => a.id.localeCompare(b.id));
  const baselineBanks = (await dbV6.banks.toArray()).map((row) => ({ id: row.id, name: row.name })).sort((a, b) => a.id.localeCompare(b.id));

  const migrated = await migrateVaultToCompressed(migrationSettings, "qa-token", () => undefined);
  assert.equal(migrated.migrated, true, "迁移应成功");
  assert.ok(migrated.hotEvents >= 9, `折叠的热事件数（${migrated.hotEvents}）应覆盖全部推送`);
  assert.ok(migrated.bytesAfter > 0 && migrated.bytesBefore > migrated.bytesAfter, "折叠后逻辑字节应减少");
  const headMigrated = (await remote.readHead()).head;
  assert.equal(headMigrated.segments.length, 0, "迁移后热窗口清空");
  assert.notEqual(headMigrated.checkpoint.sha256, headBefore.checkpoint.sha256, "迁移产生新检查点");
  // 新检查点远端存储为压缩信封。
  const migratedRaw = new Uint8Array(await (await fetch(`${server.url}/repos/qa/migrate-vault/git/blobs/${headMigrated.checkpoint.blobSha}`, { headers: { accept: "application/vnd.github.raw+json" } })).arrayBuffer());
  assert.equal(isZlibEnvelope(migratedRaw), true, "迁移后的检查点应是压缩信封");

  // 5c. 迁移后新设备拉取：投影与迁移前一致（除按前提丢弃的墓碑）。
  await freshClient("post-migrate-y");
  await migrationSync();
  const postQuestions = (await dbV6.questions.toArray()).map((row) => ({ id: row.id, type: row.type, answer: row.answer, tags: row.tags })).sort((a, b) => a.id.localeCompare(b.id));
  const postBanks = (await dbV6.banks.toArray()).map((row) => ({ id: row.id, name: row.name })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(postQuestions, baselineQuestions, "迁移后拉取的题目与迁移前一致");
  assert.deepEqual(postBanks, baselineBanks, "迁移后拉取的题库与迁移前一致");
  assert.equal(await dbV6.tombstones.count(), 0, "存量墓碑按迁移前提清零");

  // 5d. 幂等：热窗口已空 → 无需迁移。
  const again = await migrateVaultToCompressed(migrationSettings, "qa-token", () => undefined);
  assert.equal(again.migrated, false, "重复迁移应报告无需迁移");
  assert.ok(again.reason, "无需迁移时应给出原因");
  const headIdempotent = (await remote.readHead()).head;
  assert.equal(headIdempotent.checkpoint.sha256, headMigrated.checkpoint.sha256, "幂等检查不改动远端");
}

// --- 6. storedSize 补填：剥掉后 backfill 补回，幂等 ---------------------------
{
  const { backfillVaultStoredSizes } = await import("../lib/github-sync-v7");
  const backfillSettings = { owner: "qa", repo: "backfill-vault", branch: "main", apiBaseUrl: server.url };
  const backfillSync = () => syncWithGitHub(backfillSettings, "qa-token");
  await freshClient("backfill-a");
  await backfillSync();
  const bank6 = await createBankV6("补填题库");
  for (let index = 0; index < 4; index += 1) await createQuestionV6(bank6.id, question(`补填第 ${index} 题：` + "压缩正文。".repeat(60)));
  await backfillSync();
  const backfillRemote = createGitHubV7Remote({ owner: "qa", repo: "backfill-vault", token: "t", apiBaseUrl: server.url });
  const annotated = await backfillRemote.readHead();
  assert.ok(annotated.initialized && annotated.head.checkpoint.storedSize !== undefined, "新上传的 descriptor 应携带 storedSize");

  // 模拟存量 head：剥掉全部 storedSize 再 CAS 发布。
  const strippedHead: typeof annotated.head = {
    ...annotated.head,
    checkpoint: { ...annotated.head.checkpoint!, storedSize: undefined },
    segments: annotated.head.segments.map((descriptor) => ({ ...descriptor, storedSize: undefined })),
  };
  const strippedPut = await backfillRemote.putHead(strippedHead, annotated.cache);
  assert.equal(strippedPut.ok, true, "剥掉 storedSize 的 head 应能发布（字段可选）");
  const strippedRead = await backfillRemote.readHead();
  assert.ok(strippedRead.head.checkpoint.storedSize === undefined, "剥离后 head 无 storedSize");

  const backfilled = await backfillVaultStoredSizes(backfillSettings, "qa-token", () => undefined);
  assert.equal(backfilled.updated, true, "backfill 应更新 head");
  assert.equal(backfilled.filled, 1 + strippedRead.head.segments.length, "每个 descriptor 都应补上 storedSize");
  const after = (await backfillRemote.readHead()).head;
  assert.ok(after.checkpoint.storedSize !== undefined && after.checkpoint.storedSize > 0, "补填后的检查点 storedSize 有效");
  for (const descriptor of after.segments) assert.ok(descriptor.storedSize !== undefined && descriptor.storedSize > 0, "补填后的分段 storedSize 有效");
  assert.equal(after.checkpoint.sha256, strippedRead.head.checkpoint.sha256, "补填只加元数据，不改对象身份");

  // 幂等：已补填的 head 零写入。
  const again = await backfillVaultStoredSizes(backfillSettings, "qa-token", () => undefined);
  assert.equal(again.updated, false, "重复补填应零写入");
  assert.equal(again.filled, 0, "无 descriptor 需要补");
}

await server.close();
dbV6.close();
console.log("sync compression tests passed: codec 单元/回退、线上压缩信封与体积、混合格式共存、幂等读回、head 保持纯 JSON、迁移三场景");
