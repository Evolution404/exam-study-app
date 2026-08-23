import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const legacyPath = path.join(root, "src/app/styles/legacy-components.css");
const entryPath = path.join(root, "src/app/styles/components.css");
const appRoot = path.join(root, "src/app");
const fail = (message) => { throw new Error(`CSS 架构检查失败：${message}`); };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith(".module.css") ? [full] : [];
  });
}

let legacyComponentsBytes = 190542;
let cssModuleGlobalEscapeBudget = 7;

const legacyBytes = fs.statSync(legacyPath).size;
const entrySource = fs.readFileSync(entryPath, "utf8");
const entryBytes = Buffer.byteLength(entrySource);
const cssModuleGlobalEscapes = walk(appRoot).reduce((count, file) => {
  const source = fs.readFileSync(file, "utf8");
  return count + (source.match(/:global\(/g)?.length ?? 0);
}, 0);

if (legacyBytes > legacyComponentsBytes) {
  fail(`legacy-components.css 由 ${legacyComponentsBytes} bytes 增至 ${legacyBytes} bytes；历史大文件只能缩小`);
}
if (entryBytes > 1024 || /[{}]/.test(entrySource)) {
  fail("components.css 只能作为小型 @import 组合入口，不得重新承载组件声明");
}
if (!/@import\s+["']\.\/legacy-components\.css["']/.test(entrySource) || !/@import\s+["']\.\/shell\.css["']/.test(entrySource)) {
  fail("components.css 必须显式组合 legacy-components.css 与已迁移的 shell.css");
}
if (cssModuleGlobalEscapes > cssModuleGlobalEscapeBudget) {
  fail(`CSS Module :global() 逃逸由 ${cssModuleGlobalEscapeBudget} 增至 ${cssModuleGlobalEscapes}；新组件必须使用真正的局部类名`);
}

if (legacyBytes < legacyComponentsBytes || cssModuleGlobalEscapes < cssModuleGlobalEscapeBudget) {
  const selfPath = fileURLToPath(import.meta.url);
  let self = fs.readFileSync(selfPath, "utf8");
  self = self
    .replace(/legacyComponentsBytes = \d+;/, `legacyComponentsBytes = ${legacyBytes};`)
    .replace(/cssModuleGlobalEscapeBudget = \d+;/, `cssModuleGlobalEscapeBudget = ${cssModuleGlobalEscapes};`);
  fs.writeFileSync(selfPath, self);
  console.log(`CSS 预算棘轮已收紧：legacy-components.css=${legacyBytes} bytes，:global()=${cssModuleGlobalEscapes}（请提交写回结果）`);
}

console.log(`CSS 架构检查通过：legacy-components.css ${legacyBytes}/${legacyComponentsBytes} bytes；entry=${entryBytes} bytes；CSS Module :global() ${cssModuleGlobalEscapes}/${cssModuleGlobalEscapeBudget}。`);
