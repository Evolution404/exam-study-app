import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  createBankV7,
  createQuestionV7,
  dbV7,
  deleteBankWithExclusiveQuestionsV7,
  importQuestionBankV7,
  resetV7Database,
  saveBankFolderV7,
  saveNoteV7,
  savePracticeRunV7,
} from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";
import type { PracticeRunV7 } from "../../src/lib/db/v7-types";

// End-to-end sync integration against the in-memory mock GitHub backend.
// Each scenario simulates a fresh device (reset DB + switch deviceId) pulling
// from a mock that persists state across clients, so push/pull/delete/merge
// correctness is exercised without a real repository or a browser.

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
const settings = { owner: "qa", repo: "mock-vault", branch: "main", apiBaseUrl: server.url };
const sync = () => syncWithGitHub(settings, "qa-token");

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV7Database();
}

function singleChoice(stem: string, answer: string, options: string[]): Parameters<typeof createQuestionV7>[1] {
  const optionIds = options.map((_, index) => `opt-${index}`);
  const correctOptionIds = answer
    .split("")
    .map((letter) => optionIds[letter.charCodeAt(0) - 65])
    .filter((id): id is string => Boolean(id));
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: options.map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    optionIds,
    solution: { kind: "choice", correctOptionIds },
    tags: ["集成测试"],
  };
}

try {
  // --- Scenario 1: large import round-trip across devices -----------------
  {
    server.reset();
    await freshClient("device-a");
    await sync(); // initialise an empty vault on the mock

    const rows = Array.from({ length: 2000 }, (_, index) => ({
      stem: `大规模同步测试第 ${index + 1} 题：关于考点 ${index} 的描述，下列哪项正确？`,
      type: "单选",
      options: ["选项甲", "选项乙", "选项丙", "选项丁"],
      answer: "A",
    }));
    const bank = await importQuestionBankV7("大规模导入测试题库.json", rows);
    const localQuestionCount = await dbV7.questions.count();
    assert.equal(localQuestionCount, 2000, "导入后本地应有 2000 道题");

    const sample = (await dbV7.questions.limit(5).toArray()).map((question) => ({ id: question.id, fingerprint: question.contentFingerprint }));
    const pushResult = await sync();
    assert.equal(pushResult.pushed, 1, "大规模导入应为单个原子 change-set（不再分块）");
    assert.ok(server.contentPaths().some((path) => path.startsWith("sync/v9/objects/")), "超大变更集应卸载为不可变对象而非内联塞入 segment");

    // Brand-new device pulls the whole vault.
    await freshClient("device-b");
    const pullResult = await sync();
    assert.ok(pullResult.pulled >= 1, "新设备应拉取到远端数据");

    const pulledBank = await dbV7.banks.get(bank.id);
    assert.ok(pulledBank, "新设备应看到题库");
    assert.equal(await dbV7.questions.count(), 2000, "新设备应拉取到全部 2000 道题");
    assert.equal(await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).count(), 2000, "题库关系应完整");
    for (const expected of sample) {
      const got = await dbV7.questions.get(expected.id);
      assert.equal(got?.contentFingerprint, expected.fingerprint, `题目 ${expected.id} 内容指纹应一致`);
    }
    console.log("scenario 1 passed: 2000 题导入 → 同步 → 新客户端拉取，数据一致");
  }

  // --- Scenario 2: multi-device edit propagation --------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();

    const bank = await createBankV7("多端编辑题库");
    const question = await createQuestionV7(bank.id, singleChoice("2 + 2 等于多少？", "B", ["3", "4", "5", "6"]));
    await saveNoteV7(question.id, "这是一条个人解析，应随同步迁移到其他设备。");
    const folder = await saveBankFolderV7({ name: "多端文件夹", description: "同步验证" });
    await sync();

    await freshClient("device-b");
    await sync();

    assert.ok(await dbV7.banks.get(bank.id), "device-b 应看到题库");
    const pulledQuestion = await dbV7.questions.get(question.id);
    assert.ok(pulledQuestion, "device-b 应看到题目");
    const note = await dbV7.notes.get(question.id);
    assert.equal(note?.content, "这是一条个人解析，应随同步迁移到其他设备。", "个人解析应同步");
    assert.ok(await dbV7.bankFolders.get(folder.id), "device-b 应看到题库文件夹");
    console.log("scenario 2 passed: 题库/题目/解析/文件夹跨设备传播");
  }

  // --- Scenario 3: delete propagation (cascade) ---------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();

    const bank = await createBankV7("删除级联题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("删除级联题 1", "A", ["对", "错", "x", "y"]));
    const q2 = await createQuestionV7(bank.id, singleChoice("删除级联题 2", "B", ["对", "错", "x", "y"]));
    await sync();
    await deleteBankWithExclusiveQuestionsV7(bank.id);
    await sync();

    await freshClient("device-b");
    await sync();

    assert.ok(!(await dbV7.banks.get(bank.id)), "device-b 不应再看到已删除题库");
    assert.ok(!(await dbV7.questions.get(q1.id)), "级联删除的题目 1 不应残留");
    assert.ok(!(await dbV7.questions.get(q2.id)), "级联删除的题目 2 不应残留");
    console.log("scenario 3 passed: 题库级联删除跨设备传播");
  }

  // --- Scenario 4: incremental multi-device merge -------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();

    const bank = await createBankV7("增量合并题库");
    const q1 = await createQuestionV7(bank.id, singleChoice("增量题 A", "A", ["甲", "乙", "丙", "丁"]));
    await sync();

    await freshClient("device-b");
    await sync(); // pull q1
    const q2 = await createQuestionV7(bank.id, singleChoice("增量题 B", "B", ["甲", "乙", "丙", "丁"]));
    await sync(); // push q2

    await freshClient("device-a");
    await sync(); // pull q2

    assert.ok(await dbV7.questions.get(q1.id), "device-a 应保留 q1");
    assert.ok(await dbV7.questions.get(q2.id), "device-a 应拉取到 device-b 新增的 q2");
    console.log("scenario 4 passed: 两台设备各自新增题目后双向合并");
  }

  // --- Scenario 5: idempotent re-sync -------------------------------------
  {
    server.reset();
    await freshClient("device-a");
    await sync();

    await createBankV7("幂等题库");
    const first = await sync();
    assert.ok(first.pushed >= 1, "首次同步应上传变更");
    const second = await sync();
    assert.equal(second.pushed, 0, "二次同步不应重复上传");
    console.log("scenario 5 passed: 重复同步幂等");
  }

  // --- Scenario 6: oversized practice run offloads to an immutable ref -----
  // Reproduces the reported "v7 event exceeds 262144 UTF-8 bytes" crash: a run
  // over a large bank carries thousands of answers in one change-set, far past
  // the 256 KiB inline ceiling. It must be offloaded, not rejected.
  {
    server.reset();
    await freshClient("device-a");
    await sync();

    const rows = Array.from({ length: 1800 }, (_, index) => ({
      stem: `大练习第 ${index + 1} 题：考点 ${index} 描述，下列哪项正确？`,
      type: "单选",
      options: ["甲", "乙", "丙", "丁"],
      answer: "A",
    }));
    const bank = await importQuestionBankV7("大练习题库.json", rows);
    const questionIds = (await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).toArray()).map((membership) => membership.questionId);
    assert.equal(questionIds.length, 1800, "练习应覆盖全部题目");

    const runAt = new Date().toISOString();
    const bigRun: PracticeRunV7 = {
      id: "run-big",
      bankId: bank.id,
      bankIds: [bank.id],
      bankName: "大练习",
      mode: "sequential",
      modeLabel: "练习",
      questionIds,
      questionTypes: Object.fromEntries(questionIds.map((id) => [id, "单选"])),
      answers: Object.fromEntries(questionIds.map((id, index) => [id, { selected: ["A"], submitted: true, correct: true, updatedAt: runAt, deviceId: "device-a", eventId: `ev-${index}` }])),
      shuffleOptions: false,
      optionOrders: {},
      startedAt: runAt,
      updatedAt: runAt,
      status: "completed",
      revision: 1,
    };
    await savePracticeRunV7(bigRun);
    const pushResult = await sync();
    assert.ok(pushResult.pushed > 0, "大练习应作为变更推送");
    assert.ok(server.contentPaths().filter((path) => path.startsWith("sync/v9/objects/")).length >= 2, "大题库导入与大练习都应各自卸载为不可变对象");

    await freshClient("device-b");
    await sync();
    assert.equal(await dbV7.questions.count(), 1800, "新设备应拉取到大题库");
    const pulledRun = await dbV7.practiceRuns.get("run-big");
    assert.ok(pulledRun, "新设备应拉取到大练习");
    assert.equal(pulledRun!.status, "completed", "练习状态应一致");
    assert.equal(Object.keys(pulledRun!.answers).length, 1800, "全部作答应随同步迁移到新设备");
    console.log("scenario 6 passed: 超大练习（>256 KiB）通过不可变对象卸载后跨设备一致");
  }

  console.log("mock sync integration tests passed");
} finally {
  await server.close();
  dbV7.close();
}