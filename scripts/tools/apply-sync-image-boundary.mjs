import fs from "node:fs";

function patch(path, replacements) {
  let source = fs.readFileSync(path, "utf8");
  for (const [from, to, label] of replacements) {
    if (!source.includes(from)) throw new Error(`image sync boundary: missing ${label}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(path, source);
}

patch("src/lib/sync/sync-application.ts", [
  [
    `import {\n  getGitHubLogin,`,
    `import {\n  clearImageCache as clearImageCacheInternal,\n  downloadAllImageAssets as downloadAllImageAssetsInternal,\n  downloadImageAsset as downloadImageAssetInternal,\n  getImageCacheStats as getImageCacheStatsInternal,\n  getGitHubLogin,`,
    "image facade imports",
  ],
  [
    `  getHotWindow(settings = loadGitHubSettings()): Promise<SyncHotWindowState | null> {\n    return settings.owner && settings.repo ? getSyncHotWindowState(settings) : Promise.resolve(null);\n  }\n`,
    `  getHotWindow(settings = loadGitHubSettings()): Promise<SyncHotWindowState | null> {\n    return settings.owner && settings.repo ? getSyncHotWindowState(settings) : Promise.resolve(null);\n  }\n\n  getImageCacheStats() {\n    return getImageCacheStatsInternal();\n  }\n\n  clearImageCache() {\n    return clearImageCacheInternal();\n  }\n\n  async downloadImageAsset(assetId: string): Promise<void> {\n    const { settings, token } = await this.resolveConnection();\n    await downloadImageAssetInternal(settings, token, assetId);\n  }\n\n  async downloadAllImageAssets(): Promise<number> {\n    const { settings, token } = await this.resolveConnection();\n    return downloadAllImageAssetsInternal(settings, token);\n  }\n`,
    "image facade methods",
  ],
]);

patch("src/app/bank/question-editor.tsx", [
  [
    `import { downloadImageAsset } from "@/lib/sync/github-sync";\nimport { getQuestionViewV7, type QuestionViewV7 } from "@/lib/db/app-data-v7";\nimport { loadGitHubSettings, loadGitHubToken } from "@/lib/sync/github-credentials";`,
    `import { syncApplication } from "@/lib/sync/sync-application";\nimport { getQuestionViewV7, type QuestionViewV7 } from "@/lib/db/app-data-v7";`,
    "question editor imports",
  ],
  [
    `    const settings = loadGitHubSettings();\n    const token = loadGitHubToken();\n    if (!settings.repo || !token) return undefined;\n    await downloadImageAsset(settings, token, assetId);`,
    `    if (!syncApplication.getConnection().ready) return undefined;\n    await syncApplication.downloadImageAsset(assetId);`,
    "question editor image hydration",
  ],
]);

patch("src/app/shell/views/image-cache-setting.tsx", [
  [
    `import { getImageCacheSizeV7 } from "@/lib/db/db-v7";\nimport { loadGitHubSettings, loadGitHubToken } from "@/lib/sync/github-credentials";\nimport { clearImageCache, downloadAllImageAssets, getImageCacheStats } from "@/lib/sync/github-sync";`,
    `import { getImageCacheSizeV7 } from "@/lib/db/db-v7";\nimport { syncApplication } from "@/lib/sync/sync-application";`,
    "image cache setting imports",
  ],
  [
    `      const stats = await getImageCacheStats();`,
    `      const stats = await syncApplication.getImageCacheStats();`,
    "image cache stats",
  ],
  [
    `    const settings = loadGitHubSettings();\n    const token = loadGitHubToken();\n    if (!settings.repo || !token) { onNotice("请先在同步页面配置 GitHub，才能缓存远程图片"); return; }`,
    `    if (!syncApplication.getConnection().ready) { onNotice("请先在同步页面配置 GitHub，才能缓存远程图片"); return; }`,
    "image cache connection",
  ],
  [
    `      await downloadAllImageAssets(settings, token);`,
    `      await syncApplication.downloadAllImageAssets();`,
    "image cache download all",
  ],
  [
    `      await clearImageCache();`,
    `      await syncApplication.clearImageCache();`,
    "image cache clear",
  ],
]);

console.log("image sync boundary migration applied");
