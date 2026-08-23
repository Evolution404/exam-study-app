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
  'const dashboardView = source("shell/views/dashboard.tsx");',
  'const dashboardView = source("shell/views/dashboard.tsx");\nconst shellTopbar = source("shell/topbar.tsx");',
  "topbar test source",
);
replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'assert.match(study, /stats\\.pending\\.toLocaleString\\("zh-CN"\\)/, "右上角同步按钮应显示真实待同步数量");',
  'assert.match(study, /pending=\\{stats\\.pending\\}/, "AppShell 应把真实待同步数量传给右上角同步区");\nassert.match(shellTopbar, /pending\\.toLocaleString\\("zh-CN"\\)/, "右上角同步按钮应显示真实待同步数量");',
  "pending count ownership",
);
replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'assert.match(study, /<QuickSearch /, "StudyApp 应使用 QuickSearch 组件");',
  'assert.match(study, /<ShellTopbar/, "AppShell 应通过独立 ShellTopbar 承载顶部交互");\nassert.match(shellTopbar, /<QuickSearch /, "ShellTopbar 应使用 QuickSearch 组件");',
  "QuickSearch ownership",
);

for (const file of fs.readdirSync("scripts/tests").filter((name) => /\.(?:ts|mjs)$/.test(name))) {
  const source = fs.readFileSync(`scripts/tests/${file}`, "utf8");
  if (source.includes('src/app/styles/components.css')) {
    throw new Error(`split-style test migration: stale direct components.css reader remains in ${file}`);
  }
}

fs.rmSync("scripts/tools/fix-split-style-tests-once.mjs");
console.log("remaining split-style test readers migrated; no test directly reads components.css");
