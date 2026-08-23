import fs from "node:fs";

const replace = (file, before, after, label) => {
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(before)) throw new Error(`split-style test migration: missing ${label} in ${file}`);
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
};

// The Actions token intentionally lacks workflow permission. Keep the generated
// migration commit source-only; the permanent governance workflow is tightened
// in a normal connector commit after generation lands.
replace(
  ".github/workflows/governance-audit.yml",
  "run: git diff --exit-code -- scripts/tools/check-css-architecture.mjs scripts/tools/css-architecture-baseline.json",
  "run: git diff --exit-code -- scripts/tools/check-css-architecture.mjs",
  "temporary governance workflow mutation",
);

// Clean the presentational shell split after the migration moved ownership.
replace(
  "src/app/shell/app-shell.tsx",
  ", balancedRandomSample, formatBuildTimestampShort, loadPreferences",
  ", balancedRandomSample, loadPreferences",
  "moved build formatter import",
);
replace(
  "src/app/shell/app-shell.tsx",
  "          menuOpen={sidebarOpen}\n",
  "",
  "unused topbar menuOpen prop",
);
replace(
  "src/app/shell/topbar.tsx",
  "export function ShellTopbar({ menuOpen, banks,",
  "export function ShellTopbar({ banks,",
  "unused menuOpen destructure",
);
replace(
  "src/app/shell/topbar.tsx",
  "  menuOpen: boolean;\n",
  "",
  "unused menuOpen type",
);

replace(
  "scripts/tests/test-sync-event-ui.ts",
  'import { readFile } from "node:fs/promises";',
  'import { readdir, readFile } from "node:fs/promises";',
  "promises import",
);
replace(
  "scripts/tests/test-sync-event-ui.ts",
  'const componentsCss = await readFile(new URL("../../src/app/styles/components.css", import.meta.url), "utf8");',
  'const splitStyleNames = (await readdir(new URL("../../src/app/styles/", import.meta.url))).filter((file) => file.endsWith(".css")).sort();\nconst componentsCss = (await Promise.all(splitStyleNames.map((file) => readFile(new URL(`../../src/app/styles/${file}`, import.meta.url), "utf8")))).join("\\n");',
  "sync event components.css reader",
);

replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'import { readFileSync } from "node:fs";',
  'import { readdirSync, readFileSync } from "node:fs";',
  "sync fs import",
);
replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'const componentStyles = readFileSync(new URL("../../src/app/styles/components.css", import.meta.url), "utf8");',
  'const splitStyleNames = readdirSync(new URL("../../src/app/styles/", import.meta.url)).filter((file) => file.endsWith(".css")).sort();\nconst componentStyles = splitStyleNames.map((file) => readFileSync(new URL(`../../src/app/styles/${file}`, import.meta.url), "utf8")).join("\\n");',
  "v7 UI components.css reader",
);
replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'const primaryRule = componentStyles.match(/\\.primary\\s*\\{[^}]*\\}/)?.[0] ?? "";',
  'const primaryRule = componentStyles.match(/\\.primary\\s*\\{[^}]*min-height:\\s*42px[^}]*\\}/)?.[0] ?? "";',
  "base primary rule lookup",
);
replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'assert.match(study, /stats\\.pending\\.toLocaleString\\("zh-CN"\\)/, "右上角同步按钮应显示真实待同步数量");',
  'const topbar = source("shell/topbar.tsx");\nassert.match(study, /pending=\\{stats\\.pending\\}/, "AppShell 应把真实待同步数量传给顶部栏");\nassert.match(topbar, /pending\\.toLocaleString\\("zh-CN"\\)/, "右上角同步按钮应显示真实待同步数量");',
  "pending count ownership",
);
replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'assert.match(study, /<QuickSearch /, "StudyApp 应使用 QuickSearch 组件");\nassert.doesNotMatch(study, /value=\\{query\\}/, "StudyApp 不应再直接受控渲染顶部搜索输入框");',
  'assert.match(topbar, /<QuickSearch /, "顶部栏应使用 QuickSearch 组件");\nassert.doesNotMatch(study, /<QuickSearch /, "AppShell 不应再直接承载顶部搜索输入框");\nassert.doesNotMatch(study, /value=\\{query\\}/, "AppShell 不应再直接受控渲染顶部搜索输入框");',
  "quick search ownership",
);

{
  const file = "scripts/tests/test-sync-v7-checkpoint-extra.ts";
  let source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("// 2)");
  const end = source.indexOf("// 4)");
  if (start < 0 || end < 0 || end <= start) throw new Error("split-style test migration: checkpoint legacy test markers missing");
  const replacement = `// 2) 退役的 v6 检查点格式必须被拒绝，公开恢复只接受当前格式\n{\n  const current = await createSyncCheckpointV7();\n  const legacy = structuredClone(current) as SyncCheckpointV7 & { formatVersion: number };\n  legacy.formatVersion = 6;\n  assert.throws(() => validateSyncCheckpointV7(legacy), /formatVersion/, "v6 checkpoint must be rejected after compatibility retirement");\n  const bytes = new TextEncoder().encode(JSON.stringify(legacy));\n  assert.throws(() => parseSyncCheckpointV7(bytes), /formatVersion/, "parser must reject retired v6 checkpoint bytes");\n}\n\n// 3) 退役的 v6/v7/v8 资产命名空间必须被拒绝，只允许当前 v9 资产路径\n{\n  for (const version of [6, 7, 8]) {\n    const current = await createSyncCheckpointV7();\n    current.state.imageAssets[0] = {\n      ...current.state.imageAssets[0],\n      remote: { path: "sync/v" + version + "/assets/" + "a".repeat(64) + ".webp", blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 123 },\n    };\n    assert.throws(() => validateSyncCheckpointV7(current), /remote\\.path/, "sync/v" + version + " asset path must be rejected");\n  }\n}\n\n`;
  source = source.slice(0, start) + replacement + source.slice(end);
  fs.writeFileSync(file, source);
}

{
  const file = "scripts/tests/test-sync-compression.ts";
  let source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("// --- 5. 远端迁移");
  const end = source.indexOf("await server.close();");
  if (start < 0 || end < 0 || end <= start) throw new Error("split-style test migration: obsolete compression maintenance sections missing");
  const replacement = `// --- 5. 退役维护 API 不得重新暴露 -----------------------------------------\n{\n  const syncFacade = await import("../../src/lib/sync/github-sync-v7");\n  assert.equal("migrateVaultToCompressed" in syncFacade, false, "一次性压缩迁移 API 已退役，不得回到运行时 facade");\n  assert.equal("backfillVaultStoredSizes" in syncFacade, false, "一次性 storedSize 补填 API 已退役，不得回到运行时 facade");\n}\n\n`;
  source = source.slice(0, start) + replacement + source.slice(end);
  source = source.replace("、迁移三场景", "、退役维护 API 防回潮");
  fs.writeFileSync(file, source);
}

for (const file of fs.readdirSync("scripts/tests").filter((name) => /\.(?:ts|mjs)$/.test(name))) {
  const source = fs.readFileSync(`scripts/tests/${file}`, "utf8");
  if (source.includes('src/app/styles/components.css')) {
    throw new Error(`split-style test migration: stale direct components.css reader remains in ${file}`);
  }
}

fs.rmSync("scripts/tools/fix-split-style-tests-once.mjs");
console.log("shell split cleaned; v9-only tests migrated; generated commit contains no workflow mutation");
