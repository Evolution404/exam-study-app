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
const versionedSourceFile = /(?:^|[-_.])v\d+(?=[-_.]|$)|[A-Za-z0-9_$]+v\d+(?=[-_.]|$)/i;
const versionedBusinessSymbol = /\b(?:[A-Za-z_$][A-Za-z0-9_$]*(?:V|v)\d+|(?:V|v)\d+[A-Za-z_$][A-Za-z0-9_$]*)\b/;
for (const { file, source } of srcSources) {
  if (versionedSourceFile.test(path.basename(file))) {
    fail(`${file} 不得使用 V数字/v数字 版本化源码文件名；当前业务实现必须使用版本无关命名`);
  }
  const symbol = source.match(versionedBusinessSymbol)?.[0];
  if (symbol) {
    fail(`${file} 不得声明或引用版本化业务符号 ${symbol}；禁止通过 alias 保留旧 API`);
  }
  if (/\bv[78]\b/i.test(source)) {
    fail(`${file} 不得保留 v7/v8 运行时文案、注释、错误消息、配置键或实现标记`);
  }
  if (file.startsWith("src/platform/")) continue;
  if (/@capacitor\//.test(source) || /\b(?:window\.)?Capacitor\./.test(source)) {
    fail(`${file} 不得直接依赖 Capacitor；请通过 src/platform 适配层访问原生能力`);
  }
  if (/["'](?:study|shijuan-study)-v\d+-/i.test(source)) {
    fail(`${file} 不得恢复带版本号的本地配置键；所有客户端统一使用当前版本无关命名空间`);
  }
}

const testSources = fs.readdirSync(path.join(root, "scripts/tests"), { recursive: true })
  .filter((file) => typeof file === "string" && /\.(m?[jt]s|tsx?)$/.test(file))
  .map((file) => ({ file: `scripts/tests/${file}`, source: read(path.join("scripts/tests", file)) }));
for (const { file, source } of testSources) {
  if (/\bv[78]\b/i.test(source)) {
    fail(`${file} 不得保留 v7/v8 测试标签、夹具、断言或旧实现标记；测试应描述当前业务/同步语义`);
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

const studyDbCore = read("src/lib/db/db-core.ts");
const databaseVersions = [...studyDbCore.matchAll(/this\.version\((\d+)\)/g)].map((match) => Number(match[1]));
if (!/DATABASE_NAME\s*=\s*["']shijuan-study["']/.test(studyDbCore) || !/super\(DATABASE_NAME\)/.test(studyDbCore)
  || databaseVersions.length !== 1 || databaseVersions[0] !== 1) {
  fail("公开客户端必须使用 shijuan-study 数据库命名空间，schema 只声明一次且固定为 version(1)");
}
const dbSources = fs.readdirSync(path.join(root, "src/lib/db"), { recursive: true })
  .filter((file) => typeof file === "string" && /\.ts$/.test(file))
  .map((file) => ({ file: `src/lib/db/${file}`, source: read(path.join("src/lib/db", file)) }));
if (dbSources.some(({ source }) => /\.upgrade\s*\(/.test(source))) {
  fail("本地数据库禁止 Dexie upgrade 兼容迁移；schema 变更时清空客户端本地数据并从远端重新同步");
}
if (dbSources.some(({ file }) => /(?:schema-)?migration|legacy-schema|schema-compat/i.test(file))
  || fs.existsSync(path.join(root, "scripts/tests/test-db-schema-migration.ts"))) {
  fail("本地数据库不得新增历史 schema migration/compat 文件；所有客户端统一使用当前 schema");
}
if (/migrateLegacy|indexedDB\.open|dropLegacyLocalDatabases|["']shijuan-study-v\d+["']/.test(studyDbCore)) {
  fail("本地数据库核心不得保留旧 schema、带版本号命名空间或迁移清理代码");
}

const syncFacade = read("src/lib/sync/github-sync.ts");
const syncEngine = read("src/lib/sync/github-sync-engine.ts");
const syncRuntime = `${syncFacade}\n${syncEngine}`;
const syncHeadTypes = read("src/lib/sync/sync-head-types.ts");
const syncRemote = read("src/lib/sync/github-remote.ts");
const syncLocalCheckpointTypes = read("src/lib/sync/sync-checkpoint-types.ts");
const syncHistory = read("src/lib/sync/sync-history.ts");
if (/formatVersion:\s*1\b|legacyEntries|events\/seed/.test(syncRuntime)) fail("客户端不得包含早期同步协议回退");
if (/message:\s*[`'\"]sync:[^\n]*v2|contents\/events\/v2/.test(syncRuntime)) fail("客户端不得写入已退役同步协议");
if (!/syncWithGitHub/.test(syncFacade) || !/from ["']\.\/github-sync-engine["']/.test(syncFacade)) {
  fail("公开 syncWithGitHub 必须仅通过稳定门面委托当前同步引擎");
}
if (!/restoreFromGitHub/.test(syncFacade) || !/restoreFullHistoryFromGitHub/.test(syncFacade)) {
  fail("公开恢复入口必须仅通过稳定门面委托当前同步引擎");
}
if (!/SYNC_HEAD_PATH\s*=\s*["']sync\/v9\/head\.json["']/.test(syncHeadTypes)
  || !/SYNC_CHECKPOINT_PREFIX\s*=\s*["']sync\/v9\/checkpoints\/["']/.test(syncHeadTypes)
  || !/SYNC_SEGMENT_PREFIX\s*=\s*["']sync\/v9\/segments\/["']/.test(syncHeadTypes)
  || !/SYNC_OBJECT_PREFIX\s*=\s*["']sync\/v9\/objects\/["']/.test(syncHeadTypes)
  || !/SYNC_ASSET_PREFIX\s*=\s*["']sync\/v9\/assets\/["']/.test(syncHeadTypes)
  || !/SYNC_FORMAT_VERSION\s*=\s*9\s+as\s+const/.test(syncHeadTypes)
  || !/GitHubRemote/.test(syncRemote) || !/syncWithGitHub/.test(syncRuntime)
  || !/SYNC_MAX_HOT_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/.test(syncHeadTypes)
  || !/SYNC_CHECKPOINT_FORMAT\s*=\s*7/.test(syncLocalCheckpointTypes)
  || !/REMOTE_HISTORY_FORMAT\s*=\s*9/.test(syncHistory)
  || !/createRemoteHistoryCheckpoint/.test(syncHistory)
) {
  fail("公开同步入口必须仅使用当前 v9 固定 head/热窗口 transport，并以 format 9 bounded checkpoint + history archive 写远端");
}

const activeSyncSources = fs.readdirSync(path.join(root, "src/lib/sync"))
  .filter((file) => typeof file === "string" && file.endsWith(".ts"))
  .map((file) => ({ file, source: read(path.join("src/lib/sync", file)) }));
for (const { file, source } of activeSyncSources) {
  if (/sync\/v(?:[1-8])\//.test(source) || /migratedFrom/.test(source)) {
    fail(`${file} 不得保留历史远端 namespace 或迁移来源元数据；生产同步只允许当前 v9`);
  }
}

const rawFetchAllowed = new Set(["github-remote.ts"]);
for (const { file, source } of activeSyncSources) {
  if (rawFetchAllowed.has(file)) continue;
  if (/(?:globalThis\.)?fetch\s*\(/.test(source)) fail(`${file} 不得绕过 GitHubTransport 使用裸 fetch，请从 sync-context 注入 transport.fetch`);
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
  if (/from ["']@\/lib\/sync\/(?:github-sync(?:-engine)?|github-credentials|github-remote|change-set(?:-queue)?|sync-(?!application["']|runtime["'])[^"']+)["']/.test(source)) {
    fail(`${file} 不得直接依赖同步实现；请通过 sync-application / sync-runtime`);
  }
}

if (/db\.sessions|savePracticeSession|clearPracticeSession|preserveSessions/.test(syncRuntime)) fail("练习进度只能持久化到 practiceRuns，不得保留 active session 双写路径");

const latestOnlySources = appSources.map(({ source }) => source).join("\n") + "\n" + activeSyncSources.map(({ source }) => source).join("\n");
if (/rebuildAttemptStatsFromAttempts|study-stats-outcomes/.test(latestOnlySources)) fail("客户端不得恢复一次性 attemptStats 历史回填");
if (/ImageAssetRemoteDescriptor|LEGACY_SINGLE_ASSET_PATH|hydrateLegacyAsset|migratedFrom/.test(latestOnlySources)) fail("客户端不得恢复旧图片布局或历史迁移来源兼容");
if (/scopedStatsToLegacyAttemptStats/.test(latestOnlySources)) fail("客户端不得恢复旧统计 bridge 命名或兼容入口");

console.log("架构检查通过：version(1) 单一当前 schema、版本无关业务/测试命名、同步 application boundary 与主题令牌完整；公开同步仅写入 v9 namespace/head/checkpoint。");
