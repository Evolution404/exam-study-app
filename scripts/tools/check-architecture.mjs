import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => { throw new Error(`架构检查失败：${message}`); };

const tokens = read("src/app/styles/theme-tokens.css");
const appSources = fs.readdirSync(path.join(root, "src/app"), { recursive: true })
  .filter((file) => typeof file === "string" && /\.(tsx?|css)$/.test(file))
  .map((file) => ({ file, source: read(path.join("src/app", file)) }));

const srcSources = fs.readdirSync(path.join(root, "src"), { recursive: true })
  .filter((file) => typeof file === "string" && /\.(tsx?|ts)$/.test(file))
  .map((file) => ({ file: `src/${file}`, source: read(path.join("src", file)) }));
for (const { file, source } of srcSources) {
  if (file.startsWith("src/platform/")) continue;
  if (/@capacitor\//.test(source) || /\b(?:window\.)?Capacitor\./.test(source)) {
    fail(`${file} 不得直接依赖 Capacitor；请通过 src/platform 适配层访问原生能力`);
  }
}

for (const name of ["color-canvas", "color-surface", "color-surface-raised", "color-text", "color-text-muted", "color-border", "color-primary", "color-danger"]) {
  const definitions = tokens.match(new RegExp(`--${name}:`, "g"))?.length ?? 0;
  if (definitions !== 2) fail(`主题令牌 --${name} 必须同时定义日间和夜间值`);
}

const collectSources = (dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter((file) => typeof file === "string" && /\.(tsx?|css)$/.test(file))
  .map((file) => `${dir}/${file}`);
for (const file of [...collectSources("src/app"), ...collectSources("src/lib")]) {
  if (/edf4ef/i.test(read(file))) fail(`${file} 不得使用已禁用的冷薄荷绿 #edf4ef（用户明令全项目移除）`);
}

const studyApp = read("src/app/shell/app-shell.tsx");
if (/prefers-color-scheme|dataset\.theme/.test(studyApp)) fail("主题解析只能存在于 use-app-environment Hook");

const dbV7Core = read("src/lib/db/db-v7-core.ts");
const v7DatabaseVersions = [...dbV7Core.matchAll(/this\.version\((\d+)\)/g)].map((match) => Number(match[1]));
if (!/V7_DATABASE_NAME\s*=\s*["']shijuan-study["']/.test(dbV7Core) || !/super\(V7_DATABASE_NAME\)/.test(dbV7Core)
  || v7DatabaseVersions.length !== 1 || v7DatabaseVersions[0] !== 1) {
  fail("公开客户端必须使用全新 shijuan-study 数据库命名空间，schema 只声明一次且从版本 1 开始");
}
if (/migrateLegacy|indexedDB\.open/.test(dbV7Core)) {
  fail("本地数据库核心不得保留旧 schema 运行时兼容（旧命名空间只能出现在恢复后的清理删除清单里）");
}

const sync = read("src/lib/sync/github-sync.ts");
const syncV7 = read("src/lib/sync/github-sync-v7.ts");
const syncV7HeadTypes = read("src/lib/sync/sync-v7-head-types.ts");
const syncV7HeadValidation = read("src/lib/sync/sync-v7-head-validation.ts");
const syncV7Remote = read("src/lib/sync/github-v7-remote.ts");
const syncV7CheckpointTypes = read("src/lib/sync/sync-v7-checkpoint-types.ts");
const syncV8History = read("src/lib/sync/sync-v8-history.ts");
if (fs.existsSync(path.join(root, "src/lib/sync/sync-v6-head.ts")) || fs.existsSync(path.join(root, "src/lib/sync/sync-v6-checkpoint.ts"))) {
  fail("sync-v6 head/checkpoint 文件必须删除，统一使用 sync-v7-checkpoint");
}
for (const retired of [
  "src/lib/sync/sync-v9-protocol-migration.ts",
  "scripts/tools/migrate-vault-v9-protocol.mts",
  "scripts/tools/migrate-vault-compressed.mts",
]) {
  if (fs.existsSync(path.join(root, retired))) fail(`${retired} 属于已完成的 v7/v8 兼容迁移，必须保持删除`);
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
if (!/SYNC_V9_HEAD_PATH\s*=\s*["']sync\/v9\/head\.json["']/.test(syncV7HeadTypes)
  || !/SYNC_V9_CHECKPOINT_PREFIX\s*=\s*["']sync\/v9\/checkpoints\/["']/.test(syncV7HeadTypes)
  || !/SYNC_V9_SEGMENT_PREFIX\s*=\s*["']sync\/v9\/segments\/["']/.test(syncV7HeadTypes)
  || !/SYNC_V9_OBJECT_PREFIX\s*=\s*["']sync\/v9\/objects\/["']/.test(syncV7HeadTypes)
  || !/SYNC_V9_ASSET_PREFIX\s*=\s*["']sync\/v9\/assets\/["']/.test(syncV7HeadTypes)
  || !/SYNC_V9_FORMAT_VERSION\s*=\s*9\s+as\s+const/.test(syncV7HeadTypes)
  || !/GitHubV7Remote/.test(syncV7Remote) || !/syncWithGitHub/.test(syncV7)
  || !/SYNC_V7_MAX_HOT_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/.test(syncV7HeadTypes)
  || !/SYNC_V7_CHECKPOINT_FORMAT\s*=\s*7/.test(syncV7CheckpointTypes)
  || !/SYNC_V9_CHECKPOINT_FORMAT\s*=\s*9/.test(syncV8History)
  || !/createRemoteCheckpointV8/.test(syncV8History)
  || !/SYNC_V7_ASSET_PREFIX\s*=\s*SYNC_V9_ASSET_PREFIX/.test(syncV7HeadTypes)) {
  fail("公开同步入口必须仅使用 v9 固定 head/热窗口 transport，并以 format 9 bounded checkpoint + history archive 写远端");
}

const legacyMigrationHeadPin = 'path: "sync/v7/head.json" | "sync/v8/head.json";';
const legacyMigrationValidation = 'value.migratedFrom.path !== "sync/v7/head.json" && value.migratedFrom.path !== "sync/v8/head.json"';
if (!syncV7HeadTypes.includes(legacyMigrationHeadPin) || !syncV7HeadValidation.includes(legacyMigrationValidation)) {
  fail("v9 head 类型与校验必须只保留精确的 v7/v8 migratedFrom 来源 pin，用于迁移诊断而非远端访问");
}
const activeSyncSources = fs.readdirSync(path.join(root, "src/lib/sync"))
  .filter((file) => typeof file === "string" && file.endsWith(".ts"))
  .map((file) => ({ file, source: read(path.join("src/lib/sync", file)) }));
for (const { file, source } of activeSyncSources) {
  const inspectedSource = file === "sync-v7-head-types.ts"
    ? source.replace(legacyMigrationHeadPin, "")
    : file === "sync-v7-head-validation.ts"
      ? source.replace(legacyMigrationValidation, "")
      : source;
  if (/sync\/v[78]\//.test(inspectedSource)) {
    fail(`${file} 不得访问已退役的 v7/v8 远端 namespace；生产同步只允许 v9`);
  }
}

const rawFetchAllowed = new Set(["github-v7-remote.ts"]);
for (const { file, source } of activeSyncSources) {
  if (rawFetchAllowed.has(file)) continue;
  if (/(?:globalThis\.)?fetch\s*\(/.test(source)) fail(`${file} 不得绕过 GitHubTransport 使用裸 fetch，请从 sync-v7-context 注入 transport.fetch`);
}
const transportSource = read("src/platform/github-transport.ts");
if (!/defaultApiBaseUrl/.test(transportSource) || !/GITHUB_RELAY_URL/.test(transportSource) || !/globalThis\.fetch/.test(transportSource)) {
  fail("GitHub transport 必须集中定义 fetch-compatible adapter、Relay 默认地址和 globalThis.fetch 入口");
}

if (/study-current-bank["']/.test(appSources.map(({ source }) => source).join("\n"))) fail("客户端不得读取旧版单题库配置键");
for (const { file, source } of appSources.filter(({ file }) => file.endsWith(".ts") || file.endsWith(".tsx"))) {
  if (/from ["']@\/lib\/db["']/.test(source)) fail(`${file} 不得读取旧本地数据库`);
  if (/\bimageUrl\b|题目图片地址/.test(source)) fail(`${file} 不得使用公开图片 URL 字段`);
}

for (const { file, source } of appSources.filter(({ file }) => file.endsWith(".ts") || file.endsWith(".tsx"))) {
  if (/from ["']@\/lib\/sync\/(?:github-sync(?:-v7)?|github-credentials|github-v7-remote|change-set-v7(?:-queue)?|sync-v7-[^"']+)["']/.test(source)) {
    fail(`${file} 不得直接依赖同步实现；请通过 sync-application / sync-runtime`);
  }
}

if (/db\.sessions|savePracticeSession|clearPracticeSession|preserveSessions/.test(sync)) fail("练习进度只能持久化到 practiceRuns，不得保留 active session 双写路径");

console.log("架构检查通过：全新 shijuan-study 数据库命名空间、同步 application boundary、主题令牌完整；公开同步仅写入 v9 namespace/head/checkpoint。");