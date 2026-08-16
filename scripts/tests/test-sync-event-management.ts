import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, resetV7Database } from "../../src/lib/db/db-v7";
import { discardManagedChangeSetV7 } from "../../src/lib/sync/change-set-v7-queue";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// Integration tests for the sync event manager's delete (discard) flow against
// the in-memory mock GitHub backend. Each scenario drives real pending
// change-sets through discardManagedChangeSetV7 (the handler behind the sync
// drawer's delete button) and verifies the projection rebuild + cross-device
// consistency.

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

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "mock-vault", branch: "main", apiBaseUrl: server.url };
const sync = () => syncWithGitHub(settings, "qa-token");

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
    tags: ["事件管理"],
  };
}

/** Find a pending change-set id by predicate. */
async function pendingId(predicate: (record: { id: string; kind: string }) => boolean): Promise<string> {
  const rows = await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).toArray();
  const found = rows.find(predicate);
  if (!found) throw new Error("未找到目标 pending 变更集");
  return found.id;
}

try {
  // --- Scenario 1: discarding a pending event rebuilds the projection --------
  {
    server.reset();
    await freshClient("device-a");
    await sync(); // establish the v7 queue-base required by discard
    const bank = await createBankV7("事件管理题库");
    await createQuestionV7(bank.id, singleChoice("将被删除的待同步题目", "A", ["对", "错"]));
    assert.equal(await dbV7.questions.count(), 1, "题目应已写入本地投影");

    const questionChangeSetId = await pendingId((record) => record.kind === "batch");
    await discardManagedChangeSetV7(questionChangeSetId);

    assert.equal(await dbV7.questions.count(), 0, "删除 pending 事件后投影应重建为不含该题目");
    assert.ok(await dbV7.banks.get(bank.id), "题库 pending 事件应保留");

    await sync(); // pushes only the bank; the discarded question never reaches the mock
    await freshClient("device-b");
    await sync();
    assert.ok(await dbV7.banks.get(bank.id), "新设备应看到题库");
    assert.equal(await dbV7.questions.count(), 0, "被删除的待同步题目不应出现在其他设备");
    console.log("scenario 1 passed: 删除 pending 事件后投影重建且不跨设备传播");
  }

  // --- Scenario 2: cascade deletion of dependent events ---------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("级联事件题库");
    await createQuestionV7(bank.id, singleChoice("依赖题库的题目", "A", ["对", "错"])); // membership depends on the bank
    const bankChangeSetId = await pendingId((record) => record.kind === "bank.create");

    // The question/membership event depends on the bank event, so a plain
    // delete must refuse and report the dependency count.
    await assert.rejects(() => discardManagedChangeSetV7(bankChangeSetId), /依赖/, "有依赖时应拒绝直接删除");

    await discardManagedChangeSetV7(bankChangeSetId, { cascadeDependents: true });
    assert.equal(await dbV7.banks.count(), 0, "级联删除应移除题库");
    assert.equal(await dbV7.questions.count(), 0, "级联删除应一并移除依赖的题目");
    assert.equal((await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).toArray()).length, 0, "依赖事件应一并删除");
    console.log("scenario 2 passed: 级联删除连带移除依赖事件");
  }

  // --- Scenario 3: locked (committed) events cannot be deleted --------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    await createBankV7("已锁定题库");
    await sync(); // commits the bank change-set
    const committedId = await pendingId((record) => record.kind === "bank.create").catch(() => "");
    // The bank event is now committed, so it is no longer in pending/blocked;
    // discard must refuse because it is locked.
    const committedBankId = (await dbV7.changeSets.where("state").equals("committed").toArray()).find((record) => record.kind === "bank.create")?.id;
    assert.ok(committedBankId, "应存在已提交的题库事件");
    await assert.rejects(() => discardManagedChangeSetV7(committedBankId!), /已锁定|不存在/, "已锁定事件不可删除");
    void committedId;
    console.log("scenario 3 passed: 已锁定（已同步）事件不可删除");
  }

  // --- Scenario 4: post-discard sync is idempotent and consistent -----------
  {
    server.reset();
    await freshClient("device-a");
    await sync();
    const bank = await createBankV7("幂等题库");
    await createQuestionV7(bank.id, singleChoice("幂等题", "A", ["对", "错"]));
    await discardManagedChangeSetV7(await pendingId((record) => record.kind === "batch"));
    const first = await sync();
    const second = await sync();
    assert.equal(second.pushed, 0, "删除后二次同步不应重复上传");
    assert.ok(first.pushed >= 1, "首次同步应上传保留下来的题库");
    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.questions.count(), 0, "幂等性：新设备仍不应看到被删题目");
    console.log("scenario 4 passed: 删除事件后同步幂等且跨设备一致");
  }

  console.log("sync event management tests passed");
} finally {
  await server.close();
  dbV7.close();
}
