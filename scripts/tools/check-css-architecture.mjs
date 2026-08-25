import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appRoot = path.join(root, "src/app");
const stylesRoot = path.join(appRoot, "styles");
const baselinePath = path.join(root, "scripts/tools/css-architecture-baseline.json");
const fail = (message) => { throw new Error(`CSS 架构检查失败：${message}`); };

const globalStyleOrder = [
  "./theme-tokens.css",
  "./palette-tokens.css",
  "../bank/bank-tokens.css",
  "../shell/shell-tokens.css",
  "../search/search-tokens.css",
  "../practice/practice-tokens.css",
  "./controls.css",
  "./base.css",
  "./primitives.css",
  "./shared.css",
  "../bank/bank-shared.css",
  "./app-utility.css",
  "./shell.css",
  "./dashboard.css",
  "../search/search.css",
  "./bank.css",
  "../bank/bank-knowledge.css",
  "./practice.css",
  "./preferences.css",
  "./responsive.css",
  "./responsive-shared.css",
  "./dark-overrides.css",
  "./practice-setup.css",
  "./content-blocks.css",
  "./review-scope.css",
  "./hint.css",
  "./question-actions.css",
  "./bank-controls.css",
  "./asset-image.css",
];
const featureLocalStyles = new Set(["src/app/styles/sync-events.css"]);
const requiredCoreStyles = [
  "src/app/styles/theme-tokens.css",
  "src/app/styles/base.css",
  "src/app/styles/primitives.css",
  "src/app/styles/controls.css",
  "src/app/styles/components.css",
];
const migrationDebtFiles = new Set([
  "src/app/styles/shared.css",
  "src/app/styles/responsive.css",
  "src/app/styles/dark-overrides.css",
]);
const tokenFileRelatives = new Set([
  "src/app/styles/theme-tokens.css",
  "src/app/styles/palette-tokens.css",
  "src/app/bank/bank-tokens.css",
  "src/app/shell/shell-tokens.css",
  "src/app/search/search-tokens.css",
  "src/app/practice/practice-tokens.css",
]);
const structuralStyleFiles = new Set([
  "src/app/globals.css",
  "src/app/styles/components.css",
]);
const newCssMaxBytes = 16 * 1024;
const tokenFileMaxBytes = 16 * 1024;
const debtWeights = { hexColors: 32, darkSelectors: 64, important: 32 };

function toRelative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  });
}
function metrics(source) {
  return {
    bytes: Buffer.byteLength(source),
    hexColors: source.match(/#[0-9a-fA-F]{3,8}\b/g)?.length ?? 0,
    darkSelectors: source.match(/html\[data-theme=["']dark["']\]/g)?.length ?? 0,
    important: source.match(/!important\b/g)?.length ?? 0,
  };
}
function debtScore(value) {
  return value.bytes
    + value.hexColors * debtWeights.hexColors
    + value.darkSelectors * debtWeights.darkSelectors
    + value.important * debtWeights.important;
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}
function parseRelativeImports(source) {
  return [...source.matchAll(/^\s*@import\s+"((?:\.\.?\/)[^"]+\.css)";\s*$/gm)].map((match) => match[1]);
}
function resolveGlobalImport(specifier) {
  const resolved = path.resolve(stylesRoot, specifier);
  const appPrefix = `${path.resolve(appRoot)}${path.sep}`;
  if (!resolved.startsWith(appPrefix)) fail(`components.css @import 越出 src/app：${specifier}`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) fail(`components.css 引用了不存在的样式文件 ${specifier}`);
  return toRelative(resolved);
}

if (fs.existsSync(path.join(stylesRoot, "legacy-components.css"))) fail("legacy-components.css 必须保持删除，禁止恢复单体样式文件");
for (const relative of requiredCoreStyles) {
  if (!fs.existsSync(path.join(root, relative))) fail(`缺少核心样式文件 ${relative}`);
}

const globalsPath = path.join(appRoot, "globals.css");
const globalsSource = fs.readFileSync(globalsPath, "utf8");
const globalsBody = stripComments(globalsSource).trim();
if (globalsBody !== '@import "./styles/components.css";') {
  fail("globals.css 只能导入 ./styles/components.css，不得承载声明或额外级联入口");
}

const entryPath = path.join(stylesRoot, "components.css");
const entrySource = fs.readFileSync(entryPath, "utf8");
if (Buffer.byteLength(entrySource) > 2048 || /[{}]/.test(entrySource)) {
  fail("components.css 只能维护 @import 顺序，不得承载声明");
}
const entryBody = stripComments(entrySource);
const entryImports = parseRelativeImports(entryBody);
const remainingEntryBody = entryBody.replace(/^\s*@import\s+"(?:\.\.?\/)[^"]+\.css";\s*$/gm, "").trim();
if (remainingEntryBody) fail("components.css 只能包含相对 CSS @import");
if (new Set(entryImports).size !== entryImports.length) fail("components.css 存在重复 @import");
if (entryImports.length !== globalStyleOrder.length || entryImports.some((file, index) => file !== globalStyleOrder[index])) {
  fail(`components.css 全局级联顺序必须为：${globalStyleOrder.join(" -> ")}`);
}
const globalStyleRelatives = new Set(entryImports.map(resolveGlobalImport));
for (const tokenFile of tokenFileRelatives) {
  if (!globalStyleRelatives.has(tokenFile)) fail(`token 文件必须登记到 components.css 全局级联：${tokenFile}`);
}

const styleFiles = fs.readdirSync(stylesRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".css") && entry.name !== "components.css")
  .map((entry) => toRelative(path.join(stylesRoot, entry.name)));
for (const relative of styleFiles) {
  if (!globalStyleRelatives.has(relative) && !featureLocalStyles.has(relative)) {
    fail(`样式文件 ${relative} 没有声明为全局级联或 feature-local 样式`);
  }
}

const files = walk(appRoot).sort();
const sources = files.map((file) => ({ file, source: fs.readFileSync(file, "utf8") }));
const globalEscapes = sources.reduce((sum, item) => sum + (item.source.match(/:global\(/g)?.length ?? 0), 0);
const legacyTokenUses = sources.reduce((sum, item) => sum + (item.source.match(/var\(--(?:paper|ink|muted|line|green|green-soft|orange|white)\)/g)?.length ?? 0), 0);
if (globalEscapes !== 0) fail(`CSS Module :global() 必须为 0，当前为 ${globalEscapes}`);
if (legacyTokenUses !== 0) fail(`旧主题别名必须为 0，当前仍有 ${legacyTokenUses} 处`);

for (const tokenFile of tokenFileRelatives) {
  const tokenItem = sources.find(({ file }) => toRelative(file) === tokenFile);
  if (!tokenItem) fail(`缺少 token 文件 ${tokenFile}`);
  const tokenMetrics = metrics(tokenItem.source);
  if (tokenMetrics.bytes > tokenFileMaxBytes) fail(`${tokenFile} 超过 ${tokenFileMaxBytes} bytes 上限`);
  if (tokenMetrics.important) fail(`${tokenFile} 不得包含 !important`);
  for (const line of stripComments(tokenItem.source).split("\n")) {
    if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !/^\s*--[\w-]+\s*:/.test(line)) {
      fail(`${tokenFile} 中硬编码颜色只能出现在自定义属性定义内`);
    }
  }
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const current = {};
let totalBytes = 0;
let maxFileBytes = 0;
let nonTokenBytes = 0;
let nonTokenHexColors = 0;
let nonTokenDarkSelectors = 0;
let nonTokenImportant = 0;
for (const { file, source } of sources) {
  const relative = toRelative(file);
  const value = metrics(source);
  const isTokenFile = tokenFileRelatives.has(relative);
  const isDebtExempt = isTokenFile || structuralStyleFiles.has(relative);
  current[relative] = value;
  totalBytes += value.bytes;
  maxFileBytes = Math.max(maxFileBytes, value.bytes);
  if (!isDebtExempt) {
    nonTokenBytes += value.bytes;
    nonTokenHexColors += value.hexColors;
    nonTokenDarkSelectors += value.darkSelectors;
    nonTokenImportant += value.important;
  }

  const allowed = baseline.files[relative];
  if (!allowed) {
    if (value.bytes > (isTokenFile ? tokenFileMaxBytes : newCssMaxBytes)) {
      fail(`新 CSS ${relative} 为 ${value.bytes} bytes，单文件上限为 ${isTokenFile ? tokenFileMaxBytes : newCssMaxBytes} bytes`);
    }
    if (!isTokenFile && (value.hexColors || value.darkSelectors || value.important)) {
      fail(`新 CSS ${relative} 不得新增硬编码颜色、页面级 dark patch 或 !important`);
    }
    continue;
  }

  const ratchetKeys = isTokenFile
    ? ["darkSelectors", "important"]
    : ["hexColors", "darkSelectors", "important"];
  for (const key of ratchetKeys) {
    if (value[key] > allowed[key]) fail(`${relative} 的 ${key} 由 ${allowed[key]} 增至 ${value[key]}，历史样式债务只能减少`);
  }
  if (migrationDebtFiles.has(relative) && debtScore(value) > debtScore(allowed)) {
    fail(`${relative} 的迁移债务分数由 ${debtScore(allowed)} 增至 ${debtScore(value)}；体积增长必须由硬编码颜色/dark patch/!important 的减少抵消`);
  }
}

const totalDebtScore = nonTokenBytes
  + nonTokenHexColors * debtWeights.hexColors
  + nonTokenDarkSelectors * debtWeights.darkSelectors
  + nonTokenImportant * debtWeights.important;
const baselineNonTokenMetrics = Object.entries(baseline.files)
  .filter(([relative]) => !tokenFileRelatives.has(relative) && !structuralStyleFiles.has(relative))
  .reduce((sum, [, value]) => ({
    bytes: sum.bytes + value.bytes,
    hexColors: sum.hexColors + value.hexColors,
    darkSelectors: sum.darkSelectors + value.darkSelectors,
    important: sum.important + value.important,
  }), { bytes: 0, hexColors: 0, darkSelectors: 0, important: 0 });
const allowedTotalDebtScore = baseline.totalDebtScore ?? debtScore(baselineNonTokenMetrics);
const allowedNonTokenHexColors = baseline.nonTokenHexColors ?? baselineNonTokenMetrics.hexColors;
if (nonTokenHexColors > allowedNonTokenHexColors) {
  fail(`token 文件之外的硬编码颜色由 ${allowedNonTokenHexColors} 增至 ${nonTokenHexColors}，业务 CSS 颜色债务只能减少`);
}
if (totalDebtScore > allowedTotalDebtScore) {
  fail(`CSS 迁移债务分数由 ${allowedTotalDebtScore} 增至 ${totalDebtScore}；语义 token 带来的文本增长必须由历史样式债务下降抵消`);
}
if (maxFileBytes > baseline.maxFileBytes) fail(`最大 CSS 文件由 ${baseline.maxFileBytes} 增至 ${maxFileBytes} bytes；禁止重建新单体文件`);

let tightened = false;
for (const relative of Object.keys(baseline.files)) {
  if (!current[relative]) { delete baseline.files[relative]; tightened = true; continue; }
  const currentValue = current[relative];
  const baselineValue = baseline.files[relative];
  const isTokenFile = tokenFileRelatives.has(relative);

  if (isTokenFile && currentValue.hexColors !== baselineValue.hexColors) {
    baselineValue.hexColors = currentValue.hexColors;
    tightened = true;
  }
  for (const key of ["darkSelectors", "important"]) {
    if (currentValue[key] < baselineValue[key]) { baselineValue[key] = currentValue[key]; tightened = true; }
  }
  if (!isTokenFile && currentValue.hexColors < baselineValue.hexColors) {
    baselineValue.hexColors = currentValue.hexColors;
    tightened = true;
  }
  if (baselineValue.bytes !== currentValue.bytes) {
    baselineValue.bytes = currentValue.bytes;
    tightened = true;
  }
}
for (const [relative, value] of Object.entries(current)) {
  if (!baseline.files[relative]) { baseline.files[relative] = value; tightened = true; }
}
if (baseline.totalBytes !== totalBytes) { baseline.totalBytes = totalBytes; tightened = true; }
if (baseline.nonTokenHexColors === undefined || nonTokenHexColors < baseline.nonTokenHexColors) {
  baseline.nonTokenHexColors = nonTokenHexColors;
  tightened = true;
}
if (baseline.totalDebtScore === undefined || totalDebtScore < baseline.totalDebtScore) {
  baseline.totalDebtScore = totalDebtScore;
  tightened = true;
}
if (maxFileBytes < baseline.maxFileBytes) { baseline.maxFileBytes = maxFileBytes; tightened = true; }
if (tightened) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log("CSS 预算棘轮已自动收紧；请提交 css-architecture-baseline.json");
}
console.log(`CSS 架构检查通过：${files.length} files，${totalBytes} bytes，token files=${tokenFileRelatives.size}，非 token hex=${nonTokenHexColors}，迁移债务=${totalDebtScore}，最大单文件 ${maxFileBytes} bytes，:global=0，legacy aliases=0。`);
