import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appRoot = path.join(root, "src/app");
const stylesRoot = path.join(appRoot, "styles");
const baselinePath = path.join(root, "scripts/tools/css-architecture-baseline.json");
const fail = (message) => { throw new Error(`CSS 架构检查失败：${message}`); };

const globalStyleOrder = [
  "theme-tokens.css",
  "controls.css",
  "base.css",
  "primitives.css",
  "shared.css",
  "shell.css",
  "dashboard.css",
  "search.css",
  "bank.css",
  "practice.css",
  "preferences.css",
  "responsive.css",
  "dark-overrides.css",
  "practice-setup.css",
  "content-blocks.css",
  "review-scope.css",
  "hint.css",
  "question-actions.css",
  "bank-controls.css",
  "asset-image.css",
];
const featureLocalStyles = new Set(["sync-events.css"]);
const requiredCoreStyles = ["theme-tokens.css", "base.css", "primitives.css", "controls.css", "components.css"];
const shrinkingDebtFiles = new Set([
  "src/app/styles/shared.css",
  "src/app/styles/responsive.css",
  "src/app/styles/dark-overrides.css",
]);
const newCssMaxBytes = 16 * 1024;

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
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}
function parseRelativeImports(source) {
  return [...source.matchAll(/^\s*@import\s+"\.\/([^"]+\.css)";\s*$/gm)].map((match) => match[1]);
}

if (fs.existsSync(path.join(stylesRoot, "legacy-components.css"))) fail("legacy-components.css 必须保持删除，禁止恢复单体样式文件");
for (const file of requiredCoreStyles) if (!fs.existsSync(path.join(stylesRoot, file))) fail(`缺少核心样式文件 ${file}`);

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
const remainingEntryBody = entryBody.replace(/^\s*@import\s+"\.\/[^"]+\.css";\s*$/gm, "").trim();
if (remainingEntryBody) fail("components.css 只能包含相对 CSS @import");
if (new Set(entryImports).size !== entryImports.length) fail("components.css 存在重复 @import");
if (entryImports.length !== globalStyleOrder.length || entryImports.some((file, index) => file !== globalStyleOrder[index])) {
  fail(`components.css 全局级联顺序必须为：${globalStyleOrder.join(" -> ")}`);
}

const styleFiles = fs.readdirSync(stylesRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".css") && entry.name !== "components.css")
  .map((entry) => entry.name);
for (const file of globalStyleOrder) if (!styleFiles.includes(file)) fail(`components.css 引用了不存在的样式文件 ${file}`);
for (const file of styleFiles) {
  if (!globalStyleOrder.includes(file) && !featureLocalStyles.has(file)) {
    fail(`样式文件 ${file} 没有声明为全局级联或 feature-local 样式`);
  }
}

const files = walk(appRoot).sort();
const sources = files.map((file) => ({ file, source: fs.readFileSync(file, "utf8") }));
const globalEscapes = sources.reduce((sum, item) => sum + (item.source.match(/:global\(/g)?.length ?? 0), 0);
const legacyTokenUses = sources.reduce((sum, item) => sum + (item.source.match(/var\(--(?:paper|ink|muted|line|green|green-soft|orange|white)\)/g)?.length ?? 0), 0);
if (globalEscapes !== 0) fail(`CSS Module :global() 必须为 0，当前为 ${globalEscapes}`);
if (legacyTokenUses !== 0) fail(`旧主题别名必须为 0，当前仍有 ${legacyTokenUses} 处`);

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const current = {};
let totalBytes = 0;
let maxFileBytes = 0;
for (const { file, source } of sources) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  const value = metrics(source);
  current[relative] = value;
  totalBytes += value.bytes;
  maxFileBytes = Math.max(maxFileBytes, value.bytes);
  const allowed = baseline.files[relative];
  if (!allowed) {
    if (value.bytes > newCssMaxBytes) fail(`新 CSS ${relative} 为 ${value.bytes} bytes，单文件上限为 ${newCssMaxBytes} bytes`);
    if (value.hexColors || value.darkSelectors || value.important) fail(`新 CSS ${relative} 不得新增硬编码颜色、页面级 dark patch 或 !important`);
    continue;
  }
  for (const key of ["hexColors", "darkSelectors", "important"]) {
    if (value[key] > allowed[key]) fail(`${relative} 的 ${key} 由 ${allowed[key]} 增至 ${value[key]}，历史样式债务只能减少`);
  }
  if (shrinkingDebtFiles.has(relative) && value.bytes > allowed.bytes) {
    fail(`${relative} 是待拆聚合样式，体积只能缩小：${allowed.bytes} -> ${value.bytes} bytes`);
  }
}
if (totalBytes > baseline.totalBytes) fail(`CSS 总体积由 ${baseline.totalBytes} 增至 ${totalBytes} bytes；必须先抵消或明确调整基线`);
if (maxFileBytes > baseline.maxFileBytes) fail(`最大 CSS 文件由 ${baseline.maxFileBytes} 增至 ${maxFileBytes} bytes；禁止重建新单体文件`);

let tightened = false;
for (const relative of Object.keys(baseline.files)) {
  if (!current[relative]) { delete baseline.files[relative]; tightened = true; continue; }
  for (const key of ["hexColors", "darkSelectors", "important"]) {
    if (current[relative][key] < baseline.files[relative][key]) { baseline.files[relative][key] = current[relative][key]; tightened = true; }
  }
  baseline.files[relative].bytes = current[relative].bytes;
}
for (const [relative, value] of Object.entries(current)) {
  if (!baseline.files[relative]) { baseline.files[relative] = value; tightened = true; }
}
if (totalBytes < baseline.totalBytes) { baseline.totalBytes = totalBytes; tightened = true; }
if (maxFileBytes < baseline.maxFileBytes) { baseline.maxFileBytes = maxFileBytes; tightened = true; }
if (tightened) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log("CSS 预算棘轮已自动收紧；请提交 css-architecture-baseline.json");
}
console.log(`CSS 架构检查通过：${files.length} files，${totalBytes} bytes，最大单文件 ${maxFileBytes} bytes，:global=0，legacy aliases=0。`);
