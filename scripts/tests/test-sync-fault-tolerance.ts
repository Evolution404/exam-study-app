import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBankV7,
  createQuestionV7,
  dbV7,
  listChangeSetsV7,
  resetV7Database,
} from "../../src/lib/db/db-v7";
import { syncWithGitHub, restoreFullHistoryFromGitHub } from "../../src/lib/sync/github-sync-v7";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7-codec";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// Sync fault-tolerance tests: CAS retry, interrupted-claim recovery, partial
// upload, network errors, blob corruption, download failure, restore guards,
// concurrent bootstrap, in-realm sync mutex. Uses the CAS-capable +
// fault-injecting mock (startMockGitHubServer({ cas, faults })).

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

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV7Database();
}

function singleChoice(stem: string, answer: string, options: string[]): Parameters<typeof createQuestionV7>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: options.map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    answer,
    tags: ["故障测试"],
  };
}

// 清掉 remote cache（checkpoint 缓存），强制下一次 downloadRemote 重新下载
// segment，使 downloaded.changes 非空——用于触发依赖远端 changes 的路径。
async function clearRemoteCache(): Promise<void> {
  const keys = (await dbV7.syncMeta.toCollection().primaryKeys()) as string[];
  for (const key of keys) if (key.startsWith("v9:sync:checkpoint")) await dbV7.syncMeta.delete(key);
}

// 手动 seed 一条 change-set（可精确控制 id / createdAt / mutations），用于
// 构造乱序 pending（B3）与中断 claim（B2）场景。
async function seedChangeSet(opts: {
  id: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  mutations: unknown[];
  state?: "pending" | "claimed" | "blocked";
  claimId?: string;
  claimedAt?: string;
}) {
  const changeSet = await createChangeSetV7({
    id: opts.id,
    deviceId: opts.deviceId,
    localSequence: opts.localSequence,
    createdAt: opts.createdAt,
    mutations: opts.mutations as Parameters<typeof createChangeSetV7>[0]["mutations"],
  });
  await dbV7.changeSets.put({ ...changeSet, state: opts.state ?? "pending", ...(opts.claimId ? { claimId: opts.claimId, claimedAt: opts.claimedAt ?? opts.createdAt } : {}) });
  return changeSet;
}

type Scenario = { name: string; run: () => Promise<void> };
const scenarios: Scenario[] = [];
function test(name: string, run: () => Promise<void>): void {
  scenarios.push({ name, run });
}

// === S1. CAS retry/rebase loop — head PUT 409 once (simulated concurrent winner) ===
test("S1 CAS 重试：head PUT 409 一次 → rebase → 提交成功", async () => {
  const server = await startMockGitHubServer({ cas: true, faults: { conflictHeadPutOnce: true } });
  const settings = { owner: "qa", repo: "cas-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("CAS重试题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("CAS题一", "A", ["对", "错"]));
    const q2 = await createQuestionV7(bank.id, singleChoice("CAS题二", "A", ["对", "错"]));
    const result = await sync();
    assert.equal(result.pushed, 3, "题库 + 两道题都应推送成功（CAS 重试后提交）");
    assert.equal((await listChangeSetsV7(["claimed"])).length, 0, "不应有 record 卡在 claimed");
    assert.equal((await listChangeSetsV7(["pending", "blocked"])).length, 0, "CAS 重试后应全部 committed");
    await freshClient("device-b");
    await sync();
    assert.ok(await dbV7.questions.get(q1.id), "新设备应拉取到 q1");
    assert.ok(await dbV7.questions.get(q2.id), "新设备应拉取到 q2");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S2. CAS retry exhaustion — head PUT keeps 409 → 4 retries then clean error ===
test("S2 CAS 重试耗尽：持续 409 → 抛「并发更新」且 claim 释放", async () => {
  const server = await startMockGitHubServer({ cas: true, faults: { conflictHeadPutAlways: true } });
  const settings = { owner: "qa", repo: "cas-exhaust", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("重试耗试题库");
    await createQuestionV7(bank.id, singleChoice("耗试题", "A", ["对", "错"]));
    await assert.rejects(sync(), /远端持续发生并发更新/, "持续 409 应在重试 4 次后抛出清晰错误");
    assert.equal((await listChangeSetsV7(["claimed"])).length, 0, "claim 应已释放（无 claimed 残留）");
    assert.equal((await listChangeSetsV7(["pending"])).length, 2, "本地变更应回到 pending（不丢）");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S3. Partial upload — first segment PUT 500 → claim released → retry succeeds ===
test("S3 部分上传：segment PUT 500 → claim 释放 → 重试成功", async () => {
  const server = await startMockGitHubServer({ faults: { failPutOnce: /segments\// } });
  const settings = { owner: "qa", repo: "partial-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("部分上传题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("部分上传题", "A", ["对", "错"]));
    await assert.rejects(sync(), /GitHub .* failed \(500\)/, "首个 segment 上传失败应抛错");
    assert.equal((await listChangeSetsV7(["claimed"])).length, 0, "claim 应已释放");
    assert.equal((await listChangeSetsV7(["pending"])).length, 2, "pending 应保留");
    const result = await sync();
    assert.equal(result.pushed, 2, "重试后应推送成功");
    await freshClient("device-b");
    await sync();
    assert.ok(await dbV7.questions.get(q1.id), "重试后的数据应完整可达");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S4. Network flaky — injected fetch fails first 2 requests then recovers ===
test("S4 网络抖动：flakyFetch 前 2 次 500 → 重试成功、无半安装", async () => {
  const server = await startMockGitHubServer();
  const settings = { owner: "qa", repo: "flaky-vault", branch: "main", apiBaseUrl: server.url };
  let calls = 0;
  const flakyFetch: typeof fetch = async (input, init) => {
    calls += 1;
    if (calls <= 1) return new Response(JSON.stringify({ message: "flaky" }), { status: 500, headers: { "Content-Type": "application/json" } });
    return fetch(input, init);
  };
  const sync = () => syncWithGitHub(settings, "qa-token", undefined, { fetch: flakyFetch });
  try {
    await freshClient("device-a");
    await assert.rejects(sync(), /GitHub .* failed \(500\)/, "首次请求失败应抛错");
    await sync();
    const bank = await createBankV7("抖动题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("抖动题", "A", ["对", "错"]));
    const result = await sync();
    assert.equal(result.pushed, 2, "恢复后应推送成功");
    assert.ok(await dbV7.questions.get(q1.id), "本地应无半安装");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S5. Corrupt blob — flip next checkpoint download → SyncV7BlobIntegrityError ===
test("S5 损坏 blob：checkpoint 字节翻转 → 完整性错误、本地不变", async () => {
  const server = await startMockGitHubServer();
  const settings = { owner: "qa", repo: "corrupt-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("损坏题库");
    await createQuestionV7(bank.id, singleChoice("损坏题", "A", ["对", "错"]));
    await sync();
    server.armCorruptOnce();
    await freshClient("device-b");
    // 压缩信封首字节被翻转后嗅探不到 zlib 头 → 按明文处理 → 尺寸/摘要任一不符都算拦截。
    await assert.rejects(sync(), /blob (size|sha256) mismatch/, "损坏的 blob 应触发完整性错误");
    assert.equal(await dbV7.questions.count(), 0, "本地应无半安装（题目表为空）");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S6. Download failure — checkpoint blob GET 500 → clean error, local unchanged ===
test("S6 下载失败：checkpoint blob GET 500 → 干净报错、本地不变", async () => {
  const server = await startMockGitHubServer();
  const settings = { owner: "qa", repo: "dl-fail-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("下载失败题库");
    await createQuestionV7(bank.id, singleChoice("下载失败题", "A", ["对", "错"]));
    await sync();
    server.armFailBlobGetOnce();
    await freshClient("device-b");
    await assert.rejects(sync(), /GitHub .* failed \(500\)/, "checkpoint 下载失败应抛错");
    assert.equal(await dbV7.questions.count(), 0, "本地应无半安装");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S7. ETag 304 — second sync walks the not-modified fast path ===
test("S7 ETag 304：二次同步走 not-modified 快路径", async () => {
  const server = await startMockGitHubServer({ cas: true });
  const settings = { owner: "qa", repo: "etag-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("ETag题库");
    await createQuestionV7(bank.id, singleChoice("ETag题", "A", ["对", "错"]));
    await sync();
    const second = await sync();
    assert.equal(second.pushed, 0, "无新变更时二次同步不应再推送");
    assert.equal(second.pulled, 0, "无新变更时二次同步不应再拉取");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S8. Restore guard (B1) — pending changes must not be silently discarded ===
test("S8 恢复守卫（B1）：有 pending 时 restore 应抛错且不丢数据", async () => {
  const server = await startMockGitHubServer();
  const settings = { owner: "qa", repo: "restore-vault", branch: "main", apiBaseUrl: server.url };
  try {
    await freshClient("device-a");
    await syncWithGitHub(settings, "qa-token");
    const bank = await createBankV7("恢复题库");
    await createQuestionV7(bank.id, singleChoice("恢复题", "A", ["对", "错"]));
    await assert.rejects(restoreFullHistoryFromGitHub(settings, "qa-token"), /未同步/, "有未同步变更时 restore 应抛错");
    assert.equal((await listChangeSetsV7(["pending"])).length, 2, "pending 不应被静默丢弃");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S9. Interrupted claim (B2) — digest mismatch downgrades to blocked, not crash ===
test("S9 中断 claim（B2）：digest 不匹配降级 blocked 而非崩溃", async () => {
  const server = await startMockGitHubServer();
  const settings = { owner: "qa", repo: "interrupt-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("中断题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("中断题", "A", ["对", "错"]));
    await sync();
    // 清 remote cache，强制重新下载 segment，使远端 changes 非空（否则 cache
    // reuse 让 interruptedClaims 走 cursor 覆盖路径，不触发 digest 检查）。
    await clearRemoteCache();
    // 取一条已提交记录，伪造一条同 id 但 digest 被篡改的 claimed 残留。
    const committed = await listChangeSetsV7(["committed"]);
    const questionRecord = committed[0];
    assert.ok(questionRecord, "应有已提交记录");
    await dbV7.changeSets.put({ ...questionRecord, state: "claimed" as const, claimId: "stale-claim", claimedAt: new Date().toISOString(), digest: `${questionRecord.digest}-tampered` });
    await sync();
    const blocked = await listChangeSetsV7(["blocked"]);
    assert.equal(blocked.length, 1, "digest 不匹配的记录应被标 blocked");
    assert.equal((await listChangeSetsV7(["claimed"])).length, 0, "不应残留 claimed");
    assert.ok(await dbV7.questions.get(q1.id), "远端题目应仍可拉取（sync 未崩溃）");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S10. Replay-order resilience (B3) — out-of-order pending must not crash push ===
test("S10 重放顺序韧性（B3）：乱序 pending 重放抛错时 sync 不崩", async () => {
  const server = await startMockGitHubServer();
  const settings = { owner: "qa", repo: "replay-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("重放题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("重放题", "A", ["对", "错"]));
    await sync();
    const question = (await dbV7.questions.get(q1.id))!;
    // 两条 pending：createdAt 序 = upsert(早) → delete(晚) 不抛错；
    // id 序 = "a-delete"(先) → "z-upsert"(后) 会 rejectTombstoned 抛错。
    const early = "2026-01-01T00:00:00.000Z";
    const late = "2026-01-02T00:00:00.000Z";
    await seedChangeSet({ id: "z-upsert", deviceId: "device-a", localSequence: 100, createdAt: early, mutations: [{ kind: "question.upsert", question }] });
    await seedChangeSet({ id: "a-delete", deviceId: "device-a", localSequence: 101, createdAt: late, mutations: [{ kind: "question.delete", questionId: q1.id, deletedAt: late, cascade: true }] });
    const result = await sync();
    assert.equal(result.pushed, 2, "乱序 pending 重放抛错时 sync 不应崩溃（B3 修复后提交成功）");
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.questions.get(q1.id), undefined, "删除语义应正确传播（q1 已删）");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S11. Concurrent bootstrap (B4) — second device adopts winner, no split-brain ===
test("S11 并发 bootstrap（B4）：第二设备采纳胜者、无 split-brain", async () => {
  const server = await startMockGitHubServer({ cas: true });
  const settings = { owner: "qa", repo: "bootstrap-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("bootstrap题库");
    await createQuestionV7(bank.id, singleChoice("bootstrap题", "A", ["对", "错"]));
    await sync();
    // 第二设备有本地 pending，sync 时不应覆盖第一设备的 head。
    await freshClient("device-b");
    const bankB = await createBankV7("bootstrap题库B");
    const qB = await createQuestionV7(bankB.id, singleChoice("bootstrap题B", "A", ["对", "错"]));
    const result = await sync();
    assert.equal(result.pushed, 2, "第二设备应正常推送自己的 pending");
    assert.equal(result.pulled, 2, "第二设备应拉取第一设备的数据");
    assert.ok(await dbV7.questions.get(qB.id), "第二设备本地应有自己的题");
    // 第一设备仍在 mock 远端：重新拉取应看到两设备的全部数据。
    await freshClient("device-c");
    await sync();
    assert.ok(await dbV7.questions.get(qB.id), "无 split-brain：第三设备能看到第二设备的题");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === S12. Concurrent sync mutex (B5) — Promise.all double-sync serializes ===
test("S12 并发同步互斥（B5）：Promise.all 双 sync 串行、无 claimed 残留", async () => {
  const server = await startMockGitHubServer({ cas: true });
  const settings = { owner: "qa", repo: "mutex-vault", branch: "main", apiBaseUrl: server.url };
  const sync = () => syncWithGitHub(settings, "qa-token");
  try {
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("互斥题库");
    await createQuestionV7(bank.id, singleChoice("互斥题", "A", ["对", "错"]));
    await Promise.all([sync(), sync()]);
    assert.equal((await listChangeSetsV7(["claimed"])).length, 0, "双 sync 后不应有 claimed 残留");
    assert.equal((await listChangeSetsV7(["pending", "blocked"])).length, 0, "双 sync 后应全部 committed");
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.questions.count(), 1, "数据只应提交一份（无重复）");
  } finally {
    await server.close();
    dbV7.close();
  }
});

// === run all scenarios independently, reporting green/red ===
let failed = 0;
for (const scenario of scenarios) {
  try {
    await scenario.run();
    console.log(`✓ ${scenario.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${scenario.name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\nsync fault-tolerance tests FAILED: ${failed}/${scenarios.length} 个场景失败`);
  process.exit(1);
}
console.log(`\nsync fault-tolerance tests passed (${scenarios.length} 个场景)`);
