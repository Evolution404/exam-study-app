import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => { throw new Error(`架构检查失败：${message}`); };

const tokens = read("src/app/styles/theme-tokens.css");
const components = read("src/app/styles/components.css");
const appSources = fs.readdirSync(path.join(root, "src/app"), { recursive: true })
  .filter((file) => typeof file === "string" && /\.(tsx?|css)$/.test(file))
  .map((file) => ({ file, source: read(path.join("src/app", file)) }));

for (const name of ["color-canvas", "color-surface", "color-surface-raised", "color-text", "color-text-muted", "color-border", "color-primary", "color-danger"]) {
  const definitions = tokens.match(new RegExp(`--${name}:`, "g"))?.length ?? 0;
  if (definitions !== 2) fail(`主题令牌 --${name} 必须同时定义日间和夜间值`);
}

// 用户明令全项目禁用的颜色（2026-08：冷调薄荷绿表面色 #edf4ef，与暖纸色系冲突，
// 曾作为 --color-surface-muted 及多处字面量出现）。任何源文件不得再引入该字面量。
const collectSources = (dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter((file) => typeof file === "string" && /\.(tsx?|css)$/.test(file))
  .map((file) => `${dir}/${file}`);
for (const file of [...collectSources("src/app"), ...collectSources("src/lib")]) {
  if (/edf4ef/i.test(read(file))) fail(`${file} 不得使用已禁用的冷薄荷绿 #edf4ef（用户明令全项目移除）`);
}

for (const { file, source } of appSources) {
  if (file === "styles/theme-tokens.css" || file === "styles/components.css") continue;
  if (/html\[data-theme=["']dark["']\]/.test(source)) fail(`${file} 不得添加页面级夜间补丁`);
  if (/#[0-9a-fA-F]{3,8}\b/.test(source) && file.endsWith(".css")) fail(`${file} 必须使用主题令牌，不能硬编码颜色`);
}

let legacyColorBudget = 952;
let legacyDarkSelectorBudget = 166;
const colorCount = components.match(/#[0-9a-fA-F]{3,8}\b/g)?.length ?? 0;
const darkSelectorCount = components.match(/html\[data-theme="dark"\]/g)?.length ?? 0;
if (colorCount > legacyColorBudget) fail(`组件层硬编码颜色由 ${legacyColorBudget} 增至 ${colorCount}，只能减少`);
if (darkSelectorCount > legacyDarkSelectorBudget) fail(`页面级夜间选择器由 ${legacyDarkSelectorBudget} 增至 ${darkSelectorCount}，只能减少`);

// 预算棘轮：检查通过后把上限收紧为当前值并写回本文件——之后任何人新增
// 硬编码颜色/夜间前缀都会立即超限，上限因此只降不升。CI 只改临时 checkout
// 无副作用；本地跑完请把写回的预算值随本次变更一起提交。
if (colorCount < legacyColorBudget || darkSelectorCount < legacyDarkSelectorBudget) {
  const previousColorBudget = legacyColorBudget;
  const previousDarkBudget = legacyDarkSelectorBudget;
  legacyColorBudget = colorCount;
  legacyDarkSelectorBudget = darkSelectorCount;
  const selfPath = fileURLToPath(import.meta.url);
  fs.writeFileSync(selfPath, fs.readFileSync(selfPath, "utf8")
    .replace(/legacyColorBudget = \d+;/, `legacyColorBudget = ${colorCount};`)
    .replace(/legacyDarkSelectorBudget = \d+;/, `legacyDarkSelectorBudget = ${darkSelectorCount};`));
  console.log(`预算棘轮已收紧并写回：颜色 ${previousColorBudget}→${legacyColorBudget}，夜间 ${previousDarkBudget}→${legacyDarkSelectorBudget}（请随本次变更提交）`);
}

const studyApp = read("src/app/shell/app-shell.tsx");
if (/prefers-color-scheme|dataset\.theme/.test(studyApp)) fail("主题解析只能存在于 use-app-environment Hook");

// The v7 schema lives in db-v7-core.ts; db-v7.ts is only a barrel that
// re-exports that module's public surface.
const dbV7Core = read("src/lib/db/db-v7-core.ts");
const v7DatabaseVersions = [...dbV7Core.matchAll(/this\.version\((\d+)\)/g)].map((match) => Number(match[1]));
const versionsAscending = v7DatabaseVersions.every((version, index) => index === 0 || version > v7DatabaseVersions[index - 1]);
if (!/V7_DATABASE_NAME\s*=\s*["']shijuan-study-v7["']/.test(dbV7Core) || !/super\(V7_DATABASE_NAME\)/.test(dbV7Core)
  || !v7DatabaseVersions.includes(1) || !v7DatabaseVersions.includes(2) || !versionsAscending) {
  fail("公开客户端必须只使用独立 shijuan-study-v7 数据库命名空间，且 schema 版本包含 v7 队列升级并按升序演进");
}

const sync = read("src/lib/sync/github-sync.ts");
const syncV7 = read("src/lib/sync/github-sync-v7.ts");
const syncV7Head = read("src/lib/sync/sync-v7-head.ts");
const syncV7Remote = read("src/lib/sync/github-v7-remote.ts");
const syncV7Checkpoint = read("src/lib/sync/sync-v7-checkpoint.ts");
const syncV8History = read("src/lib/sync/sync-v8-history.ts");
if (fs.existsSync(path.join(root, "src/lib/sync/sync-v6-head.ts")) || fs.existsSync(path.join(root, "src/lib/sync/sync-v6-checkpoint.ts"))) {
  fail("sync-v6 head/checkpoint 文件必须删除，统一使用 sync-v7-checkpoint");
}
if (/formatVersion:\s*1\b|legacyEntries|events\/seed/.test(sync)) fail("客户端不得包含同步协议 v1 回退");
if (/message:\s*[`'"]sync:[^\n]*v2|contents\/events\/v2/.test(sync)) fail("客户端不得写入同步协议 v2");
if (/sync\/v[23]\//.test(sync) || /LegacyV[23]|migrateV[23]/.test(sync)) fail("公开同步模块不得保留 v2/v3 兼容层");
if (/github-sync-v5|github-v5-remote|sync-v5|from ["']\.\/db["']/.test(sync)) fail("公开同步门面不得导入 v5 或旧 DB");
if (/github-sync-v6|github-v6-remote|sync-v6-head|sync-v6-checkpoint/.test(sync)) fail("公开同步门面不得依赖已移除的 v6 transport");
if (/sync\/v[67]\//.test(syncV7) || /sync\/v[67]\//.test(syncV7Remote)) fail("公开同步模块不得读写旧 v6/v7 namespace");
if (!/syncWithGitHub/.test(sync) || !/from ["']\.\/github-sync-v7["']/.test(sync)) fail("公开 syncWithGitHub 必须委托 v7");
if (!/restoreFromGitHub/.test(sync) || !/restoreFullHistoryFromGitHub/.test(sync)) {
  fail("公开恢复入口必须委托 v7");
}
if (!/SYNC_V8_HEAD_PATH\s*=\s*["']sync\/v8\/head\.json["']/.test(syncV7Head)
  || !/SYNC_V8_CHECKPOINT_PREFIX\s*=\s*["']sync\/v8\/checkpoints\/["']/.test(syncV7Head)
  || !/SYNC_V8_SEGMENT_PREFIX\s*=\s*["']sync\/v8\/segments\/["']/.test(syncV7Head)
  || !/SYNC_V8_OBJECT_PREFIX\s*=\s*["']sync\/v8\/objects\/["']/.test(syncV7Head)
  || !/SYNC_V8_ASSET_PREFIX\s*=\s*["']sync\/v8\/assets\/["']/.test(syncV7Head)
  || !/GitHubV7Remote/.test(syncV7Remote) || !/syncWithGitHub/.test(syncV7)
  || !/SYNC_V7_MAX_HOT_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/.test(syncV7Head)
  || !/SYNC_V7_CHECKPOINT_FORMAT\s*=\s*7/.test(syncV7Checkpoint)
  || !/SYNC_V8_CHECKPOINT_FORMAT\s*=\s*8/.test(syncV8History)
  || !/createRemoteCheckpointV8/.test(syncV8History)
  || !/SYNC_V7_ASSET_PREFIX/.test(syncV7Checkpoint)) {
  fail("公开同步入口必须仅使用 v8 固定 head/热窗口 transport，并以 format 8 bounded checkpoint + history archive 写远端");
}

const activeSyncSources = fs.readdirSync(path.join(root, "src/lib/sync"))
  .filter((file) => typeof file === "string" && file.endsWith(".ts") && file !== "sync-v8-protocol-migration.ts")
  .map((file) => ({ file, source: read(path.join("src/lib/sync", file)) }));
for (const { file, source } of activeSyncSources) {
  if (/sync\/v7\//.test(source) && !["sync-v7-checkpoint.ts", "sync-v7-head.ts"].includes(file)) fail(`${file} 不得访问旧 v7 远端 namespace；兼容读取只能留在一次性迁移模块`);
}

if (/study-current-bank["']/.test(appSources.map(({ source }) => source).join("\n"))) fail("客户端不得读取旧版单题库配置键");
for (const { file, source } of appSources.filter(({ file }) => file.endsWith(".ts") || file.endsWith(".tsx"))) {
  if (/from ["']@\/lib\/db["']/.test(source)) fail(`${file} 不得读取旧本地数据库`);
  if (/\bimageUrl\b|题目图片地址/.test(source)) fail(`${file} 不得使用公开图片 URL 字段`);
}

// React/UI 层只依赖稳定的 sync-application / sync-runtime 边界；GitHub
// transport、credentials、change-set queue 和 v7 protocol 都属于同步实现细节。
for (const { file, source } of appSources.filter(({ file }) => file.endsWith(".ts") || file.endsWith(".tsx"))) {
  if (/from ["']@\/lib\/sync\/(?:github-sync(?:-v7)?|github-credentials|github-v7-remote|change-set-v7(?:-queue)?|sync-v7-[^"']+)["']/.test(source)) {
    fail(`${file} 不得直接依赖同步实现；请通过 sync-application / sync-runtime`);
  }
}

if (/db\.sessions|savePracticeSession|clearPracticeSession|preserveSessions/.test(sync)) fail("练习进度只能持久化到 practiceRuns，不得保留 active session 双写路径");

console.log(`架构检查通过：独立数据库 v7 命名空间、同步 application boundary、主题令牌完整；组件颜色预算 ${colorCount}/${legacyColorBudget}；夜间补丁预算 ${darkSelectorCount}/${legacyDarkSelectorBudget}；公开同步仅写入 v8 namespace/head/checkpoint。`);
