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
if (databaseVersions.length !== 1 || databaseVersions[0] !== 10) fail("客户端只能声明当前数据库 v10");
const dbV6 = read("lib/db-v6.ts");
const v6DatabaseVersions = [...dbV6.matchAll(/this\.version\((\d+)\)/g)].map((match) => Number(match[1]));
if (!/V6_DATABASE_NAME\s*=\s*["']shijuan-study-v6["']/.test(dbV6) || !/super\(V6_DATABASE_NAME\)/.test(dbV6)
  || v6DatabaseVersions.length !== 1 || v6DatabaseVersions[0] !== 1) {
  fail("公开客户端必须只使用独立 shijuan-study-v6 数据库命名空间");
}

const sync = read("lib/github-sync.ts");
const syncV6 = read("lib/github-sync-v6.ts");
const syncV6Head = read("lib/sync-v6-head.ts");
const syncV6Remote = read("lib/github-v6-remote.ts");
if (/formatVersion:\s*1\b|legacyEntries|events\/seed/.test(sync)) fail("客户端不得包含同步协议 v1 回退");
if (/message:\s*[`'"]sync:[^\n]*v2|contents\/events\/v2/.test(sync)) fail("客户端不得写入同步协议 v2");
if (/sync\/v[23]\//.test(sync) || /LegacyV[23]|migrateV[23]/.test(sync)) fail("公开同步模块不得保留 v2/v3 兼容层");
if (/github-sync-v5|github-v5-remote|sync-v5|from ["']\.\/db["']/.test(sync)) fail("公开同步门面不得导入 v5 或旧 DB");
if (!/SYNC_V6_HEAD_PATH\s*=\s*["']sync\/v6\/head\.json["']/.test(syncV6Head)
  || !/SYNC_V6_HEAD_PATH/.test(syncV6Remote)
  || !/GitHubV6Remote/.test(syncV6)
  || !/syncWithGitHubV6/.test(syncV6)
  || !/restoreFromGitHubV6/.test(syncV6)) {
  fail("公开同步入口必须通过 Sync v6 固定 head 路径读写远程索引");
}
if (!/formatVersion:\s*6\b/.test(syncV6) || !/SYNC_V6_MAX_EVENT_PAGE_BYTES\s*=\s*256\s*\*\s*1024/.test(syncV6Head)
  || !/SYNC_V6_MAX_EVENT_BYTES\s*=\s*256\s*\*\s*1024/.test(syncV6Head)
  || !/SYNC_V6_MAX_HOT_EVENT_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/.test(syncV6Head)) {
  fail("Sync v6 必须保持事件、分页和热窗口上限");
}
if (!/syncWithGitHubV6 as syncWithGitHub/.test(sync)) fail("公开 syncWithGitHub 必须委托 v6");
if (!/restoreFromGitHubV6 as restoreFromGitHub/.test(sync) || !/restoreFullHistoryFromGitHubV6 as restoreFullHistoryFromGitHub/.test(sync)) {
  fail("公开恢复入口必须委托 v6");
}
if (/github-sync-v5|github-v5-remote|sync-v5/.test(syncV6)) fail("生产 v6 编排不得依赖 v5 transport");

// v5 is migration-only.  No app/lib production module may import it except
// explicitly named migration helpers and the legacy implementation itself.
for (const { file, source } of fs.readdirSync(path.join(root, "lib"), { recursive: true })
  .filter((file) => typeof file === "string" && /\.tsx?$/.test(file))
  .map((file) => ({ file, source: read(path.join("lib", file)) }))) {
  if (["github-sync-v5.ts", "github-v5-remote.ts", "sync-v5-head.ts", "sync-v5-catalog.ts"].includes(file) || file.startsWith("migration/")) continue;
  if (/from ["'][^"']*(?:github-sync-v5|github-v5-remote|sync-v5)[^"']*["']/.test(source)) fail(`${file} 只能由迁移模块读取 v5`);
}
if (/study-current-bank["']/.test(appSources.map(({ source }) => source).join("\n"))) fail("客户端不得读取旧版单题库配置键");
for (const { file, source } of appSources.filter(({ file }) => file.endsWith(".ts") || file.endsWith(".tsx"))) {
  if (/from ["']@\/lib\/db["']/.test(source)) fail(`${file} 不得读取旧本地数据库`);
  if (/\bimageUrl\b|题目图片地址/.test(source)) fail(`${file} 不得使用公开图片 URL 字段`);
}

if (/sessions:\s*["']/.test(db)) fail("DB v10 必须删除重复的 active sessions 表");
if (/db\.sessions|savePracticeSession|clearPracticeSession|preserveSessions/.test(`${db}\n${sync}\n${syncV6}`)) fail("练习进度只能持久化到 practiceRuns，不得保留 active session 双写路径");

console.log(`架构检查通过：v6 独立数据库、主题令牌完整；组件颜色预算 ${colorCount}/${legacyColorBudget}；夜间补丁预算 ${darkSelectorCount}/${legacyDarkSelectorBudget}；公开同步仅写入 v6 namespace/head。`);
