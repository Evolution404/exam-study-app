import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, importQuestionBankV7, putImageAssetV7, resetV7Database } from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { SYNC_V9_ASSET_PREFIX } from "../../src/lib/sync/sync-v7-head-types";
import { downloadImageAssetV7 } from "../../src/lib/sync/image-asset-cache";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

const server = await startMockGitHubServer();
try {
  await resetV7Database();
  const settings = { owner: "qa", repo: "mock-vault", branch: "main", apiBaseUrl: server.url };
  const labels: string[] = [];

  const init = await syncWithGitHub(settings, "qa-token", (progress) => labels.push(progress.label));
  assert.equal(init.formatVersion, 9, "同步协议版本应为 9");
  assert.equal(init.remaining, 0, "初始化后应无待办");

  await createBankV7("同步后端契约测试题库");
  const pendingBefore = await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.ok(pendingBefore >= 1, "建库应产生待同步变更");

  const push = await syncWithGitHub(settings, "qa-token");
  assert.equal(push.pushed, 1, "应上传 1 组变更");
  assert.equal(push.remaining, 0, "同步后应无待办");
  assert.ok(labels.length > 0, "应回报同步进度");

  const committed = await dbV7.changeSets.where("state").equals("committed").count();
  assert.ok(committed >= 1, "变更应已提交到云端");
  assert.equal(await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count(), 0, "同步后本地无待办");

  const again = await syncWithGitHub(settings, "qa-token");
  assert.equal(again.pushed, 0, "二次同步不应重复上传");
  assert.equal(again.remaining, 0);

  // New images are physically published as packs. The global Asset Index is the only runtime locator.
  const localImageBytes = Buffer.from("local-image-blob-bytes-for-push");
  const localImageDigest = createHash("sha256").update(localImageBytes).digest("hex");
  await putImageAssetV7({ id: localImageDigest, blob: new Blob([localImageBytes]), mimeType: "image/png", size: localImageBytes.length, width: 1, height: 1 });
  const refUpdatesBeforeImage = server.stats.gitRefUpdates;
  const imagePush = await syncWithGitHub(settings, "qa-token");
  assert.ok(imagePush.pushed >= 1, "新图片应发布资产事件");
  assert.equal(server.stats.gitRefUpdates - refUpdatesBeforeImage, 1, "一轮图片物理发布只能 fast-forward 一次 Git ref");
  assert.ok(server.contentPaths().includes(`${SYNC_V9_ASSET_PREFIX}index.json`), "远端必须存在 Asset Pack index 指针");
  assert.ok(server.contentPaths().some((path) => path.startsWith(SYNC_V9_ASSET_PREFIX) && path.endsWith(".bin")), "远端必须存在内容寻址 Pack/shard");
  assert.equal(server.contentPaths().includes(`${SYNC_V9_ASSET_PREFIX}${localImageDigest}.png`), false, "新协议不得创建单图路径");

  // image.asset.save is still ordered before a question event, but the event
  // carries only logical image metadata. Binary location lives outside events.
  const imageQuestionBytes = Buffer.from("image-question-blob-bytes");
  const imageQuestionDigest = createHash("sha256").update(imageQuestionBytes).digest("hex");
  await putImageAssetV7({ id: imageQuestionDigest, blob: new Blob([imageQuestionBytes]), mimeType: "image/png", size: imageQuestionBytes.length, width: 1, height: 1 });
  const bank = await dbV7.banks.orderBy("sortOrder").first();
  assert.ok(bank, "测试需要已存在的题库");
  await createQuestionV7(bank.id, {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: "看图作答" }, { id: "img-0", type: "image", assetId: imageQuestionDigest }],
    options: [[{ id: "opt-a", type: "text", text: "甲" }], [{ id: "opt-b", type: "text", text: "乙" }]],
    optionIds: ["opt-a", "opt-b"],
    solution: { kind: "choice", correctOptionIds: ["opt-a"] },
  });
  const imageQuestionPush = await syncWithGitHub(settings, "qa-token");
  assert.equal(imageQuestionPush.pushed, 2, "应推送 image.asset.save 与题目 batch 两组逻辑变更");
  assert.equal(server.contentPaths().includes(`${SYNC_V9_ASSET_PREFIX}${imageQuestionDigest}.png`), false, "题目图片不得落回旧单图路径");

  // Excel/ZIP-style imports keep one fixed question.import event. Eight images
  // are physically grouped into packs and published through ONE Git commit/ref
  // update, so request/commit count scales with packs rather than image count.
  const concurrentAssets = Array.from({ length: 8 }, (_, index) => {
    const bytes = Buffer.from(`concurrent-import-image-${index}-${"x".repeat(index + 1)}`);
    const id = createHash("sha256").update(bytes).digest("hex");
    return { id, bytes, mimeType: "image/png" as const, size: bytes.length, width: 1, height: 1 };
  });
  const concurrentImageDescriptors = [];
  for (const asset of concurrentAssets) {
    const stored = await putImageAssetV7({ id: asset.id, blob: new Blob([asset.bytes]), mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height });
    const { blob: _blob, ...descriptor } = stored;
    void _blob;
    concurrentImageDescriptors.push(descriptor);
  }
  await importQuestionBankV7("并发图片导入.json", [{
    type: "单选",
    content: [
      { type: "text", text: "Pack 批量上传图片" },
      ...concurrentAssets.map((asset) => ({ type: "image", assetId: asset.id })),
    ],
    options: ["甲", "乙"],
    answer: "A",
  }], { imageAssets: concurrentImageDescriptors });
  const fixedPendingCount = await dbV7.changeSets.where("state").equals("pending").count();
  assert.equal(fixedPendingCount, 1, "导入完成时同步事件数量应已经固定为 1");
  const fixedImport = (await dbV7.changeSets.where("state").equals("pending").first())!;
  const fixedMutation = fixedImport.mutations.find((mutation) => mutation.kind === "question.import");
  assert.equal(fixedMutation?.kind, "question.import");
  assert.equal(fixedMutation.images?.length, concurrentAssets.length, "固定事件应预先包含全部图片描述");

  server.stats.gitBlobWrites = 0;
  server.stats.gitCommitWrites = 0;
  server.stats.gitRefUpdates = 0;
  server.stats.assetWrites = 0;
  const imageProgressLabels: string[] = [];
  let maxPendingDuringSync = fixedPendingCount;
  const pendingMonitor = setInterval(() => {
    void dbV7.changeSets.where("state").equals("pending").count().then((count) => {
      maxPendingDuringSync = Math.max(maxPendingDuringSync, count);
    });
  }, 2);
  const concurrentPush = await syncWithGitHub(settings, "qa-token", (progress) => imageProgressLabels.push(progress.label));
  clearInterval(pendingMonitor);
  assert.equal(concurrentPush.pushed, 1, "图片导入应只发布原有的 1 个固定事件");
  assert.equal(maxPendingDuringSync, fixedPendingCount, "同步期间事件数量不应随图片发布而增长");
  assert.equal(server.stats.assetWrites, 0, "Pack 协议不得调用 Contents API 写单图资产");
  assert.equal(server.stats.gitCommitWrites, 1, "八张图片的物理资产发布必须只创建一个 Git commit");
  assert.equal(server.stats.gitRefUpdates, 1, "八张图片的物理资产发布必须只更新一次 Git ref");
  assert.ok(server.stats.gitBlobWrites < concurrentAssets.length, "八张小图应被聚合，Git blob 请求数必须小于图片数");
  assert.ok(imageProgressLabels.some((label) => /正在上传图片（\d+\/8，/.test(label)), "同步栏应显示图片张数和字节进度");
  assert.ok(imageProgressLabels.some((label) => /图片上传完成（8\/8，/.test(label)), "同步栏应显示图片上传完成进度");

  // Batch-backed single-image read: remove the local blob, then load it through
  // Asset Index → shard → Pack. Use a semantically equivalent API base URL with
  // a dot segment so the module-level runtime cache key is fresh while fetch
  // still reaches the same mock server — this models a new app process/device.
  const imageBytes = Buffer.from("pack-download-roundtrip");
  const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
  await putImageAssetV7({ id: imageDigest, blob: new Blob([imageBytes]), mimeType: "image/png", size: imageBytes.length, width: 1, height: 1 });
  await syncWithGitHub(settings, "qa-token");
  await dbV7.imageAssets.update(imageDigest, { blob: undefined });
  const readsBefore = server.stats.blobReads;
  const freshRuntimeSettings = { ...settings, apiBaseUrl: `${server.url}/.` };
  const downloaded = await downloadImageAssetV7(freshRuntimeSettings, "qa-token", imageDigest);
  assert.equal(downloaded.size, imageBytes.length, "Pack 下载的图片 blob 大小应一致");
  assert.equal(createHash("sha256").update(Buffer.from(await downloaded.arrayBuffer())).digest("hex"), imageDigest, "Pack 下载图片 sha256 应一致");
  assert.ok(server.stats.blobReads > readsBefore, "新运行时缓存缺失时应读取 shard/Pack blob");

  // Empty-vault bootstrap follows the same physical rule: all initial images
  // are packed before the initial checkpoint and still produce one Git ref
  // update for their asset transaction.
  await resetV7Database();
  const bootstrapSettings = { ...settings, repo: "mock-vault-image-bootstrap" };
  const bootstrapAssets = Array.from({ length: 3 }, (_, index) => {
    const bytes = Buffer.from(`bootstrap-image-${index}`);
    return { id: createHash("sha256").update(bytes).digest("hex"), bytes };
  });
  const bootstrapDescriptors = [];
  for (const asset of bootstrapAssets) {
    const stored = await putImageAssetV7({ id: asset.id, blob: new Blob([asset.bytes]), mimeType: "image/png", size: asset.bytes.length, width: 1, height: 1 });
    const { blob: _blob, ...descriptor } = stored;
    void _blob;
    bootstrapDescriptors.push(descriptor);
  }
  await importQuestionBankV7("首次同步图片.json", [{
    type: "单选",
    content: [{ type: "text", text: "首次同步" }, ...bootstrapAssets.map((asset) => ({ type: "image", assetId: asset.id }))],
    options: ["甲", "乙"],
    answer: "A",
  }], { imageAssets: bootstrapDescriptors });
  assert.equal(await dbV7.changeSets.where("state").equals("pending").count(), 1, "首次同步前也应只有一个固定导入事件");
  const bootstrapRefBefore = server.stats.gitRefUpdates;
  const bootstrapCommitBefore = server.stats.gitCommitWrites;
  const bootstrapLabels: string[] = [];
  const bootstrap = await syncWithGitHub(bootstrapSettings, "qa-token", (progress) => bootstrapLabels.push(progress.label));
  assert.equal(bootstrap.remaining, 0, "首次同步完成后不应遗留补图片事件");
  assert.equal(server.stats.gitRefUpdates - bootstrapRefBefore, 1, "首次三图也应只有一个资产 Git ref 更新");
  assert.equal(server.stats.gitCommitWrites - bootstrapCommitBefore, 1, "首次三图也应只有一个资产 Git commit");
  assert.ok(bootstrapLabels.some((label) => /正在上传图片（\d+\/3，/.test(label)), "首次同步也应显示图片上传进度");

  console.log("mock github backend sync + current asset-pack contract passed");
} finally {
  await server.close();
  dbV7.close();
}