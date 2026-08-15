// 项目级守卫：原生 HTML 元素（小写标签）上禁止出现 title 属性。
// 全项目统一悬浮提示请用 app/hint.tsx 的 Hint 组件（Radix Tooltip，
// 桌面 hover/键盘焦点、触控点按、点外部/Esc 关闭）。
// 组件 prop 的 title=（大写或点分标签，如 PanelTitle / ConfirmDialog / PreferenceSelect
// 的标题文本）属于组件自己的契约，放行。
// 用法：node scripts/tools/check-no-native-tooltip-titles.mjs
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const scanDirs = ["app", "src"];
const failures = [];

function collectTsx(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true })) {
    const rel = typeof entry === "string" ? entry : "";
    if (rel.endsWith(".tsx")) out.push(path.join(dir, rel));
  }
  return out;
}

function isNativeTag(tag) {
  return ts.isIdentifier(tag) && /^[a-z][a-z0-9-]*$/.test(tag.text);
}

function walk(node, sourceFile) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    if (isNativeTag(node.tagName)) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === "title") {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(attr.getStart(sourceFile));
          failures.push({ file: sourceFile.fileName, line: line + 1, column: character + 1, tag: node.tagName.text });
        }
      }
    }
  }
  ts.forEachChild(node, (child) => walk(child, sourceFile));
}

for (const file of collectTsx(scanDirs[0]).concat(scanDirs.slice(1).flatMap((dir) => collectTsx(dir)))) {
  const sourceText = fs.readFileSync(path.join(root, file), "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  walk(sourceFile, sourceFile);
}

if (failures.length) {
  console.error("原生 title 悬浮提示已禁用：请统一改用 app/hint.tsx 的 Hint 组件（桌面 hover / 触控点按）。");
  for (const { file, line, column, tag } of failures) {
    console.error(`  ${file}:${line}:${column}  <${tag} title="...">`);
  }
  process.exit(1);
}

console.log("no-native-tooltip-titles: OK，app/src 未发现原生元素 title 属性。");
