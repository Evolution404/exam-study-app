import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "fake-indexeddb/auto";
import { createBankV7, createQuestionV7, dbV7, importQuestionBankV7, putImageAssetV7, resetV7Database } from "../../src/lib/db/db-v7";
import { syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { createGitHubV7Remote } from "../../src/lib/sync/github-v7-remote";
import { SYNC_V7_ASSET_PREFIX } from "../../src/lib/sync/sync-v7-head";
import { downloadImageAssetV7 } from "../../src/lib/sync/image-asset-cache";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// The browser-driven sync test covers the UI; this fast, Chrome-free test pins
// down the HTTP contract between the real GitHubV7Remote client and the local
// mock backend: a full successful v7 sync (init + upload + idempotent re-sync)
// must run end to end against the in-memory server.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

const server = await startMockGitHubServer();
try {
  await resetV7Database();
  const settings = { owner: "qa", repo: "mock-vault", branch: "main", apiBaseUrl: server.url };
  const labels: string[] = [];

  // First sync against an empty mock: initializes the vault and folds any local
  // baseline into the initial checkpoint (pushed: 0 is correct here).
  const init = await syncWithGitHub(settings, "qa-token", (progress) => labels.push(progress.label));
  assert.equal(init.formatVersion, 8, "同步协议版本应为 8");
  assert.equal(init.remaining, 0, "初始化后应无待办");

  // A change-set created AFTER the baseline exists is what the push path uploads.
  await createBankV7("同步后端契约测试题库");
  const pendingBefore = await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.ok(pendingBefore >= 1, "建库应产生待同步变更");

  const push = await syncWithGitHub(settings, "qa-token");
  assert.equal(push.pushed, 1, "应上传 1 组变更");
  assert.equal(push.remaining, 0, "同步后应无待办");
  assert.ok(labels.length > 0, "应回报同步进度");

  const committed = await dbV7.changeSets.where("state").equals("committed").count();
  assert.ok(committed >= 1, "变更应已提交到云端");
  const pendingAfter = await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingAfter, 0, "同步后本地无待办");

  // Third sync against the same mock state: nothing new to push, stays consistent.
  const again = await syncWithGitHub(settings, "qa-token");
  assert.equal(again.pushed, 0, "二次同步不应重复上传");
  assert.equal(again.remaining, 0);

  // 本地图片资产（无 remote）在下次推送时必须先上传到 v7 asset namespace，
  // 再以 image.asset.save 事件发布 remote descriptor。
  const localImageBytes = Buffer.from("local-image-blob-bytes-for-push");
  const localImageDigest = createHash("sha256").update(localImageBytes).digest("hex");
  await putImageAssetV7({ id: localImageDigest, blob: new Blob([localImageBytes]), mimeType: "image/png", size: localImageBytes.length, width: 1, height: 1 });
  assert.equal((await dbV7.imageAssets.get(localImageDigest))?.remote, undefined, "上传前不应有 remote descriptor");
  const imagePush = await syncWithGitHub(settings, "qa-token");
  assert.ok(imagePush.pushed >= 1, "图片资产上传应作为一组变更推送");
  const publishedAsset = await dbV7.imageAssets.get(localImageDigest);
  assert.ok(publishedAsset?.remote, "推送后应写回 remote descriptor");
  assert.equal(publishedAsset.remote.path, `${SYNC_V7_ASSET_PREFIX}${localImageDigest}.png`, "图片资产路径应为 sync/v8/assets/<sha256>.png");

  // 图片题目的跨设备顺序：image.asset.save 必须先于 question.upsert 回放。
  const imageQuestionBytes = Buffer.from("image-question-blob-bytes");
  const imageQuestionDigest = createHash("sha256").update(imageQuestionBytes).digest("hex");
  await putImageAssetV7({ id: imageQuestionDigest, blob: new Blob([imageQuestionBytes]), mimeType: "image/png", size: imageQuestionBytes.length, width: 1, height: 1 });
  const bank = await dbV7.banks.orderBy("sortOrder").first();
  assert.ok(bank, "测试需要已存在的题库");
  await createQuestionV7(bank.id, {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: "看图作答" }, { id: "img-0", type: "image", assetId: imageQuestionDigest }],
    options: [[{ id: "opt-a", type: "text", text: "甲" }], [{ id: "opt-b", type: "text", text: "乙" }]],
    answer: "A",
  });
  const imageQuestionPush = await syncWithGitHub(settings, "qa-token");
  assert.equal(imageQuestionPush.pushed, 2, "应推送 image.asset.save 与题目 batch 两组变更");
  assert.ok(server.contentPaths().includes(`${SYNC_V7_ASSET_PREFIX}${imageQuestionDigest}.png`), "mock 远端应收到图片资产");
  const imageQuestionAsset = await dbV7.imageAssets.get(imageQuestionDigest);
  assert.ok(imageQuestionAsset?.remote, "题目图片资产应写回 remote descriptor");

  // Excel/zip-style imports own all image descriptors inside ONE fixed import
  // event. Asset PUTs run through six bounded lanes and only rewrite that event
  // in place, so the pending badge cannot grow from 1 to N while images finish.
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
      { type: "text", text: "并发上传图片" },
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

  server.stats.assetWrites = 0;
  server.stats.maxConcurrentAssetWrites = 0;
  server.setAssetWriteLatency(40);
  const imageProgressLabels: string[] = [];
  let maxPendingDuringSync = fixedPendingCount;
  const pendingMonitor = setInterval(() => {
    void dbV7.changeSets.where("state").equals("pending").count().then((count) => {
      maxPendingDuringSync = Math.max(maxPendingDuringSync, count);
    });
  }, 2);
  const concurrentPush = await syncWithGitHub(settings, "qa-token", (progress) => imageProgressLabels.push(progress.label));
  clearInterval(pendingMonitor);
  server.setAssetWriteLatency(0);
  assert.equal(concurrentPush.pushed, 1, "图片导入应只发布原有的 1 个固定事件");
  assert.equal(maxPendingDuringSync, fixedPendingCount, "同步期间事件数量不应随图片上传完成而增长");
  assert.equal(server.stats.assetWrites, concurrentAssets.length, "每张新图片应上传一次");
  assert.ok(server.stats.maxConcurrentAssetWrites >= 2, "图片 PUT 应实际并发重叠");
  assert.ok(server.stats.maxConcurrentAssetWrites <= 6, "图片 PUT 并发不得超过 6 路上限");
  assert.ok(imageProgressLabels.some((label) => /正在上传图片（\d+\/8，/.test(label)), "同步栏应显示图片张数和字节进度");
  assert.ok(imageProgressLabels.some((label) => /图片上传完成（8\/8，/.test(label)), "同步栏应显示图片上传完成进度");
  assert.ok((await dbV7.imageAssets.bulkGet(concurrentAssets.map((asset) => asset.id))).every((asset) => asset?.remote), "并发上传后每张图片都应写回远端描述");

  // Image-blob download round-trip: downloadImageAssetV7 must fetch a v7 Git
  // blob by blobSha and verify integrity, independent of the legacy transport.
  const imageBytes = Buffer.from("fake-png-bytes-for-roundtrip");
  const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
  const imagePath = `${SYNC_V7_ASSET_PREFIX}${imageDigest}.png`;
  const uploadedImage = await createGitHubV7Remote({ owner: settings.owner, repo: settings.repo, branch: "main", token: "qa-token", apiBaseUrl: server.url }).putImmutable({ path: imagePath, bytes: imageBytes, kind: "asset" });
  await putImageAssetV7({ id: imageDigest, mimeType: "image/png", size: imageBytes.length, width: 1, height: 1, remote: { path: imagePath, blobSha: uploadedImage.blobSha, sha256: imageDigest, size: imageBytes.length } });
  const downloaded = await downloadImageAssetV7(settings, "qa-token", imageDigest);
  assert.equal(downloaded.size, imageBytes.length, "下载的图片 blob 大小应一致");
  assert.equal(createHash("sha256").update(Buffer.from(await downloaded.arrayBuffer())).digest("hex"), imageDigest, "下载的图片 blob sha256 应一致");

  // Empty-vault bootstrap follows the same rule: upload blobs first, rewrite
  // the one import event, then fold it into the initial checkpoint.
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
  const bootstrapWritesBefore = server.stats.assetWrites;
  const bootstrapLabels: string[] = [];
  const bootstrap = await syncWithGitHub(bootstrapSettings, "qa-token", (progress) => bootstrapLabels.push(progress.label));
  assert.equal(bootstrap.remaining, 0, "首次同步完成后不应遗留补图片事件");
  assert.equal(server.stats.assetWrites - bootstrapWritesBefore, bootstrapAssets.length, "首次检查点前应上传全部图片一次");
  assert.ok(bootstrapLabels.some((label) => /正在上传图片（\d+\/3，/.test(label)), "首次同步也应显示图片上传进度");
  assert.ok((await dbV7.imageAssets.bulkGet(bootstrapAssets.map((asset) => asset.id))).every((asset) => asset?.remote), "首次同步应写回所有图片远端描述");

  console.log("mock github backend sync contract passed");
} finally {
  await server.close();
  dbV7.close();
}
