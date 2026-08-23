import fs from "node:fs";

const replace = (file, before, after, label) => {
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(before)) throw new Error(`split-style test migration: missing ${label} in ${file}`);
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
};

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

for (const file of fs.readdirSync("scripts/tests").filter((name) => /\.(?:ts|mjs)$/.test(name))) {
  const source = fs.readFileSync(`scripts/tests/${file}`, "utf8");
  if (source.includes('src/app/styles/components.css')) {
    throw new Error(`split-style test migration: stale direct components.css reader remains in ${file}`);
  }
}

fs.rmSync("scripts/tools/fix-split-style-tests-once.mjs");
console.log("remaining split-style test readers migrated; v9-only checkpoint contract aligned; no test directly reads components.css");
