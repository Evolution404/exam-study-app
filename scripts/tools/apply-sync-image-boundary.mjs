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
    `import {\n  downloadImageAsset as downloadImageAssetFromGitHub,\n  getGitHubLogin,`,
    "image facade import",
  ],
  [
    `  getHotWindow(settings = loadGitHubSettings()): Promise<SyncHotWindowState | null> {\n    return settings.owner && settings.repo ? getSyncHotWindowState(settings) : Promise.resolve(null);\n  }\n`,
    `  getHotWindow(settings = loadGitHubSettings()): Promise<SyncHotWindowState | null> {\n    return settings.owner && settings.repo ? getSyncHotWindowState(settings) : Promise.resolve(null);\n  }\n\n  async downloadImageAsset(assetId: string): Promise<void> {\n    const { settings, token } = await this.resolveConnection();\n    await downloadImageAssetFromGitHub(settings, token, assetId);\n  }\n`,
    "image facade method",
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

console.log("image sync boundary migration applied");
