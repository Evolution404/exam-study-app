from pathlib import Path
import re

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text.rstrip() + '\n', encoding='utf-8')


def exact(path: str, old: str, new: str = '') -> None:
    text = read(path)
    if old not in text:
        raise RuntimeError(f'{path}: exact block not found: {old[:100]!r}')
    write(path, text.replace(old, new, 1))


def regex(path: str, pattern: str, repl: str = '', count: int = 1, flags: int = re.S) -> None:
    text = read(path)
    updated, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n != count:
        raise RuntimeError(f'{path}: regex matched {n}, expected {count}: {pattern[:100]!r}')
    write(path, updated)


# ---------------------------------------------------------------------------
# 1. Current wire is v9 only: remove V7 path/version aliases and migration pin.
# ---------------------------------------------------------------------------
head_types = 'src/lib/sync/sync-v7-head-types.ts'
exact(head_types, '''/** Internal compatibility aliases. New code and architecture checks use v9. */
export const SYNC_V7_FORMAT_VERSION = SYNC_V9_FORMAT_VERSION;
export const SYNC_V7_HEAD_PATH = SYNC_V9_HEAD_PATH;
export const SYNC_V7_CHECKPOINT_PREFIX = SYNC_V9_CHECKPOINT_PREFIX;
export const SYNC_V7_OBJECT_PREFIX = SYNC_V9_OBJECT_PREFIX;
export const SYNC_V7_SEGMENT_PREFIX = SYNC_V9_SEGMENT_PREFIX;
export const SYNC_V7_ASSET_PREFIX = SYNC_V9_ASSET_PREFIX;
/** Naming aliases used by callers that call segments “hot segments”. */
export const SYNC_V7_HOT_SEGMENT_PREFIX = SYNC_V7_SEGMENT_PREFIX;
export const SYNC_V7_EVENT_SEGMENT_PREFIX = SYNC_V7_SEGMENT_PREFIX;

''')
exact(head_types, '''  /** ACTUAL stored/wire bytes (the DEFLATE envelope).  Optional because it is
   *  metadata added after the codec landed — legacy descriptors predate it,
   *  and every new upload fills it so readers can show real transfer sizes
   *  BEFORE downloading.  `size` stays the logical byte count by design
   *  (content addressing). */
  storedSize?: number;
''', '''  /** ACTUAL stored/wire bytes (the DEFLATE envelope). */
  storedSize: number;
''')
exact(head_types, '''  /** Immutable source pin recorded by the one-shot v7→v8 migration. */
  migratedFrom?: {
    path: "sync/v7/head.json" | "sync/v8/head.json";
    blobSha: string;
    generation: number;
  };
''')

validation = 'src/lib/sync/sync-v7-head-validation.ts'
exact(validation, '''  if (value.migratedFrom !== undefined) {
    if (!isRecord(value.migratedFrom)) fail(`${field}.migratedFrom must be an object`);
    if (value.migratedFrom.path !== "sync/v7/head.json" && value.migratedFrom.path !== "sync/v8/head.json") fail(`${field}.migratedFrom.path is invalid`);
    assertSha(value.migratedFrom.blobSha, `${field}.migratedFrom.blobSha`, SHA1);
    assertSafeInteger(value.migratedFrom.generation, `${field}.migratedFrom.generation`, 0);
  }
''')
exact(validation, '  if (value.storedSize !== undefined) assertSize(value.storedSize, `${kind}.storedSize`, SYNC_V7_MAX_DESCRIPTOR_BYTES);\n', '  assertSize(value.storedSize, `${kind}.storedSize`, SYNC_V7_MAX_DESCRIPTOR_BYTES);\n')

wire_aliases = {
    'SYNC_V7_FORMAT_VERSION': 'SYNC_V9_FORMAT_VERSION',
    'SYNC_V7_HEAD_PATH': 'SYNC_V9_HEAD_PATH',
    'SYNC_V7_CHECKPOINT_PREFIX': 'SYNC_V9_CHECKPOINT_PREFIX',
    'SYNC_V7_OBJECT_PREFIX': 'SYNC_V9_OBJECT_PREFIX',
    'SYNC_V7_SEGMENT_PREFIX': 'SYNC_V9_SEGMENT_PREFIX',
    'SYNC_V7_ASSET_PREFIX': 'SYNC_V9_ASSET_PREFIX',
    'SYNC_V7_HOT_SEGMENT_PREFIX': 'SYNC_V9_SEGMENT_PREFIX',
    'SYNC_V7_EVENT_SEGMENT_PREFIX': 'SYNC_V9_SEGMENT_PREFIX',
}
for base in [ROOT / 'src', ROOT / 'scripts']:
    for path in base.rglob('*'):
        if path.suffix not in {'.ts', '.tsx', '.mjs', '.js'} or path.name == 'tmp-latest-only-cleanup.py':
            continue
        text = path.read_text(encoding='utf-8')
        updated = text
        for old, new in wire_aliases.items():
            updated = re.sub(rf'\b{old}\b', new, updated)
        if updated != text:
            path.write_text(updated, encoding='utf-8')

# Architecture now forbids historical namespace pins instead of requiring them.
arch = 'scripts/tools/check-architecture.mjs'
text = read(arch)
text = text.replace('''  || !/SYNC_V7_ASSET_PREFIX\\s*=\\s*SYNC_V9_ASSET_PREFIX/.test(syncV7HeadTypes)''', '')
pattern = re.compile(r'''\nconst legacyMigrationHeadPin = .*?\nfor \(const \{ file, source \} of activeSyncSources\) \{\n  const inspectedSource = .*?\n  if \(/sync\\/v\[78\]\\//\.test\(inspectedSource\)\) \{\n    fail\(`\$\{file\} 不得访问已退役的 v7/v8 远端 namespace；生产同步只允许 v9`\);\n  \}\n\}\n''', re.S)
replacement = '''\nconst activeSyncSources = fs.readdirSync(path.join(root, "src/lib/sync"))
  .filter((file) => typeof file === "string" && file.endsWith(".ts"))
  .map((file) => ({ file, source: read(path.join("src/lib/sync", file)) }));
for (const { file, source } of activeSyncSources) {
  if (/sync\\/v[1-8]\\//.test(source) || /migratedFrom/.test(source)) {
    fail(`${file} 不得保留历史远端 namespace 或迁移来源元数据；生产同步只允许当前 v9`);
  }
}
'''
text, n = pattern.subn(replacement, text, count=1)
if n != 1:
    raise RuntimeError('check-architecture: failed to replace migration-pin policy block')
write(arch, text)

# ---------------------------------------------------------------------------
# 2. Remove legacy local DB cleanup after restore.
# ---------------------------------------------------------------------------
core = 'src/lib/db/db-v7-core.ts'
regex(core, r'''\n/\*\*\n \* Superseded local namespaces, dropped only after the first successful v9.*?export async function dropLegacyLocalDatabases\(\): Promise<void> \{.*?\n\}\n?$''')
exact('src/lib/db/db-v7.ts', '  dropLegacyLocalDatabases,\n')
restore = 'src/lib/sync/sync-v7-restore.ts'
exact(restore, 'import { dbV7, dropLegacyLocalDatabases, listChangeSetsV7 } from "../db/db-v7";\n', 'import { dbV7, listChangeSetsV7 } from "../db/db-v7";\n')
exact(restore, '''    // The v9 projection is fully installed and cached; old pre-upgrade local
    // namespaces are only released after this point.
    await dropLegacyLocalDatabases();
''')

# ---------------------------------------------------------------------------
# 3. Native credentials/config are current-state only; no storage migration.
# ---------------------------------------------------------------------------
cred = 'src/platform/secure-credentials.ts'
regex(cred, r'''\nfunction legacyToken\(\): string \{.*?\nfunction removeLegacyToken\(\): void \{.*?\n\}\n''')
regex(cred, r'''/\*\*\n \* Load Keychain state before the React tree is mounted\..*?export async function bootstrapSecureCredentials\(environment: PlatformEnvironment = getPlatformEnvironment\(\)\): Promise<void> \{.*?\n  hydrated = true;\n\}''', '''/** Load authoritative Keychain state before the React tree is mounted. */
export async function bootstrapSecureCredentials(environment: PlatformEnvironment = getPlatformEnvironment()): Promise<void> {
  nativeEnabled = isSecureCredentialsNative(environment);
  if (!nativeEnabled) {
    hydrated = true;
    tokenCache = "";
    return;
  }
  const result = await plugin.get({ key: SECURE_GITHUB_TOKEN_KEY });
  tokenCache = typeof result.value === "string" ? result.value : "";
  hydrated = true;
}''')
text = read(cred).replace('    removeLegacyToken();\n', '').replace('  if (!nativeEnabled) removeLegacyToken();\n', '')
write(cred, text)

pc = 'src/platform/persistent-config.ts'
exact(pc, 'import { GITHUB_RELAY_URL, GITHUB_WEB_RELAY_PATH } from "./github-transport";\n')
text = read(pc)
text = text.replace('      const value = migrateNativeConfigValue(key, native.value);\n      writeLocal(key, value);\n      if (value !== native.value) await bridge.set({ key, value });\n', '      writeLocal(key, native.value);\n')
text = text.replace('      const value = migrateNativeConfigValue(key, local);\n      await bridge.set({ key, value });\n      mirrors.set(key, value);\n      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);\n', '      await bridge.set({ key, value: local });\n      mirrors.set(key, local);\n')
text, n = re.subn(r'''\nfunction migrateNativeConfigValue\(key: string, value: string\): string \{.*?\n\}\n''', '\n', text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('persistent-config: migration function not found')
write(pc, text)

ghc = 'src/lib/sync/github-credentials.ts'
text = read(ghc)
text = text.replace('''    // Migrate only the former same-origin default. A user-provided relay or
    // diagnostic endpoint must remain untouched on native iOS.
    if (environment.native && saved.apiBaseUrl === GITHUB_WEB_RELAY_PATH) {
      settings.apiBaseUrl = GITHUB_PAGES_RELAY;
    } else if (!saved.apiBaseUrl) {
      settings.apiBaseUrl = resolveDefaultGitHubApiBaseUrl(currentHostname(), environment);
    }
''', '''    if (!saved.apiBaseUrl) settings.apiBaseUrl = resolveDefaultGitHubApiBaseUrl(currentHostname(), environment);
''')
text = text.replace('''  const persistent = localStorage.getItem(tokenKey);
  if (persistent !== null) return persistent;
  const previousSessionToken = sessionStorage.getItem(tokenKey) ?? "";
  if (previousSessionToken) localStorage.setItem(tokenKey, previousSessionToken);
  return previousSessionToken;
''', '  return localStorage.getItem(tokenKey) ?? "";\n')
text = text.replace('  sessionStorage.removeItem(tokenKey);\n', '')
write(ghc, text)

# ---------------------------------------------------------------------------
# 4. Asset Pack is the only image-remote layout; no one-shot single-image migration.
# ---------------------------------------------------------------------------
v7types = 'src/lib/db/v7-types.ts'
regex(v7types, r'''\n/\*\*\n \* A remote image is an immutable blob-addressed object in the sync vault\..*?export interface ImageAssetRemoteDescriptor \{.*?\n\}\n''')
exact(v7types, '  remote?: ImageAssetRemoteDescriptor;\n')

cpval = 'src/lib/sync/sync-v7-checkpoint-validation.ts'
exact(cpval, 'import { IMAGE_EXTENSION_BY_MIME } from "../io/image-assets";\n')
# v9 asset prefix import was only needed by the removed per-image remote validator.
text = read(cpval)
text = re.sub(r'import \{ SYNC_V9_ASSET_PREFIX \} from "\.\/sync-v7-head-types";\n', '', text)
text, n = re.subn(r'''  if \(asset\.remote !== undefined\) \{.*?\n  \}\n  assets\.set''', '  if ("remote" in asset) fail(`state.imageAssets[${index}] must not contain retired remote metadata`);\n  assets.set', text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('checkpoint-validation: old image remote validator not found')
write(cpval, text)

pack = 'src/lib/sync/image-asset-pack.ts'
text = read(pack)
text = re.sub(r'^const LEGACY_SINGLE_ASSET_PATH = .*?\n', '', text, count=1, flags=re.M)
text = text.replace('if (!root) throw new Error("远端尚未完成图片 Pack 一次性迁移，请先执行同步。");', 'if (!root) throw new Error("远端图片 Asset Pack 索引不存在。");')
text, n = re.subn(r'''async function hydrateLegacyAsset\(client: GitHubV7Remote, asset: ImageAsset\): Promise<PackableImageAsset> \{.*?\n\}\n''', '''async function requireLocalPackAsset(asset: ImageAsset): Promise<PackableImageAsset> {
  if (!asset.blob) throw new Error(`图片 ${asset.id} 尚未进入远端 Asset Pack 且本机没有 Blob 缓存。`);
  if (await sha256Blob(asset.blob) !== asset.id) throw new Error(`图片 ${asset.id} 本地缓存校验失败。`);
  return asset as PackableImageAsset;
}
''', text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('image-asset-pack: legacy hydration function not found')
text = text.replace('''  // Group from descriptor sizes first, then hydrate/build/upload one group at a
  // time. This bounds migration memory to roughly one Pack plus the hydration
  // lane instead of retaining every legacy Blob and every built Pack at once.
  for (const group of groupImageAssetsForPacks(pendingBase)) {
    const hydrated = await mapWithConcurrency(group, 6, async (asset) => hydrateLegacyAsset(client, asset));
''', '''  // Group from descriptor sizes first, then validate/build/upload one bounded group at a time.
  for (const group of groupImageAssetsForPacks(pendingBase)) {
    const hydrated = await mapWithConcurrency(group, 6, requireLocalPackAsset);
''')
text, n = re.subn(r'''\n  // The first publication is the one-shot migration boundary\..*?\n  \}\n\n  if \(!await createTreeCommit''', '\n\n  if (!await createTreeCommit', text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('image-asset-pack: legacy tree cleanup block not found')
text = text.replace('''  // Do not retain every freshly uploaded Pack in memory. Local assets already
  // have their Blob cache, while migrated evicted assets can lazily download a
  // Pack later. Keeping all Pack bytes here would recreate the migration peak.
  return pendingBase.map((source) => {
    const { blob: _blob, remote: _migrationSource, ...descriptor } = source;
    void _blob;
    void _migrationSource;
    return { source, descriptor };
  });
''', '''  // Do not retain freshly uploaded Pack bytes in memory; the local Blob cache remains authoritative locally.
  return pendingBase.map((source) => {
    const { blob: _blob, ...descriptor } = source;
    void _blob;
    return { source, descriptor };
  });
''')
write(pack, text)

upload = 'src/lib/sync/sync-v7-upload.ts'
text = read(upload)
text = text.replace('/** Legacy public constant retained as the CPU/download hydration lane count. */', '/** Bounded image-pack preparation concurrency. */')
text = text.replace('function withoutBlobOrLegacyRemote(asset: ImageAsset): Omit<ImageAsset, "blob"> {\n  const { blob: _blob, remote: _legacyRemote, ...descriptor } = asset;\n  void _blob;\n  void _legacyRemote;\n  return descriptor;\n}', 'function withoutBlob(asset: ImageAsset): Omit<ImageAsset, "blob"> {\n  const { blob: _blob, ...descriptor } = asset;\n  void _blob;\n  return descriptor;\n}')
text = text.replace(''' * Sync v9 no longer publishes one Git file/commit per image. Images are packed
 * into bounded immutable blobs and the sharded index + mutable index pointer
 * are committed atomically through the Git Data API. The old per-image remote
 * descriptor is stripped after the one-shot migration; runtime reads only the
 * Asset Pack index from that point onward.
''', ''' * Sync v9 publishes images only as bounded immutable Asset Packs with a sharded index.
''')
text = text.replace('''  // A brand-new device can enter sync before the remote projection has been
  // installed locally. Do not create an empty index in that transient state;
  // the next pass sees the installed image descriptors and performs migration.
''', '''  // A brand-new device can enter sync before the remote projection has been installed locally.
''')
text = text.replace('withoutBlobOrLegacyRemote(asset)', 'withoutBlob(asset)')
text = text.replace('''  // Imports already own image descriptors inside one fixed question.import
  // change-set. Rewrite those descriptors without the retired per-image remote
  // fields; do not create hundreds of image.asset.save events during migration.
''', '''  // Imports already own image descriptors inside one fixed question.import change-set.
''')
text = text.replace('''  // Only genuinely new manual image writes need a dedicated asset event. A
  // legacy image already had an event/checkpoint before this one-shot migration,
  // so repacking it must never manufacture a new event per image.
  for (const { source, descriptor } of published) {
    if (!source.remote && !represented.has(descriptor.id)) {
      await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
    }
  }

  // The Asset Pack index is now authoritative. Strip every old per-image remote
  // descriptor locally while preserving cached Blob bytes.
  await dbV7.imageAssets.bulkPut(assets.map((asset) => {
    const { remote: _legacyRemote, ...clean } = asset;
    void _legacyRemote;
    return clean;
  }));
''', '''  // Only genuinely new manual image writes need a dedicated asset event.
  for (const { descriptor } of published) {
    if (!represented.has(descriptor.id)) await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
  }
''')
write(upload, text)

# ---------------------------------------------------------------------------
# 5. Remove one-shot attempt-stats backfill. Latest DB rows already carry evidence.
# ---------------------------------------------------------------------------
practice_db = 'src/lib/db/db-v7-practice.ts'
regex(practice_db, r'''\n/\*\* 一次性迁移：从原始 attempts 重建全部 attemptStats 行.*?export async function rebuildAttemptStatsFromAttemptsV7\(\) \{.*?\n\}\n''')
# Remove barrel export wherever it appears.
text = read('src/lib/db/db-v7.ts')
text = re.sub(r'^\s*rebuildAttemptStatsFromAttemptsV7,\n', '', text, flags=re.M)
write('src/lib/db/db-v7.ts', text)
app = 'src/app/shell/app-shell.tsx'
exact(app, 'import { rebuildAttemptStatsFromAttemptsV7 } from "@/lib/db/db-v7";\n')
regex(app, r'''\n    // 一次性迁移：为 attemptStats\.recentOutcomes 补作答时间.*?\n    \}\n''')

metrics = 'src/lib/practice/practice-metrics.ts'
text = read(metrics)
text = text.replace('  /** Personal mastery risk shown to the user; kept as `difficulty` for compatibility. */\n', '  /** Personal mastery risk shown to the user. */\n')
text = text.replace('const QUALITY_LEGACY_CORRECT = 0.85;\n', '')
text = text.replace('  if (!validBaselineElapsed(outcome.elapsedMs)) return QUALITY_LEGACY_CORRECT;\n', '  if (!validBaselineElapsed(outcome.elapsedMs)) throw new Error("current difficulty outcomes require elapsedMs");\n')
text = text.replace('''/**
 * 由作答结果序列（按时间升序处理）估计 0–100 难度。序列为空返回 50。
 * 兼容缺 elapsedMs 的旧数据：不计入基准，做对按 0.85 中性质量计。
 */
''', '/** 由作答结果序列（按时间升序处理）估计 0–100 难度。序列为空返回 50。 */\n')
text = text.replace('''  // 新统计（含轮次）按有效时间/间隔感知 EMA 估计；尚未重建的旧聚合行
  // 没有 recentOutcomes 时回退终身错误率，保证旧数据可读且展示不跳变。
  const difficulty = stats.recentOutcomes?.length
    ? difficultyFromOutcomes(stats.recentOutcomes)
    : calculateDifficulty(stats.total, stats.wrong);
''', '''  const difficulty = difficultyFromOutcomes(stats.recentOutcomes);
''')
write(metrics, text)

# Current attempt evidence is complete; missing elapsedMs is no longer a supported stored shape.
text = read(v7types).replace('recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs?: number }>;','recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs: number }>;')
write(v7types, text)

# ---------------------------------------------------------------------------
# 6. Remove deprecated SideStore app-level version fields; AltSource v2 only.
# ---------------------------------------------------------------------------
side = 'scripts/tools/generate-sidestore-source.mjs'
text = read(side)
text = text.replace('''        // Retain the legacy fields for older SideStore builds while also
        // publishing the current AltSource v2 versions array.
        version,
        versionDate: date,
        versionDescription: description,
        downloadURL: SIDESTORE_IPA_URL,
        size,
''', '')
write(side, text)

# ---------------------------------------------------------------------------
# 7. Remove obsolete migration status from the sync UI/result surface.
# ---------------------------------------------------------------------------
for path in [ROOT / 'src/lib/sync/sync-v7-orchestrator.ts', ROOT / 'src/app/sync/sync-view.tsx']:
    text = path.read_text(encoding='utf-8')
    text = text.replace(', migrated: false', '')
    text = text.replace('${result.migrated ? "，云端已升级到最新格式" : ""}', '')
    text = text.replace('请先执行 v8→v9 数据仓库迁移。', '当前客户端只支持 v9 远端数据。')
    path.write_text(text, encoding='utf-8')

# ---------------------------------------------------------------------------
# 8. Delete old-compat tests/assertions; current-format behavior stays tested.
# ---------------------------------------------------------------------------
# Secure credential migration cases are obsolete; replace the test with current Keychain-only behavior.
sec_test = ROOT / 'scripts/tests/test-secure-credentials.ts'
sec_test.write_text('''import assert from "node:assert/strict";
import { bootstrapSecureCredentials, clearSecureCredentials, loadSecureCredential, resetSecureCredentialsForTests, saveSecureCredential, setSecureCredentialsPlugin } from "../../src/platform/secure-credentials";

const keychain = new Map<string, string>();
setSecureCredentialsPlugin({
  async get({ key }) { return { value: keychain.get(key) ?? null }; },
  async set({ key, value }) { keychain.set(key, value); },
  async remove({ key }) { keychain.delete(key); },
});
const native = { platform: "ios" as const, native: true, ios: true };
await bootstrapSecureCredentials(native);
assert.equal(loadSecureCredential(), "");
await saveSecureCredential("current-token");
assert.equal(loadSecureCredential(), "current-token");
assert.equal(keychain.get("github-token"), "current-token");
await clearSecureCredentials();
assert.equal(loadSecureCredential(), "");
assert.equal(keychain.has("github-token"), false);
resetSecureCredentialsForTests();
console.log("secure credentials tests passed: Keychain-only load/save/remove");
''', encoding='utf-8')

# Persistent config no longer rewrites old relay values; assertions now cover authoritative current values.
persist_test = 'scripts/tests/test-persistent-config.ts'
text = read(persist_test)
text = text.replace('GITHUB_WEB_RELAY_PATH', '"/api-github"')
text = re.sub(r'assert\.equal\(JSON\.parse\(localStorage\.getItem\("github-settings"\).*?native legacy default migrates during awaited hydration"\);', 'assert.equal(JSON.parse(localStorage.getItem("github-settings") ?? "{}").apiBaseUrl, "/api-github", "native hydration preserves the authoritative current value");', text, count=1)
text = text.replace('bootstrap hydration/migration', 'bootstrap hydration')
write(persist_test, text)

# Remove explicit old single-image migration scenario from mock backend.
mock = 'scripts/tests/test-sync-mock-backend.ts'
text = read(mock)
text, n = re.subn(r'''\n  // Explicit one-shot legacy migration:.*?\n  console\.log\("mock github backend sync \+ asset-pack migration contract passed"\);''', '\n  console.log("mock github backend sync + current asset-pack contract passed");', text, count=1, flags=re.S)
if n != 1:
    raise RuntimeError('mock backend: legacy image migration scenario not found')
write(mock, text)

# Remove image source-shape assertions that only guarded legacy migration memory behavior.
imgtest = 'scripts/tests/test-image-assets.ts'
text = read(imgtest)
text = re.sub(r'^assert\.match\(imagePackSource, /for .*one-shot migration.*\n', '', text, flags=re.M)
text = re.sub(r'^assert\.doesNotMatch\(imagePackSource, /const pending = .*migration.*\n', '', text, flags=re.M)
write(imgtest, text)

# Remove startup-backfill source assertion.
paf = 'scripts/tests/test-practice-answer-feedback.ts'
text = read(paf)
text = re.sub(r'^assert\.match\(studyApp, /rebuildAttemptStatsFromAttemptsV7.*\n', '', text, flags=re.M)
write(paf, text)

# SideStore tests now require only AltSource v2 versions[] fields.
ios_test = 'scripts/tests/test-ios-release.mjs'
text = read(ios_test)
text = re.sub(r'^assert\.equal\(source\.apps\[0\]\.version,.*\n', '', text, flags=re.M)
text = re.sub(r'^assert\.equal\(source\.apps\[0\]\.downloadURL,.*\n', '', text, flags=re.M)
text += '\nassert.equal("version" in source.apps[0], false, "deprecated app-level version field must stay removed");\nassert.equal("downloadURL" in source.apps[0], false, "deprecated app-level downloadURL field must stay removed");\n'
write(ios_test, text)

# Architecture should explicitly forbid the removed surfaces.
text = read(arch)
anchor = 'if (/migrateLegacy|indexedDB\\.open/.test(dbV7Core)) {\n  fail("本地数据库核心不得保留旧 schema 运行时兼容（旧命名空间只能出现在恢复后的清理删除清单里）");\n}\n'
if anchor not in text:
    raise RuntimeError('architecture DB anchor missing')
text = text.replace(anchor, 'if (/migrateLegacy|indexedDB\\.open|dropLegacyLocalDatabases|shijuan-study-v[67]/.test(dbV7Core)) {\n  fail("本地数据库核心不得保留旧 schema、旧命名空间或迁移清理代码");\n}\n')
text += '''\nconst latestOnlySources = appSources.map(({ source }) => source).join("\\n") + "\\n" + activeSyncSources.map(({ source }) => source).join("\\n");
if (/rebuildAttemptStatsFromAttemptsV7|study-v7-stats-outcomes-v2/.test(latestOnlySources)) fail("客户端不得恢复一次性 attemptStats 历史回填");
if (/ImageAssetRemoteDescriptor|LEGACY_SINGLE_ASSET_PATH|hydrateLegacyAsset|migratedFrom/.test(latestOnlySources)) fail("客户端不得恢复旧图片布局或历史迁移来源兼容");
'''
write(arch, text)

# Remove the temporary deep-audit workflow from the resulting product tree in the verifier.

# Final static sanity: no explicitly retired runtime markers in production source.
production = '\n'.join(p.read_text(encoding='utf-8') for p in (ROOT / 'src').rglob('*') if p.suffix in {'.ts', '.tsx'})
for marker in ['dropLegacyLocalDatabases', 'rebuildAttemptStatsFromAttemptsV7', 'migratedFrom', 'ImageAssetRemoteDescriptor', 'LEGACY_SINGLE_ASSET_PATH', 'hydrateLegacyAsset']:
    if marker in production:
        raise RuntimeError(f'retired production marker remains: {marker}')
