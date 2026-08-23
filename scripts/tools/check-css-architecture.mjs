import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appRoot = path.join(root, "src/app");
const stylesRoot = path.join(appRoot, "styles");
const baselinePath = path.join(root, "scripts/tools/css-architecture-baseline.json");
const fail = (message) => { throw new Error(`CSS 架构检查失败：${message}`); };
const requiredStyles = ["base.css", "primitives.css", "shared.css", "shell.css", "dashboard.css", "search.css", "bank.css", "practice.css", "preferences.css", "responsive.css", "dark-overrides.css"];

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

if (fs.existsSync(path.join(stylesRoot, "legacy-components.css"))) fail("legacy-components.css 必须保持删除，禁止恢复单体样式文件");
for (const file of requiredStyles) if (!fs.existsSync(path.join(stylesRoot, file))) fail(`缺少已拆分样式文件 ${file}`);
const entryPath = path.join(stylesRoot, "components.css");
const entrySource = fs.readFileSync(entryPath, "utf8");
if (Buffer.byteLength(entrySource) > 2048 || /[{}]/.test(entrySource)) fail("components.css 只能维护 @import 顺序，不得承载声明");
for (const file of requiredStyles) if (!entrySource.includes(`@import "./${file}";`)) fail(`components.css 必须导入 ${file}`);

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
    if (value.hexColors || value.darkSelectors || value.important) fail(`新 CSS ${relative} 不得新增硬编码颜色、页面级 dark patch 或 !important`);
    continue;
  }
  for (const key of ["hexColors", "darkSelectors", "important"]) {
    if (value[key] > allowed[key]) fail(`${relative} 的 ${key} 由 ${allowed[key]} 增至 ${value[key]}，历史样式债务只能减少`);
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
