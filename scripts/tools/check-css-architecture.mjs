import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const componentsPath = path.join(root, "src/app/styles/components.css");
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

const componentsBytes = fs.statSync(componentsPath).size;
const cssModuleGlobalEscapes = walk(appRoot).reduce((count, file) => {
  const source = fs.readFileSync(file, "utf8");
  return count + (source.match(/:global\(/g)?.length ?? 0);
}, 0);

if (componentsBytes > legacyComponentsBytes) {
  fail(`components.css 由 ${legacyComponentsBytes} bytes 增至 ${componentsBytes} bytes；历史大文件只能缩小`);
}
if (cssModuleGlobalEscapes > cssModuleGlobalEscapeBudget) {
  fail(`CSS Module :global() 逃逸由 ${cssModuleGlobalEscapeBudget} 增至 ${cssModuleGlobalEscapes}；新组件必须使用真正的局部类名`);
}

if (componentsBytes < legacyComponentsBytes || cssModuleGlobalEscapes < cssModuleGlobalEscapeBudget) {
  const selfPath = fileURLToPath(import.meta.url);
  let self = fs.readFileSync(selfPath, "utf8");
  self = self
    .replace(/legacyComponentsBytes = \d+;/, `legacyComponentsBytes = ${componentsBytes};`)
    .replace(/cssModuleGlobalEscapeBudget = \d+;/, `cssModuleGlobalEscapeBudget = ${cssModuleGlobalEscapes};`);
  fs.writeFileSync(selfPath, self);
  console.log(`CSS 预算棘轮已收紧：components.css=${componentsBytes} bytes，:global()=${cssModuleGlobalEscapes}（请提交写回结果）`);
}

console.log(`CSS 架构检查通过：components.css ${componentsBytes}/${legacyComponentsBytes} bytes；CSS Module :global() ${cssModuleGlobalEscapes}/${cssModuleGlobalEscapeBudget}。`);
