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

const dbV6 = read("lib/db-v6.ts");
const v6DatabaseVersions = [...dbV6.matchAll(/this\.version\((\d+)\)/g)].map((match) => Number(match[1]));
const versionsAscending = v6DatabaseVersions.every((version, index) => index === 0 || version > v6DatabaseVersions[index - 1]);
if (!/V6_DATABASE_NAME\s*=\s*["']shijuan-study-v6["']/.test(dbV6) || !/super\(V6_DATABASE_NAME\)/.test(dbV6)
  || !v6DatabaseVersions.includes(1) || !v6DatabaseVersions.includes(2) || !versionsAscending) {
  fail("公开客户端必须只使用独立 shijuan-study-v6 数据库命名空间，且 schema 版本包含 v7 队列升级并按升序演进");
}

const sync = read("lib/github-sync.ts");
const syncV6Head = read("lib/sync-v6-head.ts");
const syncV7 = read("lib/github-sync-v7.ts");
const syncV7Head = read("lib/sync-v7-head.ts");
const syncV7Remote = read("lib/github-v7-remote.ts");
if (/formatVersion:\s*1\b|legacyEntries|events\/seed/.test(sync)) fail("客户端不得包含同步协议 v1 回退");
if (/message:\s*[`'"]sync:[^\n]*v2|contents\/events\/v2/.test(sync)) fail("客户端不得写入同步协议 v2");
if (/sync\/v[23]\//.test(sync) || /LegacyV[23]|migrateV[23]/.test(sync)) fail("公开同步模块不得保留 v2/v3 兼容层");
if (/github-sync-v5|github-v5-remote|sync-v5|from ["']\.\/db["']/.test(sync)) fail("公开同步门面不得导入 v5 或旧 DB");
if (/github-sync-v6|github-v6-remote/.test(sync)) fail("公开同步门面不得依赖已移除的 v6 transport");
if (/encodeSyncV6Event|paginateSyncV6Events|planSyncV6HotTail|mergeSyncV6EventPages|SyncV6HotWindowError|SyncHeadV6/.test(syncV6Head)) fail("v6 事件页/热窗口/发布计划代码必须随 v6 transport 一起移除");
if (!/syncWithGitHub/.test(sync) || !/from ["']\.\/github-sync-v7["']/.test(sync)) fail("公开 syncWithGitHub 必须委托 v7");
if (!/restoreFromGitHub/.test(sync) || !/restoreFullHistoryFromGitHub/.test(sync)) {
  fail("公开恢复入口必须委托 v7");
}
if (!/SYNC_V7_HEAD_PATH\s*=\s*["']sync\/v7\/head\.json["']/.test(syncV7Head)
  || !/GitHubV7Remote/.test(syncV7Remote) || !/syncWithGitHub/.test(syncV7)
  || !/SYNC_V7_MAX_HOT_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/.test(syncV7Head)) {
  fail("公开同步入口必须使用 v7 固定 head、严格热窗口和 GitHub v7 transport");
}

if (/study-current-bank["']/.test(appSources.map(({ source }) => source).join("\n"))) fail("客户端不得读取旧版单题库配置键");
for (const { file, source } of appSources.filter(({ file }) => file.endsWith(".ts") || file.endsWith(".tsx"))) {
  if (/from ["']@\/lib\/db["']/.test(source)) fail(`${file} 不得读取旧本地数据库`);
  if (/\bimageUrl\b|题目图片地址/.test(source)) fail(`${file} 不得使用公开图片 URL 字段`);
}

if (/db\.sessions|savePracticeSession|clearPracticeSession|preserveSessions/.test(sync)) fail("练习进度只能持久化到 practiceRuns，不得保留 active session 双写路径");

console.log(`架构检查通过：独立数据库 v2 队列、主题令牌完整；组件颜色预算 ${colorCount}/${legacyColorBudget}；夜间补丁预算 ${darkSelectorCount}/${legacyDarkSelectorBudget}；公开同步仅写入 v7 namespace/head。`);
