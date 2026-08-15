import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "fake-indexeddb/auto";
import { createBankV6, dbV6, putImageAssetV6, resetV6Database } from "../../lib/db/db-v6";
import { syncWithGitHub } from "../../lib/sync/github-sync-v7";
import { createGitHubV7Remote } from "../../lib/sync/github-v7-remote";
import { SYNC_V7_ASSET_PREFIX } from "../../lib/sync/sync-v7-head";
import { downloadImageAssetV6 } from "../../lib/sync/image-asset-cache";
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
  await resetV6Database();
  const settings = { owner: "qa", repo: "mock-vault", branch: "main", apiBaseUrl: server.url };
  const labels: string[] = [];

  // First sync against an empty mock: initializes the vault and folds any local
  // baseline into the initial checkpoint (pushed: 0 is correct here).
  const init = await syncWithGitHub(settings, "qa-token", (progress) => labels.push(progress.label));
  assert.equal(init.formatVersion, 7, "同步协议版本应为 7");
  assert.equal(init.remaining, 0, "初始化后应无待办");

  // A change-set created AFTER the baseline exists is what the push path uploads.
  await createBankV6("同步后端契约测试题库");
  const pendingBefore = await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.ok(pendingBefore >= 1, "建库应产生待同步变更");

  const push = await syncWithGitHub(settings, "qa-token");
  assert.equal(push.pushed, 1, "应上传 1 组变更");
  assert.equal(push.remaining, 0, "同步后应无待办");
  assert.ok(labels.length > 0, "应回报同步进度");

  const committed = await dbV6.changeSets.where("state").equals("committed").count();
  assert.ok(committed >= 1, "变更应已提交到云端");
  const pendingAfter = await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  assert.equal(pendingAfter, 0, "同步后本地无待办");

  // Third sync against the same mock state: nothing new to push, stays consistent.
  const again = await syncWithGitHub(settings, "qa-token");
  assert.equal(again.pushed, 0, "二次同步不应重复上传");
  assert.equal(again.remaining, 0);

  // Image-blob download round-trip: downloadImageAssetV6 must fetch a v7 Git
  // blob by blobSha and verify integrity, independent of the legacy transport.
  const imageBytes = Buffer.from("fake-png-bytes-for-roundtrip");
  const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
  const imagePath = `${SYNC_V7_ASSET_PREFIX}${imageDigest}.png`;
  const uploadedImage = await createGitHubV7Remote({ owner: settings.owner, repo: settings.repo, branch: "main", token: "qa-token", apiBaseUrl: server.url }).putImmutable({ path: imagePath, bytes: imageBytes, kind: "asset" });
  await putImageAssetV6({ id: imageDigest, mimeType: "image/png", size: imageBytes.length, width: 1, height: 1, remote: { path: imagePath, blobSha: uploadedImage.blobSha, sha256: imageDigest, size: imageBytes.length } });
  const downloaded = await downloadImageAssetV6(settings, "qa-token", imageDigest);
  assert.equal(downloaded.size, imageBytes.length, "下载的图片 blob 大小应一致");
  assert.equal(createHash("sha256").update(Buffer.from(await downloaded.arrayBuffer())).digest("hex"), imageDigest, "下载的图片 blob sha256 应一致");

  console.log("mock github backend sync contract passed");
} finally {
  await server.close();
  dbV6.close();
}
