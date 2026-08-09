import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => { throw new Error(`架构检查失败：${message}`); };

const tokens = read("app/styles/theme-tokens.css");
const components = read("app/styles/components.css");
const appSources = fs.readdirSync(path.join(root, "app"), { recursive: true })
  .filter((file) => typeof file === "string" && /\.(tsx?|css)$/.test(file))
  .map((file) => ({ file, source: read(path.join("app", file)) }));

for (const name of ["color-canvas", "color-surface", "color-surface-raised", "color-text", "color-text-muted", "color-border", "color-primary", "color-danger"]) {
  const definitions = tokens.match(new RegExp(`--${name}:`, "g"))?.length ?? 0;
  if (definitions !== 2) fail(`主题令牌 --${name} 必须同时定义日间和夜间值`);
}

for (const { file, source } of appSources) {
  if (file === "styles/theme-tokens.css" || file === "styles/components.css") continue;
  if (/html\[data-theme=["']dark["']\]/.test(source)) fail(`${file} 不得添加页面级夜间补丁`);
  if (/#[0-9a-fA-F]{3,8}\b/.test(source) && file.endsWith(".css")) fail(`${file} 必须使用主题令牌，不能硬编码颜色`);
}

const legacyColorBudget = 1104;
const legacyDarkSelectorBudget = 180;
const colorCount = components.match(/#[0-9a-fA-F]{3,8}\b/g)?.length ?? 0;
const darkSelectorCount = components.match(/html\[data-theme="dark"\]/g)?.length ?? 0;
if (colorCount > legacyColorBudget) fail(`组件层硬编码颜色由 ${legacyColorBudget} 增至 ${colorCount}，只能减少`);
if (darkSelectorCount > legacyDarkSelectorBudget) fail(`页面级夜间选择器由 ${legacyDarkSelectorBudget} 增至 ${darkSelectorCount}，只能减少`);

const studyApp = read("app/study-app.tsx");
if (/prefers-color-scheme|dataset\.theme/.test(studyApp)) fail("主题解析只能存在于 use-app-environment Hook");

const db = read("lib/db.ts");
const databaseVersions = [...db.matchAll(/this\.version\((\d+)\)/g)].map((match) => Number(match[1]));
if (databaseVersions.length !== 1 || databaseVersions[0] !== 8) fail("客户端只能声明当前数据库 v8");

const sync = read("lib/github-sync.ts");
const syncV4 = read("lib/github-sync-v4.ts");
const syncV4Head = read("lib/sync-v4-head.ts");
const syncV4Remote = read("lib/github-v4-remote.ts");
if (/formatVersion:\s*1\b|legacyEntries|events\/seed/.test(sync)) fail("客户端不得包含同步协议 v1 回退");
if (/message:\s*[`'"]sync:[^\n]*v2|contents\/events\/v2/.test(sync)) fail("客户端不得写入同步协议 v2");

// v4 has one mutable object.  Keep the spelling in one protocol module and
// require the GitHub transport to consume that constant instead of deriving a
// branch- or repository-dependent head path.
if (!/SYNC_V4_HEAD_PATH\s*=\s*["']sync\/v4\/head\.json["']/.test(syncV4Head)) {
  fail("Sync v4 必须将固定 head 路径设为 sync/v4/head.json");
}
if (!/SYNC_V4_HEAD_PATH/.test(syncV4Remote) || !/GitHubV4Remote/.test(syncV4)) {
  fail("公开同步入口必须通过 Sync v4 固定 head 路径读写远程索引");
}
if (!/formatVersion:\s*4\b/.test(syncV4) || !/syncWithGitHubV4/.test(syncV4) || !/restoreFromGitHubV4/.test(syncV4)) {
  fail("公开同步入口必须实现同步协议 v4");
}

// The stable names consumed by the UI are wrappers around v4.  Legacy v3
// code may remain for an explicit migration path, but it must be clearly
// labelled Legacy/Migration and must not leak into these public entrypoints.
const publicEntryNames = [
  "syncWithGitHub",
  "restoreFromGitHub",
  "restoreFullHistoryFromGitHub",
  "loadAttemptHistory",
  "verifyGitHubVault",
  "initializeGitHubVault",
];
const requiredPublicEntryNames = ["syncWithGitHub", "restoreFromGitHub", "restoreFullHistoryFromGitHub"];
function exportedFunctionBlock(name) {
  const match = sync.match(new RegExp(`export (?:async )?function ${name}\\b[\\s\\S]*?(?=\\nexport (?:async )?function |$)`));
  return match?.[0] ?? "";
}
for (const name of requiredPublicEntryNames) {
  if (!exportedFunctionBlock(name)) fail(`公开入口 ${name} 必须存在并指向 Sync v4`);
}
for (const name of publicEntryNames) {
  const block = exportedFunctionBlock(name);
  if (!block) continue;
  if (!/V4/.test(block)) fail(`公开入口 ${name} 必须委托 Sync v4 实现`);
  if (/sync\/v[23]\//.test(block) || /manifestPath|v3EventPrefix|v3CatalogPath/.test(block)) {
    fail(`公开入口 ${name} 不得读写 v2/v3 路径`);
  }
}
for (const match of sync.matchAll(/export (?:async )?function\s+(\w+)/g)) {
  const name = match[1];
  if (/v[23]/i.test(name) && !/(?:Legacy|Migration)/i.test(name)) {
    fail(`旧版同步入口 ${name} 必须明确标记为 Legacy 或 Migration 内部实现`);
  }
}
if (/study-current-bank["']/.test(appSources.map(({ source }) => source).join("\n"))) fail("客户端不得读取旧版单题库配置键");

console.log(`架构检查通过：主题令牌完整；组件颜色预算 ${colorCount}/${legacyColorBudget}；夜间补丁预算 ${darkSelectorCount}/${legacyDarkSelectorBudget}；仅公开写入 DB v8 / Sync v4 head。`);
